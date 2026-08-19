/**
 * Token-cost release gate — pins the measured cost of prjct's injected
 * context across EVERY emission surface (universal delivery gate cycle).
 *
 * v3.99 baseline (2026-08-19, full-harness bench, this fixture):
 *   claude: 70,932 chars · M 7,263,620 (prompt 47/50 · 57,998; pre-search
 *           25/25 · 7,867 — zero dedup; SessionStart compact re-sent 1,628)
 *   kimi:   27,420 chars · M 3,615,316   codex: 27,416 · M 3,619,032
 *
 * After the universal delivery gate + pull-first (same day):
 *   claude: 13,420 chars (−81%) · M 2,754,576 (−62%)
 *   kimi:   13,980 chars (−49%) · M 1,976,408 (−45%)
 *   codex:  13,420 chars (−51%) · M 1,922,376 (−47%)
 *   prompt-only 50-turn (all hosts): 17/50 · 4,011 chars
 *     (kimi M 1,520,592 → 663,464, −56% vs the v3.99 lean+delta result)
 *   catalog: micro 756 chars / 1 tool (lean 3,078 / core 4,917)
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
    expect(core.totalChars).toBeLessThanOrEqual(5_400)
  })

  it('lean ListTools catalog stays a fallback under its budget', () => {
    const lean = measureListTools('lean')
    expect(lean.toolCount).toBe(6)
    expect(lean.totalChars).toBeLessThanOrEqual(3_400)
  })

  it('micro ListTools is ONE dispatch tool under 830 chars', () => {
    const micro = measureListTools('micro')
    expect(micro.toolCount).toBe(1)
    // Measured 756 — the whole catalog non-caching hosts re-pay per call.
    expect(micro.totalChars).toBeLessThanOrEqual(830)
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

  it('50-turn kimi prompt session holds the event-only cut', async () => {
    const session = await simulateSession('kimi', 50)
    expect(session.turns).toBe(50)
    // Measured 4,011 chars over 17/50 turns (was 8,094 · 17/50 on v3.99).
    expect(session.totalChars).toBeLessThanOrEqual(4_500)
    expect(session.emittedTurns).toBeLessThanOrEqual(20)
    const replay = replayWeighted(session, measureListTools('micro'))
    // Measured M: 663,464 char-calls (v3.99: 1,520,592 → −56%).
    expect(replay.totalCharCalls).toBeLessThanOrEqual(750_000)
  }, 120_000)

  it('50-turn claude prompt session holds the same event-only cut', async () => {
    const session = await simulateSession('claude', 50)
    // Measured 17/50 · 4,011 chars (v3.99 baseline: 47/50 · 42,232 — the
    // whole-payload dedupe re-emitted on every counter byte).
    expect(session.totalChars).toBeLessThanOrEqual(4_500)
    expect(session.emittedTurns).toBeLessThanOrEqual(20)
  }, 120_000)

  it('claude full-harness session holds the −80% chars / −60% M cut', async () => {
    const cost = await simulateHarnessSession('claude', 50)
    // Measured 13,420 chars (baseline 70,932 → 0.19×) and M 2,754,576
    // (baseline 7,263,620 → 0.38×; the residual is the core catalog term,
    // which Anthropic prefix-caches in reality — M charges it flat).
    expect(cost.totalChars).toBeLessThanOrEqual(15_000)
    expect(cost.totalCharCalls).toBeLessThanOrEqual(3_050_000)
    // SessionStart: cold block dieted; compact is a ≤350-char re-anchor.
    expect(cost.sessionStart.startupChars).toBeLessThanOrEqual(1_300)
    expect(cost.sessionStart.compactChars).toBeLessThanOrEqual(350)
    // pre-search dedups: 3 distinct tokens → ≤5 emissions over 25 events.
    expect(cost.preSearch.emitted).toBeLessThanOrEqual(5)
  }, 180_000)

  it('kimi full-harness session holds the cut for non-caching hosts', async () => {
    const cost = await simulateHarnessSession('kimi', 50)
    // Measured 13,980 chars · M 1,976,408 (baseline 27,420 · 3,615,316).
    expect(cost.totalChars).toBeLessThanOrEqual(15_500)
    expect(cost.totalCharCalls).toBeLessThanOrEqual(2_200_000)
  }, 180_000)
})
