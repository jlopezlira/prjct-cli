/**
 * One-breath install ritual (Dynasty D6).
 */

import { describe, expect, it } from 'bun:test'
import { buildOneBreathReport } from '../../services/one-breath-install'

describe('one-breath-install', () => {
  it('builds PASS ritual when organic board is live', () => {
    const r = buildOneBreathReport({
      claudeHooksNew: 2,
      claudeHooksPresent: 10,
      runtimesWired: ['claude', 'codex', 'gemini'],
      liveCount: 3,
      detectedCount: 3,
      organicPct: 100,
      deltaLine: 'Harness Δ: intent 30%→100% (+70pp) · PASS',
    })
    expect(r.organicOk).toBe(true)
    expect(r.line).toMatch(/One-breath install/)
    expect(r.line).toMatch(/PASS/)
    expect(r.md).toContain('Organic multi-runtime board')
    expect(r.md).toContain('Harness Δ proof')
    expect(r.steps).toHaveLength(5)
  })

  it('flags NEEDS doctor when organic is thin', () => {
    const r = buildOneBreathReport({
      claudeHooksNew: 0,
      claudeHooksPresent: 0,
      runtimesWired: [],
      liveCount: 0,
      detectedCount: 3,
      organicPct: 0,
    })
    expect(r.organicOk).toBe(false)
    expect(r.line).toMatch(/doctor --fix/)
  })
})
