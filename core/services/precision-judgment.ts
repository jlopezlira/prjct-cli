/**
 * Precision-gated judgment engine — structural stop conditions (v2 steroids).
 *
 * gentle-ai v1.46 = precision in adapter prose.
 * prjct v2 = the same contract as pure functions + SQLite + compounding memory:
 *
 *  1. Intensity from git delivery-geometry (+ hot-path / H3 force-upgrade)
 *  2. Severity floor — warning/suggestion never enter fix loops
 *  3. Evidence TAX — blockers without file:line+sketch cannot stay blockers
 *  4. Finding DNA — fingerprint dedup + project ghost (FP) memory
 *  5. Dual-judge RED/BLUE merge — agreement / single-side / contradiction
 *  6. Batch refutation ceiling fixed at one challenger — never O(findings)
 *  7. Fail-closed missing votes → stands
 *  8. Convergence budget max 2 fix rounds
 *  9. Scoped re-review brief (ledger + fix scope only)
 * 10. Agent next-action card (machine directives, not vibes)
 * 11. Ship verdict reads ledger, not "you should have reviewed"
 */

import type {
  FindingSeverity,
  FindingStatus,
  JudgeRole,
  JudgmentFinding,
  JudgmentGhost,
  JudgmentGhostBook,
  JudgmentLedger,
  JudgmentVerdict,
  RefuteVerdict,
  ReviewIntensity,
} from '../schemas/judgment'
import { MAX_FIX_ROUNDS } from '../schemas/judgment'
import type { DeliveryTier } from './delivery-geometry'
import { tierOf } from './delivery-geometry'
import {
  MAX_REVIEW_AGENTS_PER_STAGE,
  type ReviewExecutionBudget,
  reviewBudgetFor,
} from './review-budget'

// ── Intensity router ────────────────────────────────────────────────────────

/** Paths that force full dual-blind even when the diff is "normal" size. */
export const HOT_PATH_RE =
  /(^|\/)(auth|security|crypto|migration|migrations|password|oauth|payment|billing|secret|token|session|rbac|acl)(\/|\.|$)/i

export interface IntensitySignals {
  paths?: string[]
  harnessLevel?: 'H0' | 'H1' | 'H2' | 'H3'
  harnessKind?: string
}

export function isHotPath(paths: string[] | undefined): boolean {
  if (!paths?.length) return false
  return paths.some((p) => HOT_PATH_RE.test(p))
}

export function routeIntensity(
  tier: DeliveryTier,
  signals: IntensitySignals = {}
): ReviewIntensity {
  const securityForce =
    signals.harnessLevel === 'H3' || signals.harnessKind === 'security' || isHotPath(signals.paths)
  if (securityForce) return 'full'
  if (tier === 'trivial') return 'skip'
  if (tier === 'normal') return 'standard'
  return 'full'
}

export function intensityFromChangeset(
  cs: { files: number; loc: number },
  signals: IntensitySignals = {}
): { tier: DeliveryTier; intensity: ReviewIntensity } {
  const tier = tierOf(cs)
  return { tier, intensity: routeIntensity(tier, signals) }
}

// ── Finding DNA ─────────────────────────────────────────────────────────────

/**
 * Stable fingerprint for dedup + ghost memory.
 * Normalizes title (lowercase, strip punctuation noise) + file + line bucket.
 */
export function findingDna(input: { title: string; file?: string; line?: number }): string {
  const title = input.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  const file = (input.file ?? '').toLowerCase().replace(/\\/g, '/')
  // Line bucket (±5) so "line 42" and "line 44" still collide as same DNA.
  const lineBucket = input.line && input.line > 0 ? String(Math.floor(input.line / 5) * 5) : ''
  return `dna:${hash32(`${title}|${file}|${lineBucket}`)}`
}

