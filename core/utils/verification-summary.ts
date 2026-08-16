/**
 * Verification Summary
 *
 * Shared tally + wrapping logic for "run a batch of pass/fail checks and
 * report totals" flows (semantic analysis verification, sync verification).
 */

export interface VerificationSummary<T extends { passed: boolean }> {
  passed: boolean
  checks: T[]
  totalMs: number
  failedCount: number
  passedCount: number
}

/**
 * Tally a list of `{passed}` checks into a summary report.
 * `totalStart` is the `Date.now()` captured before the checks ran.
 */
export function summarizeChecks<T extends { passed: boolean }>(
  checks: T[],
  totalStart: number
): VerificationSummary<T> {
  const failedCount = checks.filter((c) => !c.passed).length
  const passedCount = checks.filter((c) => c.passed).length

  return {
    passed: failedCount === 0,
    checks,
    totalMs: Date.now() - totalStart,
    failedCount,
    passedCount,
  }
}
