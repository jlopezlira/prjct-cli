/**
 * Budget discipline adopted from deepseek-harness.
 *
 * Two properties this pins:
 *  - a cycle budget is DERIVED from the model's context window, so measuring
 *    real tokens is useful without anyone configuring `maxTokensPerCycle`;
 *  - injected guidance keeps its tail, because that is where the action is.
 */

import { describe, expect, it } from 'bun:test'
import { safeTruncate } from '../../hooks/_shared'
import { contextPressureVerdict } from '../../services/context-pressure'
import { contextWindowFor } from '../../tools/context/token-counter'

const task = (tokensIn: number, model?: string) =>
  ({
    turnCount: 3,
    tokensIn,
    tokensOut: 0,
    description: 'x',
    ...(model ? { modelMetadata: { model } } : {}),
  }) as never

describe('contextWindowFor', () => {
  it('knows the Claude 5 family', () => {
    expect(contextWindowFor('claude-opus-5')).toBe(1_000_000)
    expect(contextWindowFor('claude-sonnet-5')).toBe(1_000_000)
    expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000)
  })

  // Rigs report decorated ids; an exact-only lookup would silently return null
  // and leave the budget underived for the common case.
  it('resolves decorated ids reported by real rigs', () => {
    expect(contextWindowFor('claude-opus-5-20260114')).toBe(1_000_000)
    expect(contextWindowFor('anthropic.claude-opus-5')).toBe(1_000_000)
    expect(contextWindowFor('CLAUDE-OPUS-5')).toBe(1_000_000)
  })

  it('returns null for anything it does not know', () => {
    expect(contextWindowFor('llama-3-70b')).toBeNull()
    expect(contextWindowFor('')).toBeNull()
    expect(contextWindowFor(undefined)).toBeNull()
  })
})

describe('cycle budget derives from the model', () => {
  it('derives 80% of the context window when none is configured', () => {
    const v = contextPressureVerdict({} as never, task(10_000, 'claude-opus-5'))
    expect(v.limit).toBe(800_000)
    expect(v.limitSource).toBe('model')
    expect(v.level).toBe('ok')
  })

  it('warns once measured spend crosses the derived threshold', () => {
    const v = contextPressureVerdict({} as never, task(500_000, 'claude-opus-5'))
    expect(v.level).toBe('warn')
    expect(v.cue).toContain('token budget')
    expect(v.cue).toContain('Derived from the context window')
  })

  it('sizes a smaller window correctly', () => {
    const v = contextPressureVerdict({} as never, task(1_000, 'claude-haiku-4-5'))
    expect(v.limit).toBe(160_000)
  })

  it('a configured budget still wins', () => {
    const v = contextPressureVerdict(
      { maxTokensPerCycle: 50_000 } as never,
      task(40_000, 'claude-opus-5')
    )
    expect(v.limit).toBe(50_000)
    expect(v.limitSource).toBe('configured')
    expect(v.cue).toContain('The budget you configured')
  })

  it('stays silent on an unknown model — no capacity, no cue', () => {
    const v = contextPressureVerdict({} as never, task(900_000, 'some-local-model'))
    expect(v.level).toBe('ok')
    expect(v.cue).toBeNull()
    expect(v.limitSource).toBe('none')
  })

  // The cue must never regress into telling the model to stop reading code.
  it('never forbids reading code, even at the derived critical threshold', () => {
    const v = contextPressureVerdict({} as never, task(900_000, 'claude-opus-5'))
    expect(v.level).toBe('critical')
    for (const banned of ['do not re-index', 'no broad Grep', 'high-signal tools only']) {
      expect(v.cue?.toLowerCase()).not.toContain(banned.toLowerCase())
    }
  })
})

describe('safeTruncate keeps the tail when asked', () => {
  const body = `${'HEAD '.repeat(40)}${'middle '.repeat(200)}ACTION: run prjct guard first.`

  it('head-only by default — unchanged for existing callers', () => {
    const out = safeTruncate(body, 200)
    expect(out).toContain('HEAD')
    expect(out).not.toContain('ACTION: run prjct guard first.')
  })

  it('retains the closing action when a tail budget is given', () => {
    const out = safeTruncate(body, 200, '\n… [truncated]', 50)
    expect(out).toContain('HEAD')
    expect(out).toContain('ACTION: run prjct guard first.')
    expect(out).toContain('[truncated]')
    expect(out.length).toBeLessThanOrEqual(200)
  })

  it('never splits a surrogate pair at either cut', () => {
    const emoji = '🚀'
    const s = `${emoji.repeat(200)}TAIL${emoji.repeat(200)}`
    for (const tail of [0, 20, 41]) {
      const out = safeTruncate(s, 120, '…', tail)
      expect(out).toBe([...out].join(''))
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)
      ).toBe(false)
    }
  })

  it('short input is returned untouched', () => {
    expect(safeTruncate('short', 200, '…', 50)).toBe('short')
  })
})

describe('better than the source it was adapted from', () => {
  // deepseek's pruner is code-point budgeted and its docs accept that a cut
  // "can split a multi-code-point grapheme cluster". The budget is a ceiling,
  // not a target, so landing on a boundary is free — and a tail that opens
  // mid-word ("he queue") reads as corruption.
  const body =
    'Guard core/daemon/request-loop.ts before editing because the dispatcher assumes a single writer thread and concurrent edits corrupt the queue. ACTION: run prjct guard first.'

  it('cuts on word boundaries at BOTH ends, not mid-word', () => {
    const out = safeTruncate(body, 120, '\n… [truncated]', 40)
    const [head, tail] = out.split('\n… [truncated]')
    expect(head).toBeTruthy()
    expect(tail).toBeTruthy()
    // Every retained word must be a real word from the source.
    for (const word of `${head} ${tail}`.split(/\s+/).filter(Boolean)) {
      expect(body).toContain(word)
    }
  })

  it('is idempotent — a second pass changes nothing', () => {
    const once = safeTruncate(body, 120, '\n… [truncated]', 40)
    expect(safeTruncate(once, 120, '\n… [truncated]', 40)).toBe(once)
  })

  it('still respects the ceiling', () => {
    expect(safeTruncate(body, 120, '\n… [truncated]', 40).length).toBeLessThanOrEqual(120)
  })

  // Silence is how a measurement feature goes dark. deepseek warns once per
  // target; so must we.
  it('names a model it cannot size instead of going quiet', () => {
    const v = contextPressureVerdict({} as never, task(500_000, 'some-new-model-9'))
    expect(v.limitSource).toBe('none')
    expect(v.unknownModel).toBe('some-new-model-9')
  })

  it('reports no unknown model when one was configured or resolved', () => {
    expect(
      contextPressureVerdict({} as never, task(10, 'claude-opus-5')).unknownModel
    ).toBeUndefined()
    expect(
      contextPressureVerdict({ maxTokensPerCycle: 1000 } as never, task(10, 'weird')).unknownModel
    ).toBeUndefined()
  })
})
