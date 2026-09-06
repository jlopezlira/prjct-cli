/**
 * Policy table: the evidence-backed defaults (silence on SELF_CONTAINED, inject
 * on knowledge, ranked on exploration, verify contract on VERIFY), UNKNOWN
 * never silenced, and per-project overrides winning last.
 */

import { describe, expect, it } from 'bun:test'
import { resolvePolicy } from '../../services/harness-policy'

describe('resolvePolicy', () => {
  it('silences SELF_CONTAINED and injects knowledge', () => {
    const self = resolvePolicy('haiku', 'SELF_CONTAINED')
    expect(self.promptLane).toBe('silent')
    expect(self.maxInjectChars).toBe(0)

    const know = resolvePolicy('haiku', 'PROJECT_KNOWLEDGE')
    expect(know.promptLane).toBe('inject')
    expect(know.maxInjectChars).toBeGreaterThan(0)
  })

  it('hands EXPLORATION a ranked set and gives VERIFY the contract', () => {
    expect(resolvePolicy('sonnet', 'EXPLORATION').promptLane).toBe('ranked')
    expect(resolvePolicy('sonnet', 'VERIFY').verifyContract).toBe(true)
  })

  it('never silences UNKNOWN — it falls back to inject', () => {
    expect(resolvePolicy('grok', 'UNKNOWN').promptLane).toBe('inject')
  })

  it('lets a project override win last', () => {
    const cfg = { harness: { policy: { SELF_CONTAINED: { promptLane: 'inject' as const } } } }
    expect(resolvePolicy('haiku', 'SELF_CONTAINED', cfg).promptLane).toBe('inject')
    // Untouched fields keep the baseline.
    expect(resolvePolicy('haiku', 'SELF_CONTAINED', cfg).verifyContract).toBe(false)
  })
})
