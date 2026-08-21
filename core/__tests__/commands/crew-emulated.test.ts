/**
 * Emulated crew on a non-Claude rig (harness pillar 3).
 *
 * Claude gets native `.claude/agents/` subagents; every other rig has no
 * subagent tool, so `prjct crew install` writes an EMULATED protocol — one
 * agent plays leader/implementer/reviewer in fresh passes with the per-role
 * model from the policy. Provider is pinned for determinism.
 */

import { describe, expect, it } from 'bun:test'
import { buildEmulatedCrewProtocol, resolveDispatchMechanism } from '../../services/agent-dispatch'

describe('emulated crew protocol', () => {
  it('composes specialists (not a fixed trio) with checkpoints, naming no model', async () => {
    const m = await resolveDispatchMechanism('gemini')
    const proto = buildEmulatedCrewProtocol(m, 'Tests must pass; no stray console.log.')

    expect(proto).toContain('emulated on gemini')
    expect(proto).toContain('composed per task, not a fixed trio')
    expect(proto).toContain('Leader')
    expect(proto).toContain('Implementer')
    // Review is a DYNAMIC specialist panel, not one generic reviewer.
    expect(proto).toContain('Review specialists')
    expect(proto).toContain('architecture') // floor lens
    for (const lens of ['security', 'data', 'performance', 'design', 'strategic']) {
      expect(proto).toContain(lens)
    }
    // No role is routed to a model — every one inherits the user's.
    for (const model of ['3.1-pro', '2.0-flash', '2.5-flash']) {
      expect(proto).not.toContain(model)
    }
    expect(proto).toContain('Tests must pass') // checkpoints embedded
    expect(proto).toContain('prjct crew record-run')
    expect(proto).toContain('VERDICT: APPROVED')
  })

  it('hints when no checkpoints are set, and never prescribes a model', async () => {
    const m = await resolveDispatchMechanism('cursor')
    const proto = buildEmulatedCrewProtocol(m, '   ')
    expect(proto).toContain('No project checkpoints set')
    expect(proto).not.toContain('select your strongest model')
    expect(proto).not.toContain('model:')
  })
})
