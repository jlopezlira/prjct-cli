/**
 * audit-spec dispatch — DYNAMIC lenses.
 *
 * prjct's audit used to dispatch a FIXED trio (strategic / architecture /
 * design) for every spec — the "predefined personas" anti-pattern. This
 * module makes the lens set emerge from the spec:
 *
 *   - `selectReviewers(content)` — a cheap, deterministic BASELINE. No LLM:
 *     prjct stays a thin CLI. `architecture` is the floor; other lenses are
 *     added when the spec's text signals their concern. The agent can
 *     override via `prjct spec audit <id> --lenses a,b,c`.
 *   - `renderAuditDispatch(id, title, content, lenses?)` — the single dispatch
 *     builder shared by the CLI and the MCP tool (previously duplicated; the
 *     MCP copy pasted the spec body — fixed here by pointing every reviewer
 *     at `prjct spec show <id> --md`).
 *   - `reviewsGatePassedRelational(projectId, specId)` — the auto-promote
 *     gate, read from the projected spec_review/spec_selected_reviewer
 *     tables (C6): every SELECTED lens passed. Legacy specs (empty selected
 *     set) fall back to the three baseline lenses.
 *
 * Lens vocabulary is OPEN — any lowercase string is a valid lens (mirrors how
 * memory `type` accepts any string); agent-invented lenses get a generic
 * rubric and resolve to the sonnet reviewer tier via the model policy fallback.
 */

import { createHash } from 'node:crypto'
import prjctDb from '../storage/database'
import type { AIProviderName } from '../types/provider'
import type { SpecContent } from '../types/spec'
import type { DomainDefinition } from '../types/storage/extended'
import { resolveDispatchMechanism } from './agent-dispatch'
import { groupReviewLenses, MAX_REVIEW_AGENTS_PER_STAGE } from './review-budget'
import { domainLensRubric, GENERIC_RUBRIC, LENS_CATALOG } from './review-lenses'
import { parseScopePaths } from './spec-validate'

/**
 * Canonical digest of the reviewable body of a spec (C1).
 * Lens results bind to this hash; content edits invalidate admission.
 */
