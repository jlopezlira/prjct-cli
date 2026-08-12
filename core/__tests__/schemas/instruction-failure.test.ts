import { describe, expect, it } from 'bun:test'
import { InstructionFailureInputSchema } from '../../schemas/instruction-failure'

describe('InstructionFailureInputSchema', () => {
  const valid = {
    source: 'friction-detector',
    runtime: 'codex',
    model: 'gpt-5',
    sessionId: 'session-1',
    taskId: 'task-1',
    category: 'scope-creep',
    expectedBehavior: 'Keep the original task scope.',
    observedBehavior: 'Added an unrelated refactor.',
    relatedRuleId: 'rule-scope',
  }

  it('accepts the complete typed ledger boundary', () => {
    expect(InstructionFailureInputSchema.parse(valid)).toEqual(valid)
  })

  it('rejects raw transcript payloads and invalid dispositions', () => {
    expect(() =>
      InstructionFailureInputSchema.parse({ ...valid, transcript: 'raw conversation' })
    ).toThrow()
    expect(() =>
      InstructionFailureInputSchema.parse({ ...valid, disposition: 'ignored' })
    ).toThrow()
  })
})
