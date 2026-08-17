/**
 * Stop hook — daemon-mode host threading.
 *
 * The warm daemon serves hooks for every host, but its own process env never
 * carries PRJCT_HOOK_HOST. The invoking host travels on the daemon wire as
 * `hookHost` and the runner threads it into afterEmit. These tests pin that
 * contract for the two host-dependent branches in stop.ts: the instruction
 * telemetry runtime (resolveInstructionRuntime) and Kimi's transcript_path
 * fallback (wire.jsonl resolution from session_id).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runStopHook } from '../../hooks/stop'
import pathManager from '../../infrastructure/path-manager'
import { prjctDb } from '../../storage/database'

const fixture: {
  cliHome: string
  projectDir: string
  tmpRoot: string
  fakeHome: string
  prevHome?: string
  prevCliHome?: string
  prevHookHost?: string
  prevTestMode?: string
} = { cliHome: '', projectDir: '', tmpRoot: '', fakeHome: '' }

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

function freshProjectId(): string {
  return `test-stop-host-${Math.random().toString(36).slice(2, 10)}`
}

async function writeProjectConfig(projectId: string): Promise<void> {
  await fs.mkdir(path.join(fixture.projectDir, '.prjct'), { recursive: true })
  await fs.writeFile(
    path.join(fixture.projectDir, '.prjct', 'prjct.config.json'),
    JSON.stringify({ projectId })
  )
}

/** Run the Stop hook in daemon (HookIo) mode and its detached afterEmit. */
async function runStopDaemon(
  input: { transcript_path?: string; session_id?: string },
  hookHost?: 'claude' | 'gemini' | 'codex' | 'cursor' | 'kimi'
): Promise<void> {
  const box: { fn: (() => Promise<void>) | null } = { fn: null }
  await runStopHook(fixture.projectDir, {
    input,
    hookHost,
    sink: () => {},
    detachAfterEmit: (fn) => {
      box.fn = fn
    },
  })
  if (box.fn) await box.fn()
}

beforeEach(async () => {
  fixture.cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stop-host-home-'))
  fixture.projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stop-host-proj-'))
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stop-host-root-'))
  fixture.fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stop-host-user-'))
  fixture.prevCliHome = process.env.PRJCT_CLI_HOME
  fixture.prevHookHost = process.env.PRJCT_HOOK_HOST
  fixture.prevTestMode = process.env.PRJCT_TEST_MODE
  fixture.prevHome = process.env.HOME
  process.env.PRJCT_CLI_HOME = fixture.cliHome
  delete process.env.PRJCT_HOOK_HOST
  process.env.PRJCT_TEST_MODE = '1'
  process.env.HOME = fixture.fakeHome
  pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
})

afterEach(async () => {
  prjctDb.close()
  pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
  if (fixture.prevCliHome === undefined) delete process.env.PRJCT_CLI_HOME
  else process.env.PRJCT_CLI_HOME = fixture.prevCliHome
  if (fixture.prevHookHost === undefined) delete process.env.PRJCT_HOOK_HOST
  else process.env.PRJCT_HOOK_HOST = fixture.prevHookHost
  if (fixture.prevTestMode === undefined) delete process.env.PRJCT_TEST_MODE
  else process.env.PRJCT_TEST_MODE = fixture.prevTestMode
  if (fixture.prevHome === undefined) delete process.env.HOME
  else process.env.HOME = fixture.prevHome
  await fs.rm(fixture.cliHome, { recursive: true, force: true })
  await fs.rm(fixture.projectDir, { recursive: true, force: true })
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
  await fs.rm(fixture.fakeHome, { recursive: true, force: true })
})

describe('Stop hook — daemon host threading', () => {
  test('io.hookHost attributes the session-end runtime when the daemon env lacks PRJCT_HOOK_HOST', async () => {
    const projectId = freshProjectId()
    await writeProjectConfig(projectId)
    prjctDb.getDb(projectId)

    await runStopDaemon({ session_id: 'sess-kimi' }, 'kimi')

    const row = prjctDb.get<{ runtime: string }>(
      projectId,
      'SELECT runtime FROM agent_sessions WHERE id = ?',
      'sess-kimi'
    )
    expect(row?.runtime).toBe('kimi')
  })

  test('falls back to the env host when io.hookHost is absent (cold-entry bridge)', async () => {
    const projectId = freshProjectId()
    await writeProjectConfig(projectId)
    prjctDb.getDb(projectId)
    process.env.PRJCT_HOOK_HOST = 'gemini'

    await runStopDaemon({ session_id: 'sess-gemini' })

    const row = prjctDb.get<{ runtime: string }>(
      projectId,
      'SELECT runtime FROM agent_sessions WHERE id = ?',
      'sess-gemini'
    )
    expect(row?.runtime).toBe('gemini')
  })

  test('kimi host resolves the session wire.jsonl when transcript_path is missing', async () => {
    const projectId = freshProjectId()
    await writeProjectConfig(projectId)
    const wirePath = path.join(
      fixture.fakeHome,
      '.prjct-tests',
      'kimi-code',
      'sessions',
      'wd_test',
      'session_kimi-1',
      'agents',
      'main',
      'wire.jsonl'
    )
    await fs.mkdir(path.dirname(wirePath), { recursive: true })
    await fs.writeFile(wirePath, `${JSON.stringify({ type: 'assistant' })}\n`)

    const spy = spyOn(fs, 'readFile')
    try {
      await runStopDaemon({ session_id: 'kimi-1' }, 'kimi')
      const wireReads = spy.mock.calls.filter((call) => call[0] === wirePath)
      expect(wireReads.length).toBeGreaterThan(0)
    } finally {
      spy.mockRestore()
    }
  })

  test('a non-kimi host never probes the kimi session dirs', async () => {
    const projectId = freshProjectId()
    await writeProjectConfig(projectId)
    const spy = spyOn(fs, 'readFile')
    try {
      await runStopDaemon({ session_id: 'kimi-1' }, 'claude')
      const wireReads = spy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('wire.jsonl')
      )
      expect(wireReads).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })
})
