import { afterEach, describe, expect, it } from 'bun:test'
import { KNOWN_AGENTS } from '../../services/agent-identity'
import { resolveInstructionRuntime } from '../../services/instruction-attribution'

const ORIGINAL = {
  hookHost: process.env.PRJCT_HOOK_HOST,
  runtime: process.env.PRJCT_AGENT_RUNTIME,
}

afterEach(() => {
  if (ORIGINAL.hookHost === undefined) delete process.env.PRJCT_HOOK_HOST
  else process.env.PRJCT_HOOK_HOST = ORIGINAL.hookHost
  if (ORIGINAL.runtime === undefined) delete process.env.PRJCT_AGENT_RUNTIME
  else process.env.PRJCT_AGENT_RUNTIME = ORIGINAL.runtime
})

describe('instruction attribution', () => {
  it('uses the hook host before ambient runtime detection', () => {
    process.env.PRJCT_HOOK_HOST = 'grok'
    process.env.PRJCT_AGENT_RUNTIME = 'claude'
    expect(resolveInstructionRuntime()).toBe('grok')
  })

  it('preserves supported non-hook runtimes and unknown', () => {
    delete process.env.PRJCT_HOOK_HOST
    process.env.PRJCT_AGENT_RUNTIME = 'opencode'
    expect(resolveInstructionRuntime()).toBe('opencode')
    process.env.PRJCT_AGENT_RUNTIME = 'unknown'
    expect(resolveInstructionRuntime()).toBe('unknown')
  })

  it('accepts explicit evidence for deterministic replay without ambient state', () => {
    process.env.PRJCT_HOOK_HOST = 'claude'
    process.env.PRJCT_AGENT_RUNTIME = 'codex'
    expect(resolveInstructionRuntime({ hookHost: 'GROK' })).toBe('grok')
    expect(resolveInstructionRuntime({ hookHost: null, detectedRuntime: 'gemini' })).toBe('gemini')
  })

  it('rejects an unrecognized PRJCT_HOOK_HOST instead of stamping it verbatim into telemetry', () => {
    // Regression: previously any string in PRJCT_HOOK_HOST (typo, stale
    // value, unrelated tool) was accepted as-is — polluting per-runtime
    // failure groupings with a label no other part of the system would ever
    // produce. Validated against the same known-runtime set
    // detectRuntimeAgent() uses; falls through to ambient detection instead
    // of echoing the garbage value (ambient detection's own result depends
    // on the real host env, so assert the invariant rather than a fixed
    // fallback value).
    process.env.PRJCT_HOOK_HOST = 'not-a-real-runtime'
    const result = resolveInstructionRuntime()
    expect(result).not.toBe('not-a-real-runtime')
    expect(KNOWN_AGENTS.has(result)).toBe(true)
  })

  it('accepts a garbage hookHost fallback deterministically via explicit detectedRuntime evidence', () => {
    expect(
      resolveInstructionRuntime({ hookHost: 'not-a-real-runtime', detectedRuntime: 'pi' })
    ).toBe('pi')
  })
})