/** Tiny non-crypto 32-bit hash — good enough for local DNA, zero deps. */
function hash32(s: string): string {
  const h = s
    .split('')
    .reduce((hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16777619), 2166136261)
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ── Evidence tax ────────────────────────────────────────────────────────────

/**
 * Evidence quality 0–3:
 *  0 title only · 1 file · 2 file+line · 3 file+line+evidence (≥12 chars)
 *
 * Blockers with score < 2 are taxed: demoted to critical (still actionable)
 * so "vibes blockers" cannot freeze ship. Critical with score 0 demoted to warning→info.
 */
export function evidenceScore(
  f: Pick<JudgmentFinding, 'file' | 'line' | 'evidence'>
): 0 | 1 | 2 | 3 {
  const hasFile = Boolean(f.file?.trim())
  const hasLine = typeof f.line === 'number' && f.line > 0
  const hasEvidence = Boolean(f.evidence && f.evidence.trim().length >= 12)
  if (hasFile && hasLine && hasEvidence) return 3
  if (hasFile && hasLine) return 2
  if (hasFile) return 1
  return 0
}

export function applyEvidenceTax(finding: JudgmentFinding): JudgmentFinding {
  const score = evidenceScore(finding)
  const original = finding.severity
  // Use ORIGINAL severity so a taxed blocker→critical is not double-taxed to warning.
  const severity =
    original === 'blocker' && score < 2
      ? 'critical'
      : original === 'critical' && score === 0
        ? 'warning'
        : original
  const status =
    severity === 'warning' || severity === 'suggestion'
      ? 'info'
      : finding.status === 'info'
        ? 'candidate'
        : finding.status

  return {
    ...finding,
    severity,
    status,
    evidenceScore: score,
    dna: finding.dna ?? findingDna(finding),
    blast: finding.blast ?? blastRank({ ...finding, severity, evidenceScore: score }),
  }
}

// ── Const-only evidence tax ──────────────────────────────────────────────────
// Const-only is a repository invariant. Review findings still need a concrete
// file, line, and snippet so an agent proposes the correct functional rewrite.

/** Const-only review claims. */
export const PREFER_CONST_CLAIM_RE =
  /\b(prefer[- ]const|use const|should be const|can be const|const instead|instead of let|never reassigned|not reassigned|let\s*→\s*const|change let to const|let is unnecessary|why let|por qu[eé] let)\b/i

export function isPreferConstClaim(text: string): boolean {
  return PREFER_CONST_CLAIM_RE.test(text)
}

/**
 * Require const-only findings to include file:line+snippet. Reassignment is
 * evidence for a functional refactor, never a reason to auto-refute the claim.
 * The historical function name remains as a compatibility surface.
 */
export function applyMechanicalStyleRefute(finding: JudgmentFinding): JudgmentFinding {
  const blob = `${finding.title}\n${finding.evidence ?? ''}`
  if (!isPreferConstClaim(blob)) return finding

  const score = evidenceScore(finding)
  if (score < 3) {
    const note =
      '[CONST-ONLY TAX: include file:line + snippet and propose an immutable rewrite; title-only findings are noise]'
    return applyEvidenceTax({
      ...finding,
      severity: 'suggestion',
      status: 'info',
      evidence: finding.evidence ? `${finding.evidence}\n${note}` : note,
    })
  }

  return finding
}

// ── Blast-radius rank (fix order) ──────────────────────────────────────────

const SEV_WEIGHT: Record<FindingSeverity, number> = {
  blocker: 100,
  critical: 70,
  warning: 20,
  suggestion: 5,
}

/**
 * Higher = fix first. Combines severity, evidence quality, and hot-path file.
 * Agents sort the fix queue by this — not by who yelled loudest.
 */
export function blastRank(
  f: Pick<JudgmentFinding, 'severity' | 'file' | 'evidenceScore' | 'status'>
): number {
  return (
    (SEV_WEIGHT[f.severity] ?? 0) +
    (f.evidenceScore ?? 0) * 5 +
    (f.file && isHotPath([f.file]) ? 25 : 0) +
    (f.status === 'stands' ? 10 : 0) +
    (f.status === 'open' ? 15 : 0)
  )
}

export function rankFindingsForFix(
  findings: JudgmentFinding[],
  scopePaths?: readonly string[] | undefined
): JudgmentFinding[] {
  return [...findings]
    .filter(
      (f) =>
        isActionableSeverity(f.severity) &&
        (f.status === 'stands' ||
          f.status === 'candidate' ||
          f.status === 'open' ||
          f.status === 'fixed') &&
        // When scope freeze is set, out-of-scope findings never enter fix order.
        pathInScope(f.file, scopePaths)
    )
    .sort((a, b) => (b.blast ?? blastRank(b)) - (a.blast ?? blastRank(a)))
}

// ── Severity floor ──────────────────────────────────────────────────────────

export function isActionableSeverity(severity: FindingSeverity): boolean {
  return severity === 'blocker' || severity === 'critical'
}

export function applySeverityFloor(finding: JudgmentFinding): JudgmentFinding {
  // Evidence tax first (may demote severity), then floor.
  const taxed = applyEvidenceTax(finding)
  if (!isActionableSeverity(taxed.severity)) {
    return { ...taxed, status: 'info' }
  }
  if (taxed.status === 'info') {
    return { ...taxed, status: 'candidate' }
  }
  return taxed
}

export function applySeverityFloorAll(findings: JudgmentFinding[]): JudgmentFinding[] {
  return findings.map(applySeverityFloor)
}

// ── Ghost filter (project FP memory) ────────────────────────────────────────

export function markGhost(
  book: JudgmentGhostBook,
  finding: Pick<JudgmentFinding, 'dna' | 'title'>,
  now: string,
  reason?: string
): JudgmentGhostBook {
  const dna = finding.dna
  if (!dna) return book
  const existing = book.ghosts.find((g) => g.dna === dna)
  const updatedGhosts: JudgmentGhost[] = existing
    ? book.ghosts.map((ghost) =>
        ghost.dna === dna
          ? {
              ...ghost,
              times: ghost.times + 1,
              lastSeenAt: now,
              lastReason: reason ?? ghost.lastReason,
              title: finding.title || ghost.title,
            }
          : ghost
      )
    : [...book.ghosts, { dna, title: finding.title, times: 1, lastSeenAt: now, lastReason: reason }]
  // Cap book size — keep hottest ghosts
  const ghosts = updatedGhosts.sort((a, b) => b.times - a.times).slice(0, 200)
  return { ghosts, updatedAt: now }
}

export function recordRefutedAsGhosts(
  book: JudgmentGhostBook,
  findings: JudgmentFinding[],
  now: string
): JudgmentGhostBook {
  return findings.reduce(
    (next, finding) =>
      finding.status === 'refuted' && finding.dna
        ? markGhost(next, finding, now, 'refuted by panel')
        : next,
    book
  )
}

/**
 * Tag findings that match project ghosts. Does NOT auto-kill (fail-closed):
 * marks knownFalsePositive so the refuter prioritizes them and the agent sees the prior.
 */
export function applyGhostFilter(
  findings: JudgmentFinding[],
  book: JudgmentGhostBook | null
): JudgmentFinding[] {
  if (!book?.ghosts.length) return findings
  const map = new Map(book.ghosts.map((g) => [g.dna, g]))
  return findings.map((f) => {
    const dna = f.dna ?? findingDna(f)
    const ghost = map.get(dna)
    if (!ghost) return { ...f, dna }
    return {
      ...f,
      dna,
      knownFalsePositive: true,
      // Soft demote: if still candidate, leave for challenge but annotate
      evidence: f.evidence
        ? `${f.evidence} [GHOST: refuted ${ghost.times}× in this project]`
        : `[GHOST: refuted ${ghost.times}× here — challenge hard]`,
    }
  })
}

// ── Dual-judge RED/BLUE merge ───────────────────────────────────────────────

export interface JudgePayload {
  role: JudgeRole
  findings: Array<{
    severity: FindingSeverity
    title: string
    file?: string
    line?: number
    evidence?: string
    judge?: string
  }>
}

export interface MergeResult {
  findings: JudgmentFinding[]
  agreed: number
  onlyRed: number
  onlyBlue: number
  /**
   * Material contradiction: same DNA but different actionable-ness or
   * severity band (blocker vs non-actionable) across red/blue.
   */
  contradicted: number
  /** True when judges disagree on a material finding → escalate, don't tie-break. */
  shouldEscalate: boolean
  escalateReason: string
}

/**
 * Dual-blind merge. RED = adversarial attack ("what could kill prod").
 * BLUE = change advocate ("is the risk real / already mitigated").
 * Same DNA from both → agreed (stronger). One side only → keep as candidate.
 * Severity band contradiction on same DNA → escalate flag.
 */
export function mergeDualJudges(
  red: JudgePayload,
  blue: JudgePayload,
  idFactory: () => string = newFindingId
): MergeResult {
  type Side = { role: JudgeRole; raw: JudgePayload['findings'][number] }
  const bucket = new Map<string, Side[]>()

  const ingest = (payload: JudgePayload) => {
    for (const raw of payload.findings) {
      const dna = findingDna(raw)
      const list = bucket.get(dna) ?? []
      list.push({ role: payload.role, raw })
      bucket.set(dna, list)
    }
  }
  ingest({ ...red, role: 'red' })
  ingest({ ...blue, role: 'blue' })

  const merged = [...bucket].map(([dna, sides]) => {
    const roles = new Set(sides.map((s) => s.role))
    const hasRed = roles.has('red')
    const hasBlue = roles.has('blue')
    const reds = sides.filter((s) => s.role === 'red')
    const blues = sides.filter((s) => s.role === 'blue')

    // Pick the highest-severity report as base; prefer evidence-richer.
    const ranked = [...sides].sort((a, b) => {
      const sa = SEV_WEIGHT[a.raw.severity] + evidenceScore(a.raw) * 5
      const sb = SEV_WEIGHT[b.raw.severity] + evidenceScore(b.raw) * 5
      return sb - sa
    })
    const best = ranked[0]!.raw
    const agreedBy = [...roles]

    const redActionable = reds.some((side) => isActionableSeverity(side.raw.severity))
    const blueActionable = blues.some((side) => isActionableSeverity(side.raw.severity))
    const outcome =
      hasRed && hasBlue
        ? redActionable !== blueActionable
          ? 'contradicted'
          : 'agreed'
        : hasRed
          ? 'onlyRed'
          : 'onlyBlue'

    const base: JudgmentFinding = applySeverityFloor({
      id: idFactory(),
      severity: best.severity,
      status: 'candidate',
      title: best.title,
      file: best.file,
      line: best.line,
      evidence: best.evidence,
      judge: best.judge ?? [...roles].join('+'),
      role: hasRed && hasBlue ? undefined : hasRed ? 'red' : 'blue',
      dna,
      agreedBy,
    })
    return { finding: base, outcome }
  })

  const findings = merged.map(({ finding }) => finding)
  const agreed = merged.filter(({ outcome }) => outcome === 'agreed').length
  const onlyRed = merged.filter(({ outcome }) => outcome === 'onlyRed').length
  const onlyBlue = merged.filter(({ outcome }) => outcome === 'onlyBlue').length
  const contradicted = merged.filter(({ outcome }) => outcome === 'contradicted').length

  const shouldEscalate = contradicted > 0
  return {
    findings,
    agreed,
    onlyRed,
    onlyBlue,
    contradicted,
    shouldEscalate,
    escalateReason: shouldEscalate
      ? `${contradicted} dual-blind contradiction(s): red says actionable, blue says not (or reverse). Do not tie-break — escalate to user.`
      : '',
  }
}

// ── Batch refutation ────────────────────────────────────────────────────────

export type RefutePanelSize = 1 | 3

export function refutePanelSize(_intensity: ReviewIntensity): RefutePanelSize {
  // RED + BLUE already provide independent evidence on full. A second
  // three-agent panel repeated the same context and made the gate cost five
  // calls before any fix. One fresh batched challenger keeps the false-positive
  // check while bounding the stage to a single additional call.
  return 1
}

export function resolveRefuteVotes(
  votes: RefuteVerdict[] | undefined,
  panelSize: RefutePanelSize
): FindingStatus {
  const v = votes ?? []
  if (v.length === 0) return 'stands'

  if (panelSize === 1) {
    return v[0] === 'refuted' ? 'refuted' : 'stands'
  }

  const padded: RefuteVerdict[] = [...v]
  while (padded.length < 3) padded.push('stands')
  const refuted = padded.slice(0, 3).filter((x) => x === 'refuted').length
  return refuted >= 2 ? 'refuted' : 'stands'
}

export function applyBatchRefutation(
  findings: JudgmentFinding[],
  votesById: Record<string, RefuteVerdict[]>,
  intensity: ReviewIntensity
): JudgmentFinding[] {
  const panel = refutePanelSize(intensity)
  return findings.map((f) => {
    if (f.status === 'info' || f.status === 'refuted' || f.status === 'verified') return f
    if (!isActionableSeverity(f.severity)) {
      return { ...f, status: 'info' as const }
    }
    if (f.status !== 'candidate' && f.status !== 'stands') return f
    const votes = votesById[f.id]
    // Ghost bias: if known FP and no explicit votes, still fail-closed stands
    // (refuter must actively kill). Votes present → normal resolve.
    const status = resolveRefuteVotes(votes, panel)
    return { ...f, status, refuteVotes: votes ?? f.refuteVotes }
  })
}

// ── Convergence budget ──────────────────────────────────────────────────────

export function actionableOpen(findings: JudgmentFinding[]): JudgmentFinding[] {
  return findings.filter(
    (f) =>
      isActionableSeverity(f.severity) &&
      (f.status === 'stands' || f.status === 'candidate' || f.status === 'open')
  )
}

export function canStartFixRound(
  ledger: Pick<JudgmentLedger, 'fixRound' | 'maxFixRounds' | 'findings'>
): { ok: boolean; reason: string } {
  const open = actionableOpen(ledger.findings)
  if (open.length === 0) {
    return { ok: false, reason: 'no actionable open findings' }
  }
  if (ledger.fixRound >= ledger.maxFixRounds) {
    return {
      ok: false,
      reason: `convergence budget exhausted (${ledger.fixRound}/${ledger.maxFixRounds}) — leftover stays open; do not start round 3`,
    }
  }
  return { ok: true, reason: '' }
}

export function advanceFixRound(ledger: JudgmentLedger, now: string): JudgmentLedger {
  const nextRound = ledger.fixRound + 1
  if (nextRound > ledger.maxFixRounds) {
    return markLeftoversOpen(ledger, now)
  }
  return {
    ...ledger,
    fixRound: nextRound,
    updatedAt: now,
    verdict: 'in_progress',
  }
}

export function markLeftoversOpen(ledger: JudgmentLedger, now: string): JudgmentLedger {
  const findings = ledger.findings.map((f) => {
    if (isActionableSeverity(f.severity) && (f.status === 'stands' || f.status === 'candidate')) {
      return { ...f, status: 'open' as const }
    }
    return f
  })
  const stillOpen = actionableOpen(findings).length > 0 || findings.some((f) => f.status === 'open')
  return {
    ...ledger,
    findings,
    fixRound: ledger.maxFixRounds,
    updatedAt: now,
    verdict: stillOpen ? 'blocked' : 'approved',
    precisionHint: computePrecisionHint(findings),
  }
}

export function markFindings(
  ledger: JudgmentLedger,
  ids: string[],
  status: Extract<FindingStatus, 'fixed' | 'verified' | 'open'>,
  now: string
): JudgmentLedger {
  const idSet = new Set(ids)
  const findings = ledger.findings.map((f) => {
    if (!idSet.has(f.id)) return f
    // Scope freeze: never mark fixed/verified on out-of-scope follow-ups.
    if ((status === 'fixed' || status === 'verified') && !findingInFixScope(f, ledger.scopePaths)) {
      return f
    }
    return { ...f, status }
  })
  return {
    ...ledger,
    findings,
    updatedAt: now,
    precisionHint: computePrecisionHint(findings),
  }
}

/** Ids that were requested for fixed/verified but skipped by scope freeze. */
export function markFindingsSkippedByScope(
  ledger: JudgmentLedger,
  ids: string[],
  status: Extract<FindingStatus, 'fixed' | 'verified'>
): string[] {
  if (status !== 'fixed' && status !== 'verified') return []
  const idSet = new Set(ids)
  return ledger.findings
    .filter((f) => idSet.has(f.id) && !findingInFixScope(f, ledger.scopePaths))
    .map((f) => f.id)
}

/** Precision = verified / (verified + refuted). null-ish when no signal → undefined. */
export function computePrecisionHint(findings: JudgmentFinding[]): number | undefined {
  const verified = findings.filter((f) => f.status === 'verified').length
  const refuted = findings.filter((f) => f.status === 'refuted').length
  const denom = verified + refuted
  if (denom === 0) return undefined
  return Math.round((verified / denom) * 1000) / 1000
}

// ── Terminal verdict ────────────────────────────────────────────────────────

export function computeVerdict(ledger: JudgmentLedger): JudgmentVerdict {
  if (ledger.verdict === 'escalated') return 'escalated'
  // Explicit empty-review attestation (approve with zero findings after reviewers ran)
  if (ledger.verdict === 'approved') return 'approved'
  // Empty ledger ≠ clean review — reviewers have not reported yet
  if (ledger.findings.length === 0) return 'in_progress'
  const open = actionableOpen(ledger.findings)
  const leftover = ledger.findings.some((f) => f.status === 'open')
  if (open.length > 0 || leftover) return 'blocked'
  const unchallenged = ledger.findings.some(
    (f) => isActionableSeverity(f.severity) && f.status === 'candidate'
  )
  if (unchallenged) return 'in_progress'
  return 'approved'
}

export function finalizeLedger(ledger: JudgmentLedger, now: string): JudgmentLedger {
  const verdict = computeVerdict(ledger)
  return {
    ...ledger,
    verdict,
    updatedAt: now,
    precisionHint: computePrecisionHint(ledger.findings),
  }
}

// ── Scoped re-review brief ──────────────────────────────────────────────────

export interface ReReviewBrief {
  intensity: ReviewIntensity
  fixRound: number
  maxFixRounds: number
  findings: Array<{
    id: string
    severity: FindingSeverity
    status: FindingStatus
    title: string
    file?: string
    line?: number
    blast?: number
    dna?: string
  }>
  scope: string
  outOfScope: string
  /** Fix order — highest blast first. */
  fixOrder: string[]
}

export function buildReReviewBrief(ledger: JudgmentLedger): ReReviewBrief {
  const ranked = rankFindingsForFix(
    ledger.findings.filter(
      (f) =>
        isActionableSeverity(f.severity) &&
        (f.status === 'fixed' || f.status === 'stands' || f.status === 'open')
    ),
    ledger.scopePaths
  )
  const findings = ranked.map(({ id, severity, status, title, file, line, blast, dna }) => ({
    id,
    severity,
    status,
    title,
    file,
    line,
    blast,
    dna,
  }))

  return {
    intensity: ledger.intensity,
    fixRound: ledger.fixRound,
    maxFixRounds: ledger.maxFixRounds,
    findings,
    fixOrder: findings.map((f) => f.id),
    scope: (() => {
      const paths = ledger.scopePaths ?? []
      const pathHint =
        paths.length > 0
          ? ` Frozen scope (${paths.length} paths): ${paths.slice(0, 12).join(', ')}${paths.length > 12 ? '…' : ''}.`
          : ''
      return (
        'Re-judge ONLY the persisted ledger findings below plus the fix-diff for those items. ' +
        'Confirm each fixed finding is actually resolved; report regressions on those lines only. ' +
        `Fix order is blast-ranked — do not reorder by preference.${pathHint}`
      )
    })(),
    outOfScope:
      'Do NOT reopen the original full PR diff. Do NOT invent new WARNING/SUGGESTION loops. ' +
      'Findings whose file is outside the frozen git scope are follow-up only (info) — they do not enter fix loops. ' +
      'New BLOCKER/CRITICAL on in-scope fix-diff may be added as candidates (evidence tax + severity floor + challenge still apply).',
  }
}

// ── Agent next-action card (machine directives) ─────────────────────────────

export type NextActionKind =
  | 'skip_ship'
  | 'open_ledger'
  | 'dispatch_reviewers'
  | 'dispatch_refuters'
  | 'fix_ranked'
  | 'rejudge_scoped'
  | 'approve'
  | 'escalate'
  | 'blocked_budget'
  | 'idle'

export interface NextActionCard {
  kind: NextActionKind
  /** One-line directive an agent can execute without re-deriving state. */
  directive: string
  /** Concrete CLI / tool steps. */
  steps: string[]
  intensity: ReviewIntensity
  fixRound: number
  maxFixRounds: number
  counts: {
    candidates: number
    stands: number
    refuted: number
    fixed: number
    verified: number
    info: number
    open: number
    ghosts: number
  }
  rankedFixIds: string[]
  judgeCharters?: { red: string; blue: string }
  /** Hard process ceilings rendered into every dispatch card. */
  budget: ReviewExecutionBudget
}

const RED_CHARTER =
  'RED (attack): assume the change is hostile. Hunt production killers — races, auth holes, data loss, silent fail. Prefer over-calling; blue + refuters will kill FPs. Output severity + file:line + 1-line repro. Enforce const-only bindings with a concrete immutable rewrite when reassignment exists.'
const BLUE_CHARTER =
  'BLUE (defense): assume the author is competent. Only report defects you can reproduce from the code. Challenge red overclaims. Same schema: severity + file:line + evidence. For const-only findings, require a viable immutable rewrite rather than a keyword-only suggestion.'

export function buildNextAction(
  ledger: JudgmentLedger | null,
  intensity: ReviewIntensity
): NextActionCard {
  const requestedBudget = reviewBudgetFor(intensity)
  if (intensity === 'skip' && !ledger) {
    return {
      kind: 'skip_ship',
      directive: 'Intensity skip — ship without judgment tax.',
      steps: ['prjct ship'],
      intensity,
      fixRound: 0,
      maxFixRounds: 0,
      counts: emptyCounts(),
      rankedFixIds: [],
      budget: requestedBudget,
    }
  }

  if (!ledger) {
    return {
      kind: 'open_ledger',
      directive: `Open a judgment ledger (intensity=${intensity}).`,
      steps: ['prjct judgment open', 'prjct judgment next'],
      intensity,
      fixRound: 0,
      maxFixRounds: MAX_FIX_ROUNDS,
      counts: emptyCounts(),
      rankedFixIds: [],
      judgeCharters: intensity === 'full' ? { red: RED_CHARTER, blue: BLUE_CHARTER } : undefined,
      budget: requestedBudget,
    }
  }

  const counts = countStatuses(ledger.findings)
  const ranked = rankFindingsForFix(ledger.findings)
  const base = {
    intensity: ledger.intensity,
    fixRound: ledger.fixRound,
    maxFixRounds: ledger.maxFixRounds,
    counts,
    rankedFixIds: ranked.map((f) => f.id),
    judgeCharters:
      ledger.intensity === 'full' ? { red: RED_CHARTER, blue: BLUE_CHARTER } : undefined,
    budget: reviewBudgetFor(ledger.intensity),
  }

  if (ledger.verdict === 'escalated') {
    return {
      ...base,
      kind: 'escalate',
      directive: `ESCALATED: ${ledger.escalateReason ?? 'judges contradict'}. Surface to user.`,
      steps: ['Present both judge verdicts to the user', 'Do not ship'],
    }
  }

  if (ledger.verdict === 'approved') {
    return {
      ...base,
      kind: 'approve',
      directive: 'Ledger APPROVED — ship is clear for judgment gate.',
      steps: ['prjct ship'],
    }
  }

  // Zero findings → reviewers have not reported (empty ≠ clean)
  if (ledger.findings.length === 0) {
    return {
      ...base,
      kind: 'dispatch_reviewers',
      directive:
        ledger.intensity === 'full'
          ? 'Dispatch RED + BLUE in parallel for one bounded pass over complementary risk charters. Then prjct judgment merge. If both find nothing: prjct judgment approve and STOP.'
          : 'Dispatch ONE focused reviewer for one bounded pass. Record findings with prjct judgment add, or approve and STOP if clean.',
      steps:
        ledger.intensity === 'full'
          ? [
              'Spawn RED judge (attack charter) + BLUE judge (defense charter) in parallel',
              "prjct judgment merge --red '[...]' --blue '[...]'",
              'prjct judgment next',
            ]
          : [
              'Spawn one fresh-context reviewer',
              'prjct judgment add --severity … --title … --file … --line …',
              'prjct judgment challenge --verdicts …',
            ],
    }
  }

  if (counts.candidates > 0 && counts.stands === 0 && counts.fixed === 0) {
    return {
      ...base,
      kind: 'dispatch_refuters',
      directive: `Use one batched challenger for all ${counts.candidates} candidate(s) — never per-finding tasks or a second panel.`,
      steps: [
        'Spawn ONE batched challenger over ALL candidates',
        'prjct judgment challenge --verdicts id:stands|refuted[,…]',
        'prjct judgment next',
      ],
    }
  }

  if (counts.stands > 0 || counts.open > 0) {
    if (ledger.fixRound >= ledger.maxFixRounds) {
      return {
        ...base,
        kind: 'blocked_budget',
        directive: 'Convergence budget exhausted with leftovers — report open, no round 3.',
        steps: [
          'prjct judgment fix-round  # marks leftovers open',
          'Surface open findings to user or escalate',
        ],
      }
    }
    const top = ranked
      .slice(0, 5)
      .map((f) => `${f.id}(${f.severity})`)
      .join(', ')
    return {
      ...base,
      kind: 'fix_ranked',
      directive: `Fix blast-ranked stands (${counts.stands} open). Top: ${top || '—'}`,
      steps: [
        `prjct judgment fix-round`,
        `Implementer fixes ONLY stands — order: ${base.rankedFixIds.join(' → ') || '—'}`,
        `prjct judgment fixed ${base.rankedFixIds.join(' ')}`,
        'prjct judgment brief  # scoped re-judge',
        `prjct judgment verify ${base.rankedFixIds.join(' ')}`,
      ],
    }
  }

  if (counts.fixed > 0) {
    return {
      ...base,
      kind: 'rejudge_scoped',
      directive: `Re-judge ${counts.fixed} fixed finding(s) with scoped brief only.`,
      steps: [
        'prjct judgment brief',
        'Fresh judge on ledger+fix-diff only',
        `prjct judgment verify <ids>`,
        'prjct judgment approve',
      ],
    }
  }

  // Clean or only info/refuted/verified
  if (computeVerdict(ledger) === 'approved') {
    return {
      ...base,
      kind: 'approve',
      directive: 'Clean ledger — approve and ship.',
      steps: ['prjct judgment approve', 'prjct ship'],
    }
  }

  return {
    ...base,
    kind: 'idle',
    directive: 'Ledger in progress — run prjct judgment status.',
    steps: ['prjct judgment status', 'prjct judgment next'],
  }
}

function emptyCounts(): NextActionCard['counts'] {
  return {
    candidates: 0,
    stands: 0,
    refuted: 0,
    fixed: 0,
    verified: 0,
    info: 0,
    open: 0,
    ghosts: 0,
  }
}

function countStatuses(findings: JudgmentFinding[]): NextActionCard['counts'] {
  const c = emptyCounts()
  for (const f of findings) {
    if (f.status === 'candidate') c.candidates++
    else if (f.status === 'stands') c.stands++
    else if (f.status === 'refuted') c.refuted++
    else if (f.status === 'fixed') c.fixed++
    else if (f.status === 'verified') c.verified++
    else if (f.status === 'info') c.info++
    else if (f.status === 'open') c.open++
    if (f.knownFalsePositive) c.ghosts++
  }
  return c
}

// ── Protocol card ───────────────────────────────────────────────────────────

export function intensityProtocol(intensity: ReviewIntensity): {
  intensity: ReviewIntensity
  reviewers: string
  refuters: string
  severityFloor: string
  evidenceTax: string
  maxFixRounds: number
  shipExpectation: string
  redCharter?: string
  blueCharter?: string
  maxReviewAgentsPerStage: number
} {
  switch (intensity) {
    case 'skip':
      return {
        intensity,
        reviewers: 'none — trivial/docs-only changeset',
        refuters: 'none',
        severityFloor: 'n/a',
        evidenceTax: 'n/a',
        maxFixRounds: 0,
        shipExpectation: 'ship without judgment ledger',
        maxReviewAgentsPerStage: 0,
      }
    case 'standard':
      return {
        intensity,
        reviewers: 'exactly ONE focused review pass (fresh-context subagent)',
        refuters: 'exactly ONE batched refuter over all BLOCKER/CRITICAL candidates',
        severityFloor:
          'only verified BLOCKER/CRITICAL enter fix loops; WARNING/SUGGESTION = info once',
        evidenceTax: 'blocker without file:line demoted to critical; title-only critical → info',
        maxFixRounds: MAX_FIX_ROUNDS,
        shipExpectation: 'ledger verdict approved (or --no-spec-gate override)',
        maxReviewAgentsPerStage: 1,
      }
    case 'full':
      return {
        intensity,
        reviewers:
          'dual-blind RED (attack) + BLUE (defense) in parallel — merge via prjct judgment merge',
        refuters:
          'exactly one batched challenger over all candidates; fail-closed missing vote stands',
        severityFloor:
          'only verified BLOCKER/CRITICAL enter fix loops; WARNING/SUGGESTION = info once',
        evidenceTax: 'blocker without file:line demoted to critical; title-only critical → info',
        maxFixRounds: MAX_FIX_ROUNDS,
        shipExpectation: 'ledger verdict approved after ≤2 fix rounds (or escalate)',
        redCharter: RED_CHARTER,
        blueCharter: BLUE_CHARTER,
        maxReviewAgentsPerStage: MAX_REVIEW_AGENTS_PER_STAGE,
      }
  }
}

// ── Ship gate ───────────────────────────────────────────────────────────────

export interface JudgmentShipInput {
  codeStrict: boolean
  intensity: ReviewIntensity
  ledger: JudgmentLedger | null
  override: boolean
}

export interface JudgmentShipVerdict {
  blocked: boolean
  mode: 'none' | 'soft' | 'hard'
  message: string
  reason:
    | 'skip-intensity'
    | 'override'
    | 'missing-ledger'
    | 'in-progress'
    | 'blocked-findings'
    | 'escalated'
    | 'approved'
    | 'soft-reminder'
}

export function judgmentShipVerdict(input: JudgmentShipInput): JudgmentShipVerdict {
  const { codeStrict, intensity, ledger, override } = input

  if (override) {
    return { blocked: false, mode: 'none', message: '', reason: 'override' }
  }

  if (intensity === 'skip') {
    return { blocked: false, mode: 'none', message: '', reason: 'skip-intensity' }
  }

  if (!ledger) {
    const dual = intensity === 'full' ? ' Dual-blind RED+BLUE required (code-strict default).' : ''
    const msg =
      `Precision judgment required (intensity=${intensity}): run \`prjct judgment plan\` → ` +
      `\`prjct judgment open\` → follow \`prjct judgment next\`.${dual} ` +
      `Override only with explicit consent: \`prjct ship --no-judgment-gate\`.`
    if (codeStrict) {
      return { blocked: true, mode: 'hard', message: msg, reason: 'missing-ledger' }
    }
    return { blocked: false, mode: 'soft', message: `⚖️  ${msg}`, reason: 'soft-reminder' }
  }

  const v = computeVerdict(ledger)

  if (v === 'approved') {
    const prec =
      ledger.precisionHint !== undefined
        ? `, precision≈${Math.round(ledger.precisionHint * 100)}%`
        : ''
    return {
      blocked: false,
      mode: 'none',
      message: `⚖️  judgment ${ledger.id.slice(0, 8)} → APPROVED (intensity=${ledger.intensity}, rounds=${ledger.fixRound}/${ledger.maxFixRounds}${prec})`,
      reason: 'approved',
    }
  }

  if (v === 'escalated') {
    const msg = `Judgment escalated: ${ledger.escalateReason ?? 'judges contradict'}. Resolve with the user before ship.`
    if (codeStrict) {
      return { blocked: true, mode: 'hard', message: msg, reason: 'escalated' }
    }
    return { blocked: false, mode: 'soft', message: `⚖️  ${msg}`, reason: 'escalated' }
  }

  if (v === 'blocked') {
    const open = [
      ...actionableOpen(ledger.findings),
      ...ledger.findings.filter((f) => f.status === 'open'),
    ]
    const titles = open
      .slice(0, 5)
      .map((f) => `${f.severity}:${f.title}`)
      .join('; ')
    const msg =
      `Judgment blocked — open actionable (${open.length}): ${titles || 'see ledger'}. ` +
      `Fix blast-ranked + re-judge (≤${MAX_FIX_ROUNDS} rounds) or escalate. → \`prjct judgment next\``
    if (codeStrict) {
      return { blocked: true, mode: 'hard', message: msg, reason: 'blocked-findings' }
    }
    return { blocked: false, mode: 'soft', message: `⚖️  ${msg}`, reason: 'blocked-findings' }
  }

  const msg =
    `Judgment in progress (round ${ledger.fixRound}/${ledger.maxFixRounds}, ` +
    `${ledger.findings.length} findings). → \`prjct judgment next\``
  if (codeStrict) {
    return { blocked: true, mode: 'hard', message: msg, reason: 'in-progress' }
  }
  return { blocked: false, mode: 'soft', message: `⚖️  ${msg}`, reason: 'in-progress' }
}

// ── Dedup on add ────────────────────────────────────────────────────────────

/**
 * Insert a finding with DNA dedup: same DNA upgrades severity/evidence if richer,
 * otherwise no-op (returns existing id).
 */
export function upsertFinding(
  findings: JudgmentFinding[],
  incoming: JudgmentFinding
): { findings: JudgmentFinding[]; finding: JudgmentFinding; deduped: boolean } {
  const f = applySeverityFloor(incoming)
  const dna = f.dna ?? findingDna(f)
  const idx = findings.findIndex((x) => (x.dna ?? findingDna(x)) === dna)
  if (idx < 0) {
    const next = { ...f, dna }
    return { findings: [...findings, next], finding: next, deduped: false }
  }
  const prev = findings[idx]!
  // Keep stronger severity + richer evidence
  const merged: JudgmentFinding = applySeverityFloor({
    ...prev,
    severity: SEV_WEIGHT[f.severity] > SEV_WEIGHT[prev.severity] ? f.severity : prev.severity,
    title: f.title.length >= prev.title.length ? f.title : prev.title,
    file: f.file ?? prev.file,
    line: f.line ?? prev.line,
    evidence: (f.evidence?.length ?? 0) > (prev.evidence?.length ?? 0) ? f.evidence : prev.evidence,
    judge: [prev.judge, f.judge].filter(Boolean).join('+') || prev.judge,
    agreedBy: [
      ...new Set(
        [...(prev.agreedBy ?? []), ...(f.agreedBy ?? []), f.judge].filter(Boolean) as string[]
      ),
    ],
    dna,
  })
  const out = [...findings]
  out[idx] = merged
  return { findings: out, finding: merged, deduped: true }
}

// ── Scope freeze (gentle-ai v1.49 — immutable git path set) ─────────────────

/** Normalize repo-relative paths for scope membership (posix, no leading ./). */
export function normalizeScopePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '').trim()
}

