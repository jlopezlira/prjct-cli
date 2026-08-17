/**
 * Kimi first-prompt injection — SessionStart fallback.
 *
 * Kimi's SessionStart is observation-only (stdout never reaches the model),
 * so under host `kimi` the session-start hook parks its payload in a
 * per-session stamp and the prompt hook injects it on the session's FIRST
 * UserPromptSubmit instead. Pins:
 *   1. kimi session-start emits `{}` and parks the stamp.
 *   2. First kimi prompt carries the session context (persona/digest block).
 *   3. Second prompt of the same session does NOT repeat it (stamp consumed).
 *   4. Claude behavior unchanged: session-start emits the context block and
 *      no stamp leaks into prompts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DAEMON_PATHS } from '../../daemon/protocol'
import type { HookIo } from '../../hooks/_runner'
import { runPromptHook } from '../../hooks/prompt'
import { runSessionStartHook } from '../../hooks/session-start'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { detectRuntimeAgent } from '../../services/agent-identity'
import { createHandoff } from '../../storage/handoff-storage'
import { execFileAsync } from '../../utils/exec'

const fixture: { projectPath: string; projectId: string } = { projectPath: '', projectId: '' }

function ioFor(input: unknown, hookHost?: 'kimi' | 'claude') {
  const chunks: string[] = []
  const io: HookIo = {
    input,
    ...(hookHost ? { hookHost } : {}),
    sink: (chunk) => chunks.push(chunk),
    detachAfterEmit: () => {},
  }
  return { io, output: () => chunks.join('') }
}

beforeEach(async () => {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-kimi-first-prompt-test-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `kimi-first-${crypto.randomUUID()}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: fixture.projectPath })
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], {
    cwd: fixture.projectPath,
  })
  await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: fixture.projectPath })
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: fixture.projectPath })
})

afterEach(async () => {
  await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
})

describe('kimi session digest hand-off', () => {
  it('parks the SessionStart payload and injects it on the first prompt only', async () => {
    const sessionId = 'session_kimi-e2e'
    const start = ioFor({ source: 'startup', session_id: sessionId }, 'kimi')
    await runSessionStartHook(fixture.projectPath, start.io)
    expect(start.output()).toBe('{}\n')

    const first = ioFor({ prompt: 'hola, sigamos', session_id: sessionId }, 'kimi')
    await runPromptHook(fixture.projectPath, first.io)
    expect(first.output()).toContain('# prjct: project context')

    const second = ioFor({ prompt: 'otra cosa distinta', session_id: sessionId }, 'kimi')
    await runPromptHook(fixture.projectPath, second.io)
    expect(second.output()).not.toContain('# prjct: project context')
  })

  it('scopes the stamp per session — a new session id injects again', async () => {
    const s1 = ioFor({ source: 'startup', session_id: 'session_a' }, 'kimi')
    await runSessionStartHook(fixture.projectPath, s1.io)
    const s2 = ioFor({ source: 'startup', session_id: 'session_b' }, 'kimi')
    await runSessionStartHook(fixture.projectPath, s2.io)

    const p1 = ioFor({ prompt: 'trabaja en ello', session_id: 'session_b' }, 'kimi')
    await runPromptHook(fixture.projectPath, p1.io)
    expect(p1.output()).toContain('# prjct: project context')
  })

  it('leaves Claude behavior unchanged (context at SessionStart, none parked)', async () => {
    const start = ioFor({ source: 'startup', session_id: 'claude-1' })
    await runSessionStartHook(fixture.projectPath, start.io)
    expect(start.output()).toContain('hookSpecificOutput')

    const prompt = ioFor({ prompt: 'hola claude', session_id: 'claude-1' })
    await runPromptHook(fixture.projectPath, prompt.io)
    expect(prompt.output()).not.toContain('# prjct: project context')
  })

  it('injects a pending handoff cue once, not twice, on the first prompt', async () => {
    createHandoff({
      projectId: fixture.projectId,
      taskId: 'task_handoff_once',
      taskDescription: 'finish the migration',
      fromAgent: 'claude',
      // Target whatever agent this test process detects as — the cue only
      // surfaces for handoffs pending for the CURRENT runtime agent.
      toAgent: detectRuntimeAgent(),
      reason: 'context window full',
    })

    const start = ioFor({ source: 'startup', session_id: 'session_handoff' }, 'kimi')
    await runSessionStartHook(fixture.projectPath, start.io)

    const first = ioFor({ prompt: 'retoma la migración', session_id: 'session_handoff' }, 'kimi')
    await runPromptHook(fixture.projectPath, first.io)
    // The session digest already carries the handoff cue — the state block
    // must skip its own probe so the cue lands exactly once in one payload.
    const occurrences = first.output().split('Handoff pending').length - 1
    expect(occurrences).toBe(1)
  })

  it('falls back to a project+host stamp key when session_id is missing', async () => {
    const start = ioFor({ source: 'startup' }, 'kimi')
    await runSessionStartHook(fixture.projectPath, start.io)

    const stampFiles = await fs.readdir(DAEMON_PATHS.runDir())
    const parked = stampFiles.filter(
      (name) => name.startsWith(`kimi-session-`) && name.includes(fixture.projectId)
    )
    expect(parked).toHaveLength(1)
    // No more shared literal 'unknown' — the fallback is host-scoped.
    expect(parked[0]).toContain('nosession-kimi')

    const first = ioFor({ prompt: 'sin session id' }, 'kimi')
    await runPromptHook(fixture.projectPath, first.io)
    expect(first.output()).toContain('# prjct: project context')
  })
})
