/**
 * Provider-aware dispatch (harness pillars 3 + 5): the multi-agent
 * architecture runs on any rig — native subagents on Claude, emulated
 * fresh-context fan-out elsewhere. It never names a model: subagents inherit
 * whatever the user is driving. Provider is pinned for determinism (no CLI
 * detection).
 */

import { describe, expect, it } from 'bun:test'
import { buildEmulatedCrewProtocol, resolveDispatchMechanism } from '../../services/agent-dispatch'

describe('resolveDispatchMechanism', () => {
  it('uses native subagents on a Claude rig', async () => {
    const m = await resolveDispatchMechanism('claude')
    expect(m.native).toBe(true)
    expect(m.runLine(3)).toContain('via the Agent tool')
  })

  it('emulates the fan-out on a non-Claude rig', async () => {
    const m = await resolveDispatchMechanism('gemini')
    expect(m.native).toBe(false)
    expect(m.runLine(3)).toContain('EMULATE the fan-out')
    expect(m.runLine(1)).toContain('no native subagent tool')
  })

  it('exposes no model-directive surface at all', async () => {
    const m = await resolveDispatchMechanism('claude')
    expect('modelDirective' in m).toBe(false)
  })
})

describe('dispatch text never caps the model', () => {
  // The harness used to pin opus/sonnet/haiku per role and tell every
  // non-implementer to "apply decent, not exhaustive, effort". That made the
  // rig dumber than the brain the user pays for. Nothing may reintroduce it.
  const FORBIDDEN = [
    'model: "opus"',
    'model: "sonnet"',
    'model: "haiku"',
    'over-deliberate',
    'not exhaustive',
    "NOT the parent's max model",
    'max-tier',
    'mid-tier',
  ]

  it.each(['claude', 'gemini', 'cursor'] as const)('is clean on %s', async (provider) => {
    const m = await resolveDispatchMechanism(provider)
    const emitted = [m.runLine(1), m.runLine(3), buildEmulatedCrewProtocol(m, '')].join('\n')
    for (const needle of FORBIDDEN) expect(emitted).not.toContain(needle)
  })
})
