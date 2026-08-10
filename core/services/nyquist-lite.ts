/**
 * Nyquist-lite — every acceptance criterion should name a verifiable signal
 * (test, command, or observable behavior). Soft gate at audit promote time:
 * we do not invent tests, we refuse silent "looks done" prose-only ACs when
 * code-strict / TDD strict asks for teeth.
 *
 * Verifiable heuristics (any match → ok):
 *   - mentions test / e2e / unit / integration / coverage
 *   - mentions command-like tokens (npm/bun/cargo/pytest/curl/http status)
 *   - contains a path-like segment ending in common test suffixes
 *   - contains checkbox-style measurable outcomes (returns 200, exits 0, etc.)
 */

const VERIFIABLE =
  /\b(test|tests|e2e|unit|integration|spec|coverage|assert|expect|jest|vitest|playwright|cypress|bun test|npm test|pytest|cargo test|go test|curl|http\s*[1-5]\d{2}|exit(s|ed)?\s*0|returns?\s+\d+|cli\b|command\b|verify|assert)\b/i

const PATHISH = /[\w./-]+\.(test|spec)\.[a-z]+/i

export function isVerifiableAcceptance(criterion: string): boolean {
  const t = criterion.trim()
  if (t.length < 8) return false
  return VERIFIABLE.test(t) || PATHISH.test(t)
}

export interface NyquistLiteReport {
  total: number
  verifiable: number
  vague: string[]
  /** True when every AC is verifiable (or there are none). */
  ok: boolean
  message: string | null
}

export function assessAcceptanceCriteria(criteria: string[]): NyquistLiteReport {
  const vague: string[] = []
  for (const c of criteria) {
    if (!isVerifiableAcceptance(c)) vague.push(c.slice(0, 120))
  }
  const verifiable = criteria.length - vague.length
  const total = criteria.length
  const ok = total === 0 || vague.length === 0
  const message = ok
    ? null
    : [
        `Nyquist-lite: ${vague.length}/${total} acceptance criteria lack a verifiable signal (test/command/observable).`,
        'Rewrite ACs to name how they are checked (e.g. `bun test core/foo`, `curl returns 200`).',
        ...vague.slice(0, 5).map((v) => `  - ${v}`),
      ].join('\n')
  return { total, verifiable, vague, ok, message }
}

export type NyquistWorkMode = 'off' | 'advisory' | 'strict'

export interface NyquistWorkVerdict {
  /** True → startTask must refuse until ACs are verifiable. */
  blocked: boolean
  /** Warning to print when advisory (or block message when blocked). */
  message: string | null
  reason: 'none' | 'h0-skip' | 'no-criteria' | 'ok' | 'advisory-vague' | 'strict-vague'
}

/**
 * Work-start Nyquist gate — SUPERIOR to promote-only check.
 * H2+ linked specs with vague ACs: advisory warns, strict blocks.
 * H0/H1 never block (smoke / trivial path).
 */
export function nyquistWorkVerdict(input: {
  harnessLevel: 'H0' | 'H1' | 'H2' | 'H3'
  criteria: string[]
  /** Effective mode: derived from sdd|tdd strict → strict, else advisory when any on. */
  mode: NyquistWorkMode
}): NyquistWorkVerdict {
  if (input.mode === 'off') {
    return { blocked: false, message: null, reason: 'none' }
  }
  if (input.harnessLevel === 'H0' || input.harnessLevel === 'H1') {
    return { blocked: false, message: null, reason: 'h0-skip' }
  }
  if (input.criteria.length === 0) {
    // No ACs listed — discuss-lock already required a reviewed spec; empty ACs
    // are a quality smell but not a hard block (avoid trapping empty templates).
    return { blocked: false, message: null, reason: 'no-criteria' }
  }
  const report = assessAcceptanceCriteria(input.criteria)
  if (report.ok) {
    return { blocked: false, message: null, reason: 'ok' }
  }
  const msg =
    report.message ??
    'Nyquist-lite: acceptance criteria need verifiable signals before H2+ implementation.'
  if (input.mode === 'strict') {
    return {
      blocked: true,
      message: `${msg}\nBlocked on H2+ work (strict). Fix ACs, re-audit, then \`prjct work --spec <id>\`.`,
      reason: 'strict-vague',
    }
  }
  return {
    blocked: false,
    message: `⚠️  ${msg}`,
    reason: 'advisory-vague',
  }
}

/** Map pack SDD/TDD modes → Nyquist work mode. */
export function effectiveNyquistWorkMode(
  sddMode: 'off' | 'advisory' | 'strict' | undefined,
  tddMode: 'off' | 'assist' | 'strict' | undefined
): NyquistWorkMode {
  if (sddMode === 'strict' || tddMode === 'strict') return 'strict'
  if (sddMode === 'advisory' || tddMode === 'assist') return 'advisory'
  return 'off'
}