/**
 * True when `file` is inside the frozen scope.
 * Empty/undefined scope → no freeze (everything in-scope) for backward compat.
 * Findings without a file stay in-scope (evidence tax already demotes vibes blockers).
 */
export function pathInScope(
  file: string | undefined,
  scopePaths: readonly string[] | undefined
): boolean {
  if (!scopePaths || scopePaths.length === 0) return true
  if (!file || !file.trim()) return true
  const f = normalizeScopePath(file)
  if (!f) return true
  for (const raw of scopePaths) {
    const s = normalizeScopePath(raw)
    if (!s) continue
    if (f === s || f.startsWith(`${s}/`)) return true
  }
  return false
}

/**
 * Demote out-of-scope findings to non-blocking follow-up (`info`).
 * Does not invent new severities — preserves title/file for the follow-up trail.
 */
export function applyScopeFreeze(
  finding: JudgmentFinding,
  scopePaths: readonly string[] | undefined
): JudgmentFinding {
  if (pathInScope(finding.file, scopePaths)) return finding
  if (finding.status === 'info' || finding.status === 'refuted') return finding
  return {
    ...finding,
    status: 'info',
    evidence:
      (finding.evidence ? `${finding.evidence} · ` : '') +
      'out of frozen review scope (follow-up only; does not enter fix loops or block ship)',
  }
}

