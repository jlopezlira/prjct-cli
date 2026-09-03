/**
 * `prjct judgment` — precision-gated dual-blind review ledger (v2 steroids).
 *
 *   plan | open | add | merge | challenge | fix-round | fixed | verify
 *   brief | next | ghosts | approve | escalate | status | clear
 *
 * Machine-readable agent loop: always follow `prjct judgment next`.
 */

import configManager from '../infrastructure/config-manager'
import type { FindingSeverity, JudgmentLedger, RefuteVerdict } from '../schemas/judgment'
import { FindingSeveritySchema, RefuteVerdictSchema } from '../schemas/judgment'
import { computeCommittedChangeset, type DeliveryTier } from '../services/delivery-geometry'
import { reviewDispatchGuidance } from '../services/judgment-orchestrator'
import {
  advanceFixRound,
  applyBatchRefutation,
  applyEvidenceTax,
  applyGhostFilter,
  applyMechanicalStyleRefute,
  applyScopeFreeze,
  applySeverityFloor,
  buildNextAction,
  buildReReviewBrief,
  canStartFixRound,
  createLedger,
  finalizeLedger,
  type IntensitySignals,
  intensityFromChangeset,
  intensityProtocol,
  markFindings,
  markFindingsSkippedByScope,
  markLeftoversOpen,
  mergeDualJudges,
  newFindingId,
  rankFindingsForFix,
  recordRefutedAsGhosts,
  upsertFinding,
} from '../services/precision-judgment'
import { formatReviewBudget } from '../services/review-budget'
import { judgmentLedgerStorage } from '../storage/judgment-ledger-storage'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { getTimestamp } from '../utils/date-helper'
import { failHard, failWith } from '../utils/md-aware'
import { mdOutput } from '../utils/md-formatter'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'
import { requireProject } from './guards'

const USAGE =
  'plan | open | add | merge | challenge | fix-round | fixed | verify | brief | next | ghosts | approve | escalate | status | clear'

export class JudgmentCommands extends PrjctCommandsBase {
  async judgment(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const parts = tokenize(input ?? '')
      const sub = (parts[0] ?? 'status').toLowerCase()

      if (sub === 'status' || sub === 'show') return this.status(projectPath, options)
      if (sub === 'plan') return this.plan(projectPath, options)
      if (sub === 'open') return this.open(parts.slice(1).join(' '), projectPath, options)
      if (sub === 'add') return this.add(parts.slice(1), projectPath, options)
      if (sub === 'merge') return this.merge(parts.slice(1), projectPath, options)
      if (sub === 'challenge' || sub === 'refute')
        return this.challenge(parts.slice(1), projectPath, options)
      if (sub === 'fix-round' || sub === 'round') return this.fixRound(projectPath, options)
      if (sub === 'fixed') return this.mark(parts.slice(1), 'fixed', projectPath, options)
      if (sub === 'verify' || sub === 'verified')
        return this.mark(parts.slice(1), 'verified', projectPath, options)
      if (sub === 'brief') return this.brief(projectPath, options)
      if (sub === 'next') return this.next(projectPath, options)
      if (sub === 'ghosts' || sub === 'ghost') return this.ghosts(projectPath, options)
      if (sub === 'approve') return this.approve(projectPath, options)
      if (sub === 'escalate') return this.escalate(parts.slice(1).join(' '), projectPath, options)
      if (sub === 'clear' || sub === 'reset') return this.clear(projectPath, options)

      return failWith(`Unknown judgment subcommand "${sub}". Use: ${USAGE}`, options)
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  private async status(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath)
    if (!proj.ok) return proj.result
    const ledger = judgmentLedgerStorage.get(proj.value)
    if (!ledger) {
      const msg = 'No active judgment ledger. → `prjct judgment plan` then `open`, or `next`.'
      print(options, '## Judgment', msg)
      return { success: true, ledger: null }
    }
    const next = buildNextAction(ledger, ledger.intensity)
    const lines = [
      ...formatLedger(ledger),
      '',
      `### Next → \`${next.kind}\``,
      next.directive,
      formatReviewBudget(next.budget),
      ...next.steps.map((s) => `- ${s}`),
    ]
    print(options, '## Judgment ledger', lines.join('\n'))
    return { success: true, ledger, verdict: ledger.verdict, next }
  }