export function computeAuditCandidateHash(content: SpecContent): string {
  const payload = {
    goal: content.goal,
    eli10: content.eli10,
    stakes: content.stakes,
    acceptance_criteria: content.acceptance_criteria,
    scope: content.scope,
    out_of_scope: content.out_of_scope,
    risks: content.risks,
    test_plan: content.test_plan,
    // Phase 1 / spec deltas: scenario edits drift the candidate exactly like
    // AC edits — a changed GIVEN/WHEN/THEN invalidates recorded reviews.
    scenarios: content.scenarios,
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/**
 * Does this spec touch a domain? A keyword present in the combined text, or a
 * filePattern literal segment present in a scope path. Cheap + deterministic.
 */
function domainMatchesSpec(d: DomainDefinition, hay: string, scopePaths: string[]): boolean {
  if (d.keywords.some((k) => k && hay.includes(k.toLowerCase()))) return true
  for (const pat of d.filePatterns) {
    const literals = pat.split('/').filter((s) => s && !s.includes('*'))
    if (literals.some((lit) => scopePaths.some((p) => p.includes(lit)))) return true
  }
  return false
}

/**
 * Deterministic BASELINE lens set for a spec. `architecture` is always
 * included (feasibility floor); the rest are added when the spec's combined
 * text signals their concern. This is the floor, not the final word — the
 * agent can adjust via `--lenses`.
 */
export function selectReviewers(content: SpecContent, domains: DomainDefinition[] = []): string[] {
  const lenses = new Set<string>(['architecture'])

  const hay = [
    content.goal,
    content.eli10,
    content.stakes,
    ...content.scope,
    ...content.out_of_scope,
    ...content.acceptance_criteria,
    ...content.risks.flatMap((r) => [r.risk, r.mitigation]),
  ]
    .join(' ')
    .toLowerCase()

  if (content.stakes.trim() !== '' || content.scope.length >= 4 || content.risks.length >= 2) {
    lenses.add('strategic')
  }
  if (/\b(cli|command|ui|ux|api|endpoint|flag|output|render|prompt)\b/.test(hay))
    lenses.add('design')
  if (
    /\b(auth|secret|token|crypto|password|payment|pii|permission|sandbox|exec|network)\b/.test(hay)
  )
    lenses.add('security')
  if (/\b(schema|migration|sql|db|database|query|index|table|storage)\b/.test(hay))
    lenses.add('data')
  if (/\b(perf|latency|throughput|hot path|scale|cache|cold start)\b/.test(hay))
    lenses.add('performance')

  // DOMAIN specialists: add an expert for each project domain this spec touches.
  // A function lens of the same name wins (no shadowing); the architecture floor
  // is untouched. Empty `domains` ⇒ byte-identical to the function-only baseline.
  if (domains.length > 0) {
    const scopePaths = parseScopePaths(content.scope)
    for (const d of domains) {
      if (LENS_CATALOG[d.name]) continue
      if (domainMatchesSpec(d, hay, scopePaths)) lenses.add(d.name)
    }
  }

  return [...lenses]
}

/**
 * Schema v2 (C6): the gate as a RELATIONAL query over the projected child
 * tables (spec_selected_reviewer + spec_review) — no content-blob parse. Every
 * selected lens must have a `pass` verdict; legacy specs (no selected set) fall
 * back to the three baseline lenses.
 */
export function reviewsGatePassedRelational(projectId: string, specId: string): boolean {
  // Load content blob for candidate-hash admission (C1). Relational tables
  // only carry verdicts — the frozen hash lives on specs.content.
  const row = prjctDb.get<{ content: string }>(
    projectId,
    'SELECT content FROM specs WHERE id = ?',
    specId
  )
  const content = (() => {
    if (!row?.content) return null
    try {
      return JSON.parse(row.content) as SpecContent
    } catch {
      return null
    }
  })()

  const selected = prjctDb
    .query<{ lens: string }>(
      projectId,
      'SELECT lens FROM spec_selected_reviewer WHERE spec_id = ?',
      specId
    )
    .map((r) => r.lens)
  const passed = new Set(
    prjctDb
      .query<{ lens: string }>(
        projectId,
        "SELECT lens FROM spec_review WHERE spec_id = ? AND verdict = 'pass'",
        specId
      )
      .map((r) => r.lens)
  )

  const lensesPass =
    selected.length > 0
      ? selected.every((lens) => passed.has(lens))
      : passed.has('strategic') && passed.has('architecture') && passed.has('design')
  if (!lensesPass) return false

  // C1: when audit stamped a frozen candidate, every pass must bind to it
  // and the body must still hash to the same digest. Legacy specs without
  // audit_candidate_hash keep prior lens-only behavior.
  const frozen = content?.audit_candidate_hash
  if (!frozen) return true
  if (computeAuditCandidateHash(content!) !== frozen) return false
  const reviews = content?.reviews ?? {}
  for (const lens of selected.length > 0 ? selected : Object.keys(reviews)) {
    const r = reviews[lens]
    if (!r || r.verdict !== 'pass') continue
    if (r.candidateHash !== frozen) return false
  }
  // selected lenses that passed relationally must also exist with matching hash
  for (const lens2 of selected.length > 0 ? selected : ['strategic', 'architecture', 'design']) {
    if (!passed.has(lens2)) continue
    const r = reviews[lens2]
    if (!r || r.candidateHash !== frozen) return false
  }
  return true
}

/**
 * The dispatch prompt emitted by `prjct spec audit`. Claude reads this, runs
 * at most two Agent calls in parallel. All selected lenses remain covered;
 * multiple lenses share one agent's spec/code read, then each verdict is
 * written back via `prjct spec record-review`.
 *
 * The spec body is NEVER embedded — each reviewer runs `prjct spec show <id>
 * --md` itself in its own fresh context.
 */
export async function renderAuditDispatch(
  id: string,
  title: string,
  content: SpecContent,
  lenses?: string[],
  projectProvider?: AIProviderName,
  domains: DomainDefinition[] = []
): Promise<string> {
  const dispatch = await resolveDispatchMechanism(projectProvider)
  const chosen = lenses && lenses.length > 0 ? lenses : selectReviewers(content, domains)
  const groups = groupReviewLenses(chosen)
  const domainMap = new Map(domains.map((d) => [d.name, d]))
  const scopePaths = parseScopePaths(content.scope)
  const scopeBlock =
    scopePaths.length > 0
      ? `\n\n## Codebase paths to read (from spec.scope)\n${scopePaths.map((p) => `- \`${p}\``).join('\n')}\n\nEach reviewer SHOULD use the Read tool on these paths — as many as its lens actually needs — to ground the verdict in the actual code. Cite specific symbols / files / line numbers in notes when applicable.`
      : '\n\n## Codebase paths\n_No path-shaped scope entries found. Reviewers judge the spec body alone._'

  const reviewerSections: string[] = []
  groups.forEach((group, i) => {
    const letter = String.fromCharCode(65 + (i % 26))
    reviewerSections.push(
      `## Reviewer agent ${letter} — ${group.join(' + ')}`,
      `Run \`prjct spec show ${id} --md\` once. Apply every lens below independently in one bounded pass; return one pass|fail verdict and 2-4 sentence notes PER LENS. Do not start another agent or second pass.`,
      ''
    )
    group.forEach((lens) => {
      const spec = LENS_CATALOG[lens]
      const domain = domainMap.get(lens)
      // Rubric resolution: function lens → its rubric; else a project domain →
      // the domain-expert rubric; else the generic fallback (open vocabulary).
      const label = spec ? spec.label : domain ? 'domain expert' : 'custom lens'
      const rubric = spec ? spec.rubric : domain ? domainLensRubric(domain) : GENERIC_RUBRIC
      reviewerSections.push(`### Lens: ${lens} (${label})`, rubric, '')
    })
  })

  const runLine = dispatch.runLine(groups.length)

  return [
    `# audit-spec dispatch — ${title}`,
    '',
    `Spec id: \`${id}\``,
    '',
    `Selected lenses for this spec: **${chosen.join(', ')}**. This is the baseline prjct computed from the spec — re-run \`prjct spec audit ${id} --lenses <comma,separated>\` to adjust the set before dispatching (add a lens the risk surface demands, drop one that is irrelevant).`,
    '',
    runLine,
    `Hard ceiling: at most ${MAX_REVIEW_AGENTS_PER_STAGE} reviewer agents, one bounded pass each. All ${chosen.length} lens verdicts are still required.`,
    '',
    '## Where the spec lives — read it from prjct, it is NOT in this prompt',
    `The plan lives in prjct (SQLite), never duplicated into a dispatch payload. Each reviewer runs \`prjct spec show ${id} --md\` itself, fresh, to read the full spec. Do NOT paste the spec body into the prompts — point them at that command. (Same rule for any memory the reviewer wants: \`prjct context memory <topic>\` — pulled by the reviewer, not pre-pasted by you.)`,
    '',
    '## Before dispatching',
    'Do not set `model:` on any reviewer — every agent inherits the model this session is running. Hand reviewers the spec-read COMMAND and the codebase PATHS + the Read tool — never paste spec body or file contents into their prompts. Read each shared source once per agent.',
    scopeBlock,
    '',
    ...reviewerSections,
    '## After dispatch',
    'For each lens that returns:',
    `  prjct spec record-review ${id} --reviewer <${chosen.join('|')}> --verdict <pass|fail> --notes "<their notes>"`,
    '',
    `When all selected lenses (${chosen.join(', ')}) are recorded with verdict=pass, the spec auto-promotes from \`draft\` → \`reviewed\`.`,
  ].join('\n')
}