export function applyScopeFreezeAll(
  findings: JudgmentFinding[],
  scopePaths: readonly string[] | undefined
): JudgmentFinding[] {
  return findings.map((f) => applyScopeFreeze(f, scopePaths))
}

/**
 * Whether a finding may enter fix rounds / be marked fixed under the freeze.
 * In-scope (or no freeze) only.
 */
export function findingInFixScope(
  finding: Pick<JudgmentFinding, 'file' | 'status'>,
  scopePaths: readonly string[] | undefined
): boolean {
  if (finding.status === 'info' || finding.status === 'refuted') return false
  return pathInScope(finding.file, scopePaths)
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function newFindingId(): string {
  return `jf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function newLedgerId(): string {
  return `jl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function createLedger(input: {
  target: string
  intensity: ReviewIntensity
  deliveryTier?: DeliveryTier
  baseSha?: string
  headSha?: string
  now: string
  /** Git path set frozen at open — empty/omit = no freeze. */
  scopePaths?: string[]
}): JudgmentLedger {
  const scope =
    input.scopePaths && input.scopePaths.length > 0
      ? [...new Set(input.scopePaths.map(normalizeScopePath).filter(Boolean))]
      : undefined
  return {
    id: newLedgerId(),
    target: input.target,
    intensity: input.intensity,
    maxFixRounds: MAX_FIX_ROUNDS,
    fixRound: 0,
    findings: [],
    verdict: 'in_progress',
    createdAt: input.now,
    updatedAt: input.now,
    baseSha: input.baseSha,
    headSha: input.headSha,
    deliveryTier: input.deliveryTier,
    scopePaths: scope,
    scopeFrozenAt: scope ? input.now : undefined,
  }
}