  private async plan(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath)
    if (!proj.ok) return proj.result

    const cs = await computeCommittedChangeset(projectPath)
    const signals = await loadSignals(projectPath)
    const files = cs?.files ?? 0
    const loc = cs?.loc ?? 0
    const { tier, intensity } = intensityFromChangeset(
      { files, loc },
      { ...signals, paths: await changesetPaths(projectPath, cs?.dirs) }
    )
    const protocol = intensityProtocol(intensity)
    const next = buildNextAction(judgmentLedgerStorage.get(proj.value), intensity)
    const lines = [
      `Tier: ${tier} (${files} files, ${loc} LOC${cs ? ` vs ${cs.base}` : ''})`,
      `Intensity: **${intensity}**`,
      `Reviewers: ${protocol.reviewers}`,
      `Refuters: ${protocol.refuters}`,
      `Severity floor: ${protocol.severityFloor}`,
      `Evidence tax: ${protocol.evidenceTax}`,
      `Max fix rounds: ${protocol.maxFixRounds}`,
      `Ship: ${protocol.shipExpectation}`,
      '',
      protocol.redCharter ? `RED: ${protocol.redCharter}` : '',
      protocol.blueCharter ? `BLUE: ${protocol.blueCharter}` : '',
      '',
      `### Next → \`${next.kind}\``,
      next.directive,
      formatReviewBudget(next.budget),
      ...next.steps.map((s) => `- ${s}`),
    ].filter(Boolean)
    print(options, '## Judgment plan', lines.join('\n'))
    return { success: true, tier, intensity, protocol, files, loc, next }
  }

  private async open(
    targetRaw: string,
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath)
    if (!proj.ok) return proj.result

    const existing = judgmentLedgerStorage.get(proj.value)
    if (existing && existing.verdict === 'in_progress') {
      return failWith(
        `Active ledger ${existing.id.slice(0, 8)} still in_progress. Finish or \`prjct judgment clear\` first.`,
        options
      )
    }

    const cs = await computeCommittedChangeset(projectPath)
    const signals = await loadSignals(projectPath)
    const { tier, intensity } = intensityFromChangeset(
      { files: cs?.files ?? 0, loc: cs?.loc ?? 0 },
      { ...signals, paths: await changesetPaths(projectPath, cs?.dirs) }
    )

    const target =
      targetRaw.trim() || (await defaultTarget(projectPath)) || `changeset-${cs?.base ?? 'local'}`

    // Immutable review scope from git (gentle-ai v1.49) — not caller-authored paths.
    const scopePaths = await changesetPaths(projectPath, cs?.dirs)

    const ledger = createLedger({
      target,
      intensity,
      deliveryTier: tier as DeliveryTier,
      baseSha: cs?.base,
      now: getTimestamp(),
      scopePaths,
    })
    judgmentLedgerStorage.set(proj.value, ledger)

    const protocol = intensityProtocol(intensity)
    const next = buildNextAction(ledger, intensity)
    const scopeN = ledger.scopePaths?.length ?? 0
    const lines = [
      `Opened ledger \`${ledger.id}\` → intensity **${intensity}** (tier ${tier})`,
      `Target: ${target}`,
      scopeN > 0
        ? `Scope freeze: **${scopeN}** path(s) from git (findings outside → follow-up only)`
        : 'Scope freeze: _none_ (no git paths — freeze inactive until open has a changeset)',
      `Reviewers: ${protocol.reviewers}`,
      `Evidence tax: ${protocol.evidenceTax}`,
      `Max fix rounds: ${ledger.maxFixRounds}`,
      '',
      `### Next → \`${next.kind}\``,
      next.directive,
      formatReviewBudget(next.budget),
      ...next.steps.map((s) => `- ${s}`),
    ]
    print(options, '## Judgment open', lines.join('\n'))
    return { success: true, ledger, next }
  }

  private async add(
    args: string[],
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const req = await this.requireLedger(projectPath, options)
    if (!req.ok) return req.result
    const { projectId, ledger } = req.value

    const flags = parseFlags(args)
    const sevRaw = flags.severity ?? flags.s
    const title = flags.title ?? flags.t
    if (!sevRaw || !title) {
      return failWith(
        'add requires --severity <blocker|critical|warning|suggestion> and --title "..."',
        options
      )
    }
    const sevParsed = FindingSeveritySchema.safeParse(sevRaw.toLowerCase())
    if (!sevParsed.success) {
      return failWith(
        `Invalid severity "${sevRaw}". Use blocker|critical|warning|suggestion.`,
        options
      )
    }

    const lineRaw = flags.line
    const rawFinding = applySeverityFloor({
      id: newFindingId(),
      severity: sevParsed.data as FindingSeverity,
      status: 'candidate',
      title,
      file: flags.file ?? flags.f,
      line: lineRaw ? Number.parseInt(lineRaw, 10) : undefined,
      evidence: flags.evidence ?? flags.e,
      judge: flags.judge ?? flags.j,
    })

    // Evidence tax + mechanical style refute (prefer-const + ++ = hallucination)
    const taxed = applyMechanicalStyleRefute(applyEvidenceTax(rawFinding))

    // Ghost filter — annotate known FPs (never auto-kill)
    const book = judgmentLedgerStorage.getGhosts(projectId)
    const [tagged] = applyGhostFilter([taxed], book)
    // Scope freeze: file outside frozen git path set → non-blocking follow-up.
    const scoped = applyScopeFreeze(tagged!, ledger.scopePaths)
    const { findings, finding, deduped } = upsertFinding(ledger.findings, scoped)
    ledger.findings = findings
    ledger.updatedAt = getTimestamp()
    ledger.verdict = 'in_progress'
    judgmentLedgerStorage.set(projectId, ledger)

    const taxNote =
      finding.severity !== (sevParsed.data as FindingSeverity)
        ? ` · evidence tax: ${sevParsed.data} → ${finding.severity}`
        : ''
    const mechNote =
      finding.status === 'refuted' && /MECHANICAL REFUTE/i.test(finding.evidence ?? '')
        ? ' · ⚡ mechanical refute (prefer-const hallucination)'
        : ''
    const scopeNote =
      scoped.status === 'info' && tagged!.status !== 'info'
        ? ' · **out of frozen scope** (follow-up only)'
        : ''
    const lines = [
      `${deduped ? 'Merged (DNA dedup)' : 'Added'} ${finding.severity} [${finding.status}] \`${finding.id}\`: ${finding.title}${taxNote}${mechNote}${scopeNote}`,
      `DNA \`${finding.dna}\` · evidence=${finding.evidenceScore ?? 0}/3 · blast=${finding.blast ?? 0}`,
      finding.knownFalsePositive
        ? '👻 GHOST — previously refuted in this project; challenge hard'
        : '',
      finding.status === 'refuted'
        ? '→ REFUTED by code (will not enter fix loops)'
        : finding.status === 'info'
          ? '→ info only (will not enter fix loops)'
          : '→ candidate (must survive batch challenge before fix)',
    ].filter(Boolean)
    print(options, '## Judgment add', lines.join('\n'))
    return { success: true, finding, ledger, deduped }
  }

  /**
   * Dual-blind merge: ingest RED + BLUE JSON arrays into the ledger.
   * `--red '[{severity,title,file,line,evidence}]' --blue '[...]'`
   * Contradictions auto-set escalate flag (do not tie-break).
   */
  private async merge(
    args: string[],
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const req = await this.requireLedger(projectPath, options)
    if (!req.ok) return req.result
    const { projectId, ledger } = req.value

    const flags = parseFlags(args)
    const redRaw = flags.red ?? flags.r
    const blueRaw = flags.blue ?? flags.b
    if (!redRaw || !blueRaw) {
      return failWith(
        "merge requires --red '<json array>' and --blue '<json array>' of findings",
        options
      )
    }

    const parsedFindings = (() => {
      try {
        return { red: JSON.parse(redRaw) as unknown, blue: JSON.parse(blueRaw) as unknown }
      } catch {
        return null
      }
    })()
    if (!parsedFindings) {
      return failWith('merge: --red and --blue must be valid JSON arrays', options)
    }
    const { red: redFindings, blue: blueFindings } = parsedFindings
    if (!Array.isArray(redFindings) || !Array.isArray(blueFindings)) {
      return failWith('merge: --red and --blue must be JSON arrays', options)
    }

    const parseSide = (arr: unknown[], role: 'red' | 'blue') => {
      const out: Array<{
        severity: FindingSeverity
        title: string
        file?: string
        line?: number
        evidence?: string
        judge?: string
      }> = []
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue
        const o = item as Record<string, unknown>
        const sev = FindingSeveritySchema.safeParse(String(o.severity ?? '').toLowerCase())
        const title = String(o.title ?? '').trim()
        if (!sev.success || !title) continue
        out.push({
          severity: sev.data,
          title,
          file: o.file ? String(o.file) : undefined,
          line: typeof o.line === 'number' ? o.line : undefined,
          evidence: o.evidence ? String(o.evidence) : undefined,
          judge: role,
        })
      }
      return out
    }

    const merged = mergeDualJudges(
      { role: 'red', findings: parseSide(redFindings, 'red') },
      { role: 'blue', findings: parseSide(blueFindings, 'blue') }
    )

    const book = judgmentLedgerStorage.getGhosts(projectId)
    const findings = applyGhostFilter(merged.findings, book).map((f) =>
      applyScopeFreeze(applyMechanicalStyleRefute(applyEvidenceTax(f)), ledger.scopePaths)
    )
    // Fold into existing ledger via DNA upsert
    ledger.findings = findings.reduce(
      (current, finding) => upsertFinding(current, finding).findings,
      ledger.findings
    )

    ledger.merge = {
      agreed: merged.agreed,
      onlyRed: merged.onlyRed,
      onlyBlue: merged.onlyBlue,
      contradicted: merged.contradicted,
    }
    ledger.updatedAt = getTimestamp()

    if (merged.shouldEscalate) {
      ledger.verdict = 'escalated'
      ledger.escalateReason = merged.escalateReason
      judgmentLedgerStorage.set(projectId, ledger)
      print(
        options,
        '## Judgment merge → ESCALATE',
        [
          `agreed=${merged.agreed} onlyRed=${merged.onlyRed} onlyBlue=${merged.onlyBlue} contradicted=${merged.contradicted}`,
          merged.escalateReason,
          'Do not tie-break. Surface both sides to the user.',
        ].join('\n')
      )
      return { success: true, ledger, merge: merged, escalated: true }
    }

    ledger.verdict = 'in_progress'
    judgmentLedgerStorage.set(projectId, ledger)
    const next = buildNextAction(ledger, ledger.intensity)
    print(
      options,
      '## Judgment merge',
      [
        `Merged RED+BLUE → ${ledger.findings.length} unique DNA findings`,
        `agreed=${merged.agreed} onlyRed=${merged.onlyRed} onlyBlue=${merged.onlyBlue} contradicted=${merged.contradicted}`,
        '',
        `### Next → \`${next.kind}\``,
        next.directive,
        formatReviewBudget(next.budget),
        ...next.steps.map((s) => `- ${s}`),
      ].join('\n')
    )
    return { success: true, ledger, merge: merged, next }
  }

  private async challenge(
    args: string[],
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const req = await this.requireLedger(projectPath, options)
    if (!req.ok) return req.result
    const { projectId, ledger } = req.value

    const flags = parseFlags(args)
    const raw = flags.verdicts ?? flags.v ?? args.join(' ')
    if (!raw.trim()) {
      return failWith(
        'challenge requires --verdicts id1:stands,id2:refuted (one verdict per candidate; one batched challenger)',
        options
      )
    }

    const votesById = parseVerdicts(raw)
    if (Object.keys(votesById).length === 0) {
      return failWith('Could not parse any verdicts from input.', options)
    }

    ledger.findings = applyBatchRefutation(ledger.findings, votesById, ledger.intensity)
    // Fail-closed remaining candidates
    ledger.findings = this.failCloseRemainingCandidates(ledger)
    ledger.updatedAt = getTimestamp()
    const updated = finalizeLedger(ledger, getTimestamp())
    judgmentLedgerStorage.set(projectId, updated)

    // Compound FP ghosts from refuted findings
    const book = judgmentLedgerStorage.getGhosts(projectId)
    const nextBook = recordRefutedAsGhosts(book, updated.findings, getTimestamp())
    judgmentLedgerStorage.setGhosts(projectId, nextBook)

    const stands = updated.findings.filter((f) => f.status === 'stands').length
    const refuted = updated.findings.filter((f) => f.status === 'refuted').length
    const info = updated.findings.filter((f) => f.status === 'info').length
    const next = buildNextAction(updated, updated.intensity)
    print(
      options,
      '## Judgment challenge',
      [
        `Batch refutation (intensity=${updated.intensity}). stands=${stands} refuted=${refuted} info=${info}`,
        `Ghost book: ${nextBook.ghosts.length} project FPs remembered`,
        '',
        `### Next → \`${next.kind}\``,
        next.directive,
        formatReviewBudget(next.budget),
        ...next.steps.map((s) => `- ${s}`),
      ].join('\n')
    )
    return { success: true, ledger: updated, stands, refuted, info, next }
  }

  private async fixRound(projectPath: string, options: MdOption): Promise<CommandResult> {
    const req = await this.requireLedger(projectPath, options)
    if (!req.ok) return req.result
    const { projectId, ledger } = req.value

    const gate = canStartFixRound(ledger)
    if (!gate.ok) {
      if (ledger.fixRound >= ledger.maxFixRounds) {
        const closed = markLeftoversOpen(ledger, getTimestamp())
        judgmentLedgerStorage.set(projectId, closed)
        print(
          options,
          '## Judgment fix-round',
          `Budget exhausted. Leftovers marked open. verdict=${closed.verdict}. ${gate.reason}`
        )
        return { success: false, reason: 'budget_exhausted', ledger: closed }
      }
      return failWith(gate.reason, options)
    }

    const next = advanceFixRound(ledger, getTimestamp())
    judgmentLedgerStorage.set(projectId, next)
    const brief = buildReReviewBrief(next)
    const ranked = rankFindingsForFix(next.findings, next.scopePaths)
    print(
      options,
      '## Judgment fix-round',
      [
        `Round ${next.fixRound}/${next.maxFixRounds} started.`,
        `Blast-ranked fix order (in-scope only): ${ranked.map((f) => f.id).join(' → ') || '—'}`,
        'After fixes: `prjct judgment fixed <ids…>` → `brief` → `verify <ids…>`.',
      ].join('\n')
    )
    return { success: true, ledger: next, brief, rankedFixIds: ranked.map((f) => f.id) }
  }

  private async mark(
    ids: string[],
    status: 'fixed' | 'verified',
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const req = await this.requireLedger(projectPath, options)
    if (!req.ok) return req.result
    const { projectId, ledger } = req.value
    if (ids.length === 0) return failWith(`${status} requires at least one finding id.`, options)

    const skipped = markFindingsSkippedByScope(ledger, ids, status)
    const next = markFindings(ledger, ids, status, getTimestamp())
    const finalized = finalizeLedger(next, getTimestamp())
    judgmentLedgerStorage.set(projectId, finalized)
    const card = buildNextAction(finalized, finalized.intensity)
    const marked = ids.filter((id) => !skipped.includes(id)).length
    print(
      options,
      `## Judgment ${status}`,
      [
        `Marked ${marked} → ${status}. verdict=${finalized.verdict}` +
          (finalized.precisionHint !== undefined
            ? ` precision≈${Math.round(finalized.precisionHint * 100)}%`
            : ''),
        skipped.length > 0 ? `Skipped out-of-scope (follow-up only): ${skipped.join(', ')}` : '',
        `### Next → \`${card.kind}\`: ${card.directive}`,
      ]
        .filter(Boolean)
        .join('\n')
    )
    return { success: true, ledger: finalized, next: card, skippedScope: skipped }
  }

  private async brief(projectPath: string, options: MdOption): Promise<CommandResult> {
    const req = await this.requireLedger(projectPath, options)
    if (!req.ok) return req.result
    const { ledger } = req.value

    const brief = buildReReviewBrief(ledger)
    const body = [
      `**Intensity**: ${brief.intensity} · round ${brief.fixRound}/${brief.maxFixRounds}`,
      '',
      `**Scope**: ${brief.scope}`,
      '',
      `**Out of scope**: ${brief.outOfScope}`,
      '',
      `**Fix order (blast)**: ${brief.fixOrder.join(' → ') || '—'}`,
      '',
      '### Findings (ledger only)',
      ...(brief.findings.length
        ? brief.findings.map(
            (f) =>
              `- \`${f.id}\` **${f.severity}** [${f.status}] blast=${f.blast ?? 0} ${f.title}` +
              (f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : '')
          )
        : ['_none_']),
    ]
    print(options, '## Re-review brief', body.join('\n'))
    return { success: true, brief, ledger }
  }

  /** Machine directive — the agent loop reads this every turn. */
  private async next(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath)
    if (!proj.ok) return proj.result

    const ledger = judgmentLedgerStorage.get(proj.value)
    const intensity =
      ledger?.intensity ??
      (await (async () => {
        const cs = await computeCommittedChangeset(projectPath)
        const signals = await loadSignals(projectPath)
        return intensityFromChangeset(
          { files: cs?.files ?? 0, loc: cs?.loc ?? 0 },
          { ...signals, paths: await changesetPaths(projectPath, cs?.dirs) }
        ).intensity
      })())
    const card = buildNextAction(ledger, intensity)
    const lines = [
      `**kind**: \`${card.kind}\``,
      `**intensity**: ${card.intensity} · round ${card.fixRound}/${card.maxFixRounds}`,
      '',
      `> ${card.directive}`,
      `> ${formatReviewBudget(card.budget)}`,
      '',
      '### Steps',
      ...card.steps.map((s, i) => `${i + 1}. ${s}`),
      '',
      '### Counts',
      Object.entries(card.counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(' · '),
    ]
    if (card.judgeCharters) {
      lines.push(
        '',
        '### Charters',
        `RED: ${card.judgeCharters.red}`,
        '',
        `BLUE: ${card.judgeCharters.blue}`
      )
    }
    lines.push(...reviewDispatchGuidance(card))
    if (card.rankedFixIds.length) {
      lines.push('', `### Blast rank: ${card.rankedFixIds.join(' → ')}`)
    }
    print(options, '## Judgment NEXT', lines.join('\n'))
    return { success: true, next: card, ledger }
  }

  private async ghosts(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath)
    if (!proj.ok) return proj.result
    const book = judgmentLedgerStorage.getGhosts(proj.value)
    if (!book.ghosts.length) {
      print(
        options,
        '## Judgment ghosts',
        'No project false-positive ghosts yet. They compound when findings are refuted.'
      )
      return { success: true, ghosts: [] }
    }
    const lines = book.ghosts
      .slice(0, 30)
      .map(
        (g) => `- \`${g.dna}\` ×${g.times} — ${g.title}${g.lastReason ? ` (${g.lastReason})` : ''}`
      )
    print(
      options,
      '## Judgment ghosts (project FP memory)',
      [`${book.ghosts.length} remembered · updated ${book.updatedAt}`, '', ...lines].join('\n')
    )
    return { success: true, ghosts: book.ghosts }
  }

  private async approve(projectPath: string, options: MdOption): Promise<CommandResult> {
    const req = await this.requireLedger(projectPath, options)
    if (!req.ok) return req.result
    const { projectId, ledger } = req.value

    const stampApprove = async (l: typeof ledger): Promise<{ bit: string; ok: boolean }> => {
      try {
        const { shortHash, stampForApprove } = await import('../services/content-bound-stamp')
        const now = getTimestamp()
        const stamp = await stampForApprove(projectPath, l.scopePaths, now)
        l.contentBound = stamp
        const bit =
          stamp.pathCount > 0
            ? ` · content-bound tree=${shortHash(stamp.treeHash)} (${stamp.pathCount} paths)`
            : ' · content-bound (empty scope)'
        return { bit, ok: true }
      } catch (err) {
        // A1: do not silently approve without stamp under non-skip intensity —
        // ship would then fail-closed on no-stamp under code-strict.
        const msg = err instanceof Error ? err.message : String(err)
        return { bit: ` · content-bound FAILED (${msg})`, ok: false }
      }
    }

    // Empty ledger: agent attests reviewers ran and found nothing (explicit approve).
    if (ledger.findings.length === 0) {
      ledger.verdict = 'approved'
      ledger.updatedAt = getTimestamp()
      const stamped = await stampApprove(ledger)
      if (!stamped.ok && ledger.intensity !== 'skip') {
        return failWith(
          `Cannot approve: content-bound stamp failed${stamped.bit}. Fix git/workspace then re-approve.`,
          options
        )
      }
      judgmentLedgerStorage.set(projectId, ledger)
      print(
        options,
        '## Judgment APPROVED',
        `Ledger \`${ledger.id}\` APPROVED (empty review attestation)${stamped.bit}. Ship gate will pass.`
      )
      return { success: true, ledger, verdict: 'approved', emptyAttestation: true }
    }

    ledger.findings = this.failCloseRemainingCandidates(ledger)
    const finalized = finalizeLedger(ledger, getTimestamp())
    if (finalized.verdict !== 'approved') {
      judgmentLedgerStorage.set(projectId, finalized)
      return failWith(
        `Cannot approve: verdict=${finalized.verdict}. → \`prjct judgment next\``,
        options
      )
    }
    const stamped = await stampApprove(finalized)
    if (!stamped.ok && finalized.intensity !== 'skip') {
      return failWith(
        `Cannot approve: content-bound stamp failed${stamped.bit}. Fix git/workspace then re-approve.`,
        options
      )
    }
    judgmentLedgerStorage.set(projectId, finalized)
    print(
      options,
      '## Judgment APPROVED',
      `Ledger \`${finalized.id}\` APPROVED` +
        (finalized.precisionHint !== undefined
          ? ` · precision≈${Math.round(finalized.precisionHint * 100)}%`
          : '') +
        `${stamped.bit}. Ship gate will pass.`
    )
    return { success: true, ledger: finalized, verdict: 'approved' }
  }

  private async escalate(
    why: string,
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const req = await this.requireLedger(projectPath, options)
    if (!req.ok) return req.result
    const { projectId, ledger } = req.value

    ledger.verdict = 'escalated'
    ledger.escalateReason = why.trim() || 'judges contradict on a material finding'
    ledger.updatedAt = getTimestamp()
    judgmentLedgerStorage.set(projectId, ledger)
    print(
      options,
      '## Judgment ESCALATED',
      `Reason: ${ledger.escalateReason}\nSurface both judge verdicts to the user. Do not ship.`
    )
    return { success: true, ledger, verdict: 'escalated' }
  }

  private async clear(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath)
    if (!proj.ok) return proj.result
    judgmentLedgerStorage.clear(proj.value)
    print(options, '## Judgment clear', 'Active ledger cleared (ghost FP book kept).')
    return { success: true, cleared: true }
  }

  /**
   * `requireProject` + "is there an active ledger" in one call — the same
   * open every subcommand that needs a ledger to already exist used to
   * repeat (as opposed to `open`, which creates one, or `next`/`status`,
   * which handle a missing ledger themselves rather than failing).
   */
  private async requireLedger(
    projectPath: string,
    options: MdOption
  ): Promise<
    | { ok: true; value: { projectId: string; ledger: JudgmentLedger } }
    | { ok: false; result: CommandResult }
  > {
    const proj = await requireProject(projectPath)
    if (!proj.ok) return proj
    const ledger = judgmentLedgerStorage.get(proj.value)
    if (!ledger) {
      return {
        ok: false,
        result: failWith('No active ledger — `prjct judgment open` first.', options),
      }
    }
    return { ok: true, value: { projectId: proj.value, ledger } }
  }

  /**
   * Fail-closed refutation pass: any finding still `candidate` after the
   * explicit verdicts (no votes cast) is defeated per the ledger's
   * intensity refute-threshold — silence on a finding is not a pass.
   */
  private failCloseRemainingCandidates(ledger: JudgmentLedger): JudgmentLedger['findings'] {
    return applyBatchRefutation(
      ledger.findings,
      Object.fromEntries(
        ledger.findings
          .filter((f) => f.status === 'candidate')
          .map((f) => [f.id, [] as RefuteVerdict[]])
      ),
      ledger.intensity
    )
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function tokenize(input: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const m of input.matchAll(re)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return out
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  const consumed = new Set<number>()
  for (const [index, a] of args.entries()) {
    if (consumed.has(index)) continue
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = args[index + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      consumed.add(index + 1)
    } else {
      flags[key] = 'true'
    }
  }
  return flags
}

function parseVerdicts(raw: string): Record<string, RefuteVerdict[]> {
  const out: Record<string, RefuteVerdict[]> = {}
  for (const chunk of raw.split(/[,\s]+/).filter(Boolean)) {
    const parts = chunk.split(':')
    if (parts.length < 2) continue
    const id = parts[0]!
    const votes: RefuteVerdict[] = []
    for (const p of parts.slice(1)) {
      const v = RefuteVerdictSchema.safeParse(p.toLowerCase())
      if (v.success) votes.push(v.data)
    }
    if (votes.length) out[id] = votes
  }
  return out
}

async function loadSignals(projectPath: string): Promise<IntensitySignals> {
  try {
    const config = await configManager.readConfig(projectPath).catch(() => null)
    const { resolveActiveTask } = await import('../services/task-service')
    const projectId = config?.projectId
    if (!projectId) return {}
    const task = await resolveActiveTask(projectId, projectPath)
    return {
      harnessLevel: task?.harness?.level,
      harnessKind: task?.harness?.kind,
    }
  } catch {
    return {}
  }
}

async function changesetPaths(projectPath: string, dirs: string[] | undefined): Promise<string[]> {
  try {
    const { execFileAsync } = await import('../utils/exec')
    const defaultRef = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], {
      cwd: projectPath,
    })
      .then(({ stdout }) => {
        const ref = stdout.trim()
        return ref && ref !== 'origin/HEAD' ? ref : 'main'
      })
      .catch(() => 'main')
    const base = await execFileAsync('git', ['merge-base', defaultRef, 'HEAD'], {
      cwd: projectPath,
    })
      .then(({ stdout }) => stdout.trim() || null)
      .catch(() => null)
    if (!base) return dirs ?? []
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${base}..HEAD`], {
      cwd: projectPath,
    })
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return dirs ?? []
  }
}

async function defaultTarget(projectPath: string): Promise<string | null> {
  try {
    const { getGitBranch } = await import('../session/git-helpers')
    return (await getGitBranch(projectPath)) ?? null
  } catch {
    return null
  }
}

function formatLedger(ledger: {
  id: string
  target: string
  intensity: string
  fixRound: number
  maxFixRounds: number
  verdict: string
  precisionHint?: number
  scopePaths?: string[]
  findings: Array<{
    id: string
    severity: string
    status: string
    title: string
    blast?: number
    knownFalsePositive?: boolean
  }>
  escalateReason?: string
  merge?: { agreed: number; onlyRed: number; onlyBlue: number; contradicted: number }
}): string[] {
  const lines = [
    `- **id**: \`${ledger.id}\``,
    `- **target**: ${ledger.target}`,
    `- **intensity**: ${ledger.intensity}`,
    `- **round**: ${ledger.fixRound}/${ledger.maxFixRounds}`,
    `- **verdict**: **${ledger.verdict}**`,
  ]
  if (ledger.precisionHint !== undefined) {
    lines.push(`- **precision**: ~${Math.round(ledger.precisionHint * 100)}%`)
  }
  if (ledger.scopePaths && ledger.scopePaths.length > 0) {
    lines.push(
      `- **scope freeze**: ${ledger.scopePaths.length} path(s) — ${ledger.scopePaths.slice(0, 8).join(', ')}${ledger.scopePaths.length > 8 ? '…' : ''}`
    )
  }
  if (ledger.escalateReason) lines.push(`- **escalate**: ${ledger.escalateReason}`)
  if (ledger.merge) {
    lines.push(
      `- **merge**: agreed=${ledger.merge.agreed} onlyRed=${ledger.merge.onlyRed} onlyBlue=${ledger.merge.onlyBlue} contradicted=${ledger.merge.contradicted}`
    )
  }
  lines.push('', '### Findings (blast-ranked open first)')
  if (!ledger.findings.length) lines.push('_none_')
  const sorted = [...ledger.findings].sort((a, b) => (b.blast ?? 0) - (a.blast ?? 0))
  for (const f of sorted) {
    lines.push(
      `- \`${f.id}\` **${f.severity}** [${f.status}] blast=${f.blast ?? 0}${f.knownFalsePositive ? ' 👻' : ''} ${f.title}`
    )
  }
  return lines
}

function print(options: MdOption, heading: string, body: string): void {
  if (options.md) console.log(mdOutput(heading, body))
  else {
    out.info(heading.replace(/^#+ /, ''))
    console.log(body)
  }
}
