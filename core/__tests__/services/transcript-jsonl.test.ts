import { describe, expect, it } from 'bun:test'
import {
  identifyTranscriptModel,
  parseTranscriptJsonl,
  sumTranscriptUsage,
  sumTranscriptUsageDetailed,
} from '../../services/transcript-jsonl'

describe('sumTranscriptUsage', () => {
  it('sums input/output across assistant turns, counting cache reads/creations as input', () => {
    const lines = parseTranscriptJsonl(
      [
        JSON.stringify({ type: 'user', message: { role: 'user' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            usage: {
              input_tokens: 100,
              output_tokens: 40,
              cache_creation_input_tokens: 10,
              cache_read_input_tokens: 5,
            },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', usage: { input_tokens: 200, output_tokens: 60 } },
        }),
      ].join('\n')
    )

    const usage = sumTranscriptUsage(lines)
    expect(usage.tokensIn).toBe(100 + 10 + 5 + 200)
    expect(usage.tokensOut).toBe(40 + 60)
  })

  it('does not sum the cumulative cache_read prefix across turns (anti-inflation)', () => {
    // Claude re-reports the growing cached prefix each turn; summing it inflates
    // tokensIn quadratically. We take the largest single cache_read, not the sum.
    const lines = parseTranscriptJsonl(
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 2000 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 3000 },
          },
        }),
      ].join('\n')
    )
    const usage = sumTranscriptUsage(lines)
    // per-turn inputs (100*3) + max cache_read (3000) — NOT 1000+2000+3000.
    expect(usage.tokensIn).toBe(300 + 3000)
    expect(usage.tokensOut).toBe(30)
    const detailed = sumTranscriptUsageDetailed(lines)
    expect(detailed.tokensInNew).toBe(300)
    expect(detailed.cacheReadMax).toBe(3000)
    expect(detailed.tokensIn).toBe(detailed.tokensInNew + detailed.cacheReadMax)
  })

  it('returns zero usage when no usage blocks are present', () => {
    const lines = parseTranscriptJsonl(JSON.stringify({ type: 'user', message: { role: 'user' } }))
    expect(sumTranscriptUsage(lines)).toEqual({ tokensIn: 0, tokensOut: 0 })
  })

  it('is agent-agnostic: reads OpenAI and Gemini usage shapes too', () => {
    const lines = parseTranscriptJsonl(
      [
        // OpenAI Chat Completions shape (top-level usage)
        JSON.stringify({ usage: { prompt_tokens: 300, completion_tokens: 120 } }),
        // Gemini shape (usageMetadata)
        JSON.stringify({ usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 25 } }),
      ].join('\n')
    )
    const usage = sumTranscriptUsage(lines)
    expect(usage.tokensIn).toBe(300 + 50)
    expect(usage.tokensOut).toBe(120 + 25)
  })

  it('identifies one model, mixed models, and unknown without guessing', () => {
    expect(
      identifyTranscriptModel([
        { message: { role: 'assistant', model: 'claude-opus-5' } },
        { message: { role: 'assistant', model: 'claude-opus-5' } },
      ])
    ).toBe('claude-opus-5')
    expect(
      identifyTranscriptModel([
        { message: { role: 'assistant', model: 'gpt-5.6' } },
        { message: { role: 'assistant', model: 'gpt-5.6-mini' } },
      ])
    ).toBe('mixed')
    expect(identifyTranscriptModel([{ message: { role: 'assistant' } }])).toBe('unknown')
  })
})
