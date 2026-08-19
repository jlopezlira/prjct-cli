/**
 * Token-cost release gate — pins the measured cost of prjct's injected
 * context for non-caching hosts (Kimi/Codex).
 *
 * Baseline (2026-08-19, pre-optimization):
 *   ListTools core:      4,996 chars (10 tools)
 *   50-turn session:     47/50 emitted turns · 42,232 chars
 *   Replay-weighted M:   4,597,476 char-calls (≈1.15M token-calls)
 *
 * After lean tier + delta emission (same day):
 *   ListTools lean:      3,052 chars (6 tools)      −39%
 *   50-turn kimi:        17/50 turns · 8,094 chars  −81%
 *   Replay-weighted M:   1,520,592 char-calls       −67%
 *
 * Ceilings sit ~10% above the optimized numbers — a red here means the token
 * cost crept back up. Never raise a ceiling without a measured decision.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import {
  measureListTools,
  replayWeighted,
  simulateHarnessSession,
  simulateSession,
} from '../../services/token-cost-bench'

afterEach(() => {
  delete process.env.PRJCT_MCP_TOOLS
})

describe('token-cost bench (release ceilings)', () => {
  it('core ListTools catalog stays within the measured baseline', () => {
    const core = measureListTools('core')
    expect(core.toolCount).toBeGreaterThanOrEqual(8)
    expect(core.totalChars).toBeLessThanOrEqual(5100)
  })

  it('lean ListTools catalog holds the ≥35% cut vs the recorded core baseline', () => {
    const lean = measureListTools('lean')
    expect(lean.toolCount).toBe(6)
    // 4,996-char core baseline × 0.65 ≈ 3,250 — the ≥35% claim stays proven.
    expect(lean.totalChars).toBeLessThanOrEqual(3_250)
  })

  it('full-harness simulation measures every surface (smoke)', async () => {
    const cost = await simulateHarnessSession('claude', 10)
    expect(cost.turns).toBe(10)
    expect(cost.sessionStart.startupChars).toBeGreaterThan(0)
    expect(cost.prompt.perTurnChars.length).toBe(10)
    expect(cost.preSearch.events).toBe(5)
    expect(cost.preEdit.events).toBe(3)
    expect(cost.mcp.events).toBeGreaterThanOrEqual(2)
    expect(cost.totalChars).toBeGreaterThan(0)
    expect(cost.totalCharCalls).toBeGreaterThan(cost.totalChars)
  }, 120_000)

  it('50-turn kimi session holds the delta-emission cut', async () => {
    const session = await simulateSession('kimi', 50)
    expect(session.turns).toBe(50)
    // Measured 8,094 chars over 17/50 turns; ceiling ~10% above.
    expect(session.totalChars).toBeLessThanOrEqual(9_000)
    expect(session.emittedTurns).toBeLessThanOrEqual(22)
    const replay = replayWeighted(session, measureListTools('lean'))
    // Measured M: 1,520,592 char-calls (baseline 4,597,476 → −67%).
    expect(replay.totalCharCalls).toBeLessThanOrEqual(1_700_000)
  }, 120_000)
})
