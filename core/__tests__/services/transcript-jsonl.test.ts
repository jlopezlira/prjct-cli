import { describe, expect, it } from 'bun:test'
import {
  identifyTranscriptModel,
  parseTranscriptJsonl,
  sumTranscriptUsage,
  sumTranscriptUsageByModel,
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

  it('reads Kimi wire.jsonl usage.record lines (inputOther/output/inputCacheRead)', () => {
    const lines = parseTranscriptJsonl(
      [
        JSON.stringify({ type: 'metadata', protocol_version: '1.5' }),
        JSON.stringify({
          type: 'usage.record',
          model: 'kimi-code/k3',
          usage: { inputOther: 4752, output: 421, inputCacheRead: 21248, inputCacheCreation: 0 },
          time: 1786425032850,
        }),
        JSON.stringify({
          type: 'usage.record',
          model: 'kimi-code/k3',
          usage: { inputOther: 1110, output: 2143, inputCacheRead: 25856, inputCacheCreation: 500 },
          time: 1786425035707,
        }),
        // Nested loop-event usage must NOT double-count (no top-level usage).
        JSON.stringify({
          type: 'context.append_loop_event',
          event: { type: 'step.end', usage: { inputOther: 1110, output: 2143 } },
        }),
      ].join('\n')
    )
    const usage = sumTranscriptUsage(lines)
    // new input (4752 + 1110 + 500) + max cumulative cache read (25856).
    expect(usage.tokensIn).toBe(4752 + 1110 + 500 + 25856)
    expect(usage.tokensOut).toBe(421 + 2143)
  })

  it('attributes Kimi usage to the top-level model and windows by numeric epoch-ms time', () => {
    const lines = parseTranscriptJsonl(
      [
        JSON.stringify({
          type: 'usage.record',
          model: 'kimi-code/k3',
          usage: { inputOther: 100, output: 10 },
          time: 1000,
        }),
        JSON.stringify({
          type: 'usage.record',
          model: 'kimi-code/k3',
          usage: { inputOther: 200, output: 20 },
          time: 5000,
        }),
      ].join('\n')
    )
    const byModel = sumTranscriptUsageByModel(lines)
    expect(byModel.get('kimi-code/k3')).toEqual({ tokensIn: 300, tokensOut: 30 })
    // Window starting at t=2000ms excludes the first record (numeric `time`).
    const windowed = sumTranscriptUsage(lines, { sinceIso: new Date(2000).toISOString() })
    expect(windowed).toEqual({ tokensIn: 200, tokensOut: 20 })
  })
})
