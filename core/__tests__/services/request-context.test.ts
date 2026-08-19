/**
 * Daemon caller-session context: identity resolves in the CLIENT process and
 * travels on the wire; inside `runWithCallerSession` the wire values win and
 * the (frozen) daemon env is never consulted. Plus the CLI trimming built on
 * it: `prjct prime` collapses to a pointer on a same-session repeat and
 * `prjct search` collapses an identical repeated query.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveCallerIdentity } from '../../services/agent-identity'
import { currentCallerSession, runWithCallerSession } from '../../services/request-context'
import { _resetDeliveredLedgerForTests } from '../../services/session-context-cache'
import prjctDb from '../../storage/database'

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  _resetDeliveredLedgerForTests()
  for (const key of ['CLAUDE_SESSION_ID', 'CODEX_SESSION_ID', 'PRJCT_SESSION_ID']) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('request-context propagation', () => {
  it('wire session wins over env inside runWithCallerSession', () => {
    process.env.CLAUDE_SESSION_ID = 'daemon-frozen-env-session'
    const resolved = runWithCallerSession(
      { sessionId: 'wire-session', agent: 'codex', identity: 'Turing' },
      () => resolveCallerIdentity('test')
    )
    expect(resolved.sessionId).toBe('wire-session')
    expect(resolved.agent).toBe('codex')
    expect(resolved.identity).toBe('Turing')
  })

  it('absent wire sessionId stays absent — never the daemon env', () => {
    process.env.CLAUDE_SESSION_ID = 'daemon-frozen-env-session'
    const resolved = runWithCallerSession({ agent: 'kimi' }, () => resolveCallerIdentity('test'))
    expect(resolved.sessionId).toBeUndefined()
  })

  it('outside the store the env fallback still works (direct CLI path)', () => {
    process.env.CLAUDE_SESSION_ID = 'direct-cli-session'
    expect(currentCallerSession()).toBeUndefined()
    expect(resolveCallerIdentity('test').sessionId).toBe('direct-cli-session')
  })

  it('nested async work keeps the context', async () => {
    const seen = await runWithCallerSession({ sessionId: 'async-session' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return currentCallerSession()?.sessionId
    })
    expect(seen).toBe('async-session')
  })
})

describe('cli-prime / cli-search session trimming', () => {
  const fixture: { projectPath: string; projectId: string } = { projectPath: '', projectId: '' }

  beforeEach(async () => {
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-cli-trim-'))
    await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
    fixture.projectId = `trim-${Math.random().toString(36).slice(2, 10)}`
    const { default: configManager } = await import('../../infrastructure/config-manager')
    const { default: pathManager } = await import('../../infrastructure/path-manager')
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
    } as Parameters<typeof configManager.writeConfig>[1])
    await pathManager.ensureProjectStructure(fixture.projectId)
  })

  afterEach(async () => {
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
    prjctDb.close()
  })

  it('prime repeat within one session collapses to a pointer; --full re-emits', async () => {
    const { CeremonyCommands } = await import('../../commands/ceremonies')
    const ceremonies = new CeremonyCommands()
    const sessionId = `prime-session-${Math.random().toString(36).slice(2, 8)}`

    const capture = async (opts: Record<string, boolean> = {}): Promise<string> => {
      const lines: string[] = []
      const original = console.log
      console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '))
      try {
        await runWithCallerSession({ sessionId, agent: 'claude' }, () =>
          ceremonies.prime(null, fixture.projectPath, { md: true, ...opts })
        )
      } finally {
        console.log = original
      }
      return lines.join('\n')
    }

    const first = await capture()
    expect(first.length).toBeGreaterThan(100)
    const repeat = await capture()
    expect(repeat).toContain('already delivered this session')
    expect(repeat.length).toBeLessThan(first.length)
    const forced = await capture({ full: true })
    expect(forced).not.toContain('already delivered this session')

    // A DIFFERENT session gets the full prime — no cross-agent theft.
    const otherLines: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => otherLines.push(args.map(String).join(' '))
    try {
      await runWithCallerSession({ sessionId: 'another-session', agent: 'claude' }, () =>
        ceremonies.prime(null, fixture.projectPath, { md: true })
      )
    } finally {
      console.log = original
    }
    expect(otherLines.join('\n')).not.toContain('already delivered this session')
  })

  it('identical repeated search collapses; sessionless never suppresses', async () => {
    const { projectMemory } = await import('../../memory/project-memory')
    await projectMemory.remember(fixture.projectPath, {
      type: 'gotcha',
      content: 'webhook retries must be idempotent',
      projectId: fixture.projectId,
    })
    const { ContextCommands } = await import('../../commands/context')
    const context = new ContextCommands()
    const sessionId = `search-session-${Math.random().toString(36).slice(2, 8)}`

    const first = await runWithCallerSession({ sessionId }, () =>
      context.search('webhook retries', fixture.projectPath, { md: true })
    )
    const repeat = await runWithCallerSession({ sessionId }, () =>
      context.search('webhook retries', fixture.projectPath, { md: true })
    )
    expect(first.message).toContain('webhook')
    expect(repeat.message).toContain('already delivered this session')

    // Sessionless (no store, no env): both calls full.
    const bare = await context.search('webhook retries', fixture.projectPath, { md: true })
    expect(bare.message ?? '').not.toContain('already delivered this session')
  })
})
