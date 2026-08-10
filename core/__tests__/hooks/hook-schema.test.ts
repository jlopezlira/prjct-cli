/**
 * Claude Code hook response schema guard.
 *
 * Every hook emits JSON that Claude Code validates. The schema is strict:
 * `hookSpecificOutput.additionalContext` is valid for SessionStart,
 * UserPromptSubmit, PreToolUse, and PostToolUse. Emitting it on Stop /
 * SubagentStart / CwdChanged triggers a visible "The hook's output was …
 * Expected schema: …" error to the user every turn, so those fall back
 * to the universal top-level `systemMessage` channel.
 *
 * `buildHookOutput` is the single routing point, so this test pins its
 * behavior per event. If someone adds a new event or forgets to widen
 * the allow-list, this catches it at CI.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildDenyOutput,
  buildHookOutput,
  safeTruncate,
  stripLoneSurrogates,
} from '../../hooks/_shared'

/** True iff `s` round-trips through UTF-8 — i.e. contains no unpaired
 *  surrogate. A lone surrogate encodes to U+FFFD, so the round-trip
 *  differs. This is exactly the property the Anthropic API requires of
 *  the request body; a string failing it triggers the 400 we fix here. */
const isWellFormedUtf8 = (s: string): boolean => Buffer.from(s, 'utf8').toString('utf8') === s

describe('buildHookOutput routes per Claude Code schema', () => {
  test('SessionStart uses hookSpecificOutput.additionalContext', () => {
    const out = buildHookOutput('SessionStart', 'hello')
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: 'hello',
    })
    expect(out.systemMessage).toBeUndefined()
  })

  test('UserPromptSubmit uses hookSpecificOutput.additionalContext', () => {
    const out = buildHookOutput('UserPromptSubmit', 'ctx')
    expect(out.hookSpecificOutput?.additionalContext).toBe('ctx')
    expect(out.systemMessage).toBeUndefined()
  })

  test('PostToolUse uses hookSpecificOutput.additionalContext', () => {
    const out = buildHookOutput('PostToolUse', 'ctx')
    expect(out.hookSpecificOutput?.additionalContext).toBe('ctx')
    expect(out.systemMessage).toBeUndefined()
  })

  test('Stop falls back to systemMessage — schema rejects hookSpecificOutput here', () => {
    const out = buildHookOutput('Stop', 'nudge')
    expect(out.systemMessage).toBe('nudge')
    expect(out.hookSpecificOutput).toBeUndefined()
  })

  test('PreToolUse uses hookSpecificOutput.additionalContext', () => {
    const out = buildHookOutput('PreToolUse', 'ctx')
    expect(out.hookSpecificOutput?.additionalContext).toBe('ctx')
    expect(out.systemMessage).toBeUndefined()
  })

  test('SubagentStart falls back to systemMessage', () => {
    const out = buildHookOutput('SubagentStart', 'nudge')
    expect(out.systemMessage).toBe('nudge')
    expect(out.hookSpecificOutput).toBeUndefined()
  })

  test('CwdChanged falls back to systemMessage', () => {
    const out = buildHookOutput('CwdChanged', 'nudge')
    expect(out.systemMessage).toBe('nudge')
    expect(out.hookSpecificOutput).toBeUndefined()
  })

  test('null context always produces an empty object', () => {
    for (const event of [
      'SessionStart',
      'UserPromptSubmit',
      'PostToolUse',
      'Stop',
      'PreToolUse',
      'SubagentStart',
      'CwdChanged',
    ]) {
      expect(buildHookOutput(event, null)).toEqual({})
    }
  })

  // Regression: API 400 "no low surrogate in string" — hook output that
  // ends in a lone UTF-16 high surrogate makes the model request body
  // un-encodable. Root cause was `s.slice(0, n)` cutting between an
  // emoji's surrogate pair during truncation.
  test('buildHookOutput scrubs an unpaired surrogate from context', () => {
    // U+1F916 🤖 = high D83E + low DD16. Keep only the high half.
    const corrupted = `state line with a split emoji \uD83E`
    expect(isWellFormedUtf8(corrupted)).toBe(false) // precondition: it IS broken
    const out = buildHookOutput('UserPromptSubmit', corrupted)
    expect(isWellFormedUtf8(out.hookSpecificOutput?.additionalContext ?? '')).toBe(true)
  })

  test('buildHookOutput scrubs an unpaired LOW surrogate too (systemMessage path)', () => {
    const corrupted = `\uDD16 nudge with a leading orphan low surrogate`
    const out = buildHookOutput('Stop', corrupted)
    expect(isWellFormedUtf8(out.systemMessage ?? '')).toBe(true)
  })

  test('stripLoneSurrogates preserves valid astral pairs, kills only orphans', () => {
    const ok = 'robot 🤖 fire 🔥 done'
    expect(stripLoneSurrogates(ok)).toBe(ok)
    expect(stripLoneSurrogates(`${ok}\uD83E`)).toBe(`${ok}�`)
  })

  test('safeTruncate never splits a surrogate pair at the cut boundary', () => {
    // Build a string where an emoji straddles the truncation point for a
    // range of caps — the naive slice would leave a lone high surrogate.
    const head = 'x'.repeat(40)
    const s = `${head}🤖${'y'.repeat(40)}`
    for (const max of Array.from({ length: 31 }, (_, index) => index + 30)) {
      const t = safeTruncate(s, max, '…')
      expect(isWellFormedUtf8(t)).toBe(true)
      expect(t.length).toBeLessThanOrEqual(max)
    }
    // Naive slice at the splitting index really would be ill-formed —
    // pins that the test is exercising the actual failure mode.
    const splitAt = head.length + 1 // between high and low surrogate
    expect(isWellFormedUtf8(s.slice(0, splitAt))).toBe(false)
  })

  test('safeTruncate is a no-op under budget and respects the marker', () => {
    expect(safeTruncate('short', 100)).toBe('short')
    const long = 'a'.repeat(500)
    const out = safeTruncate(long, 50, '\n… [truncated]')
    expect(out.endsWith('\n… [truncated]')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(50)
  })

  test('emitted JSON only contains top-level fields Claude Code accepts', () => {
    // Schema whitelist from the Claude Code hook response validator.
    const ALLOWED_TOP_LEVEL = new Set([
      'continue',
      'suppressOutput',
      'stopReason',
      'decision',
      'reason',
      'systemMessage',
      'permissionDecision',
      'hookSpecificOutput',
    ])
    for (const event of [
      'SessionStart',
      'UserPromptSubmit',
      'PostToolUse',
      'Stop',
      'PreToolUse',
      'SubagentStart',
      'CwdChanged',
    ]) {
      const out = buildHookOutput(event, 'x')
      for (const key of Object.keys(out)) {
        expect(ALLOWED_TOP_LEVEL.has(key)).toBe(true)
      }
    }
    // The hard-stop deny channel rides the whitelisted hookSpecificOutput key.
    const deny = buildDenyOutput('PreToolUse', 'turn budget exceeded')
    expect(Object.keys(deny)).toEqual(['hookSpecificOutput'])
    expect(ALLOWED_TOP_LEVEL.has('hookSpecificOutput')).toBe(true)
    expect(deny.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(deny.hookSpecificOutput.permissionDecisionReason).toContain('turn budget exceeded')
  })
})
