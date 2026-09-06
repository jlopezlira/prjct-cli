import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { detectRuntimeAgent, resolveCallerIdentity } from '../../services/agent-identity'

const keys = [
  'PRJCT_AGENT_RUNTIME',
  'AI_AGENT',
  'PI_CODING_AGENT',
  'PI_SESSION_ID',
  'PRJCT_SESSION_ID',
  'CLAUDECODE',
  'CLAUDE_SESSION_ID',
] as const
const saved = new Map<string, string | undefined>()
beforeEach(() => {
  for (const key of keys) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
})
afterEach(() => {
  for (const key of keys) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('official pi caller identity', () => {
  for (const [key, value] of [
    ['AI_AGENT', 'pi'],
    ['PI_CODING_AGENT', 'true'],
  ]) {
    it(`recognizes ${key} before inherited host signals`, () => {
      process.env[key] = value
      process.env.CLAUDECODE = '1'
      expect(detectRuntimeAgent()).toBe('pi')
    })
  }
  it('preserves explicit runtime override', () => {
    process.env.AI_AGENT = 'pi'
    process.env.PRJCT_AGENT_RUNTIME = 'codex'
    expect(detectRuntimeAgent()).toBe('codex')
  })
  it('uses the pi session rather than an inherited Claude session', () => {
    process.env.AI_AGENT = 'pi'
    process.env.PI_SESSION_ID = 'pi-session'
    process.env.CLAUDE_SESSION_ID = 'parent-session'
    expect(resolveCallerIdentity().sessionId).toBe('pi-session')
  })
  it('does not attribute an ephemeral pi session to its parent', () => {
    process.env.AI_AGENT = 'pi'
    process.env.CLAUDE_SESSION_ID = 'parent-session'
    expect(resolveCallerIdentity().sessionId).toBeUndefined()
  })
})
