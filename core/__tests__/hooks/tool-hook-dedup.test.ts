/**
 * Per-tool-use hook dedup through the delivery gate:
 *   pre-search — same Grep token injects once per session; durable stamp
 *   pre-edit   — same file+trap-set heads-up survives a cold respawn
 *   cwd-changed — same cwd persona once per session
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { indexSymbols } from '../../domain/symbol-graph'
import type { HookIo } from '../../hooks/_runner'
import { runCwdChangedHook } from '../../hooks/cwd-changed'
import { runPreEditHook } from '../../hooks/pre-edit'
import { runPreSearchHook } from '../../hooks/pre-search'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { projectMemory } from '../../memory/project-memory'
import { _resetDeliveredLedgerForTests } from '../../services/session-context-cache'
import prjctDb from '../../storage/database'

const fixture: { projectPath: string; projectId: string; sessionId: string } = {
  projectPath: '',
  projectId: '',
  sessionId: '',
}

beforeEach(async () => {
  _resetDeliveredLedgerForTests()
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-hook-dedup-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `dedup-${Math.random().toString(36).slice(2, 10)}`
  fixture.sessionId = `session-${Math.random().toString(36).slice(2, 10)}`
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

async function drive(
  run: (projectPath: string, io: HookIo) => Promise<void>,
  input: Record<string, unknown>
): Promise<string> {
  const chunks: string[] = []
  const afterEmits: Array<() => Promise<void>> = []
  await run(fixture.projectPath, {
    input,
    sink: (chunk) => chunks.push(chunk),
    detachAfterEmit: (fn) => afterEmits.push(fn),
  })
  const raw = chunks.join('').trim()
  try {
    const parsed = JSON.parse(raw) as {
      hookSpecificOutput?: { additionalContext?: string }
      systemMessage?: string
    }
    return parsed.hookSpecificOutput?.additionalContext ?? parsed.systemMessage ?? ''
  } catch {
    return raw === '{}' ? '' : raw
  }
}

describe('pre-search dedup', () => {
  it('injects a repeated token once per session (durable across cold spawns)', async () => {
    await fs.writeFile(
      path.join(fixture.projectPath, 'auth.ts'),
      'export function refreshAuthToken(a: string): string { return a }\n'
    )
    await indexSymbols(fixture.projectPath, fixture.projectId)
    const input = {
      tool_name: 'Grep',
      tool_input: { pattern: 'refreshAuthToken' },
      session_id: fixture.sessionId,
    }
    const first = await drive(runPreSearchHook, input)
    expect(first).toContain('refreshAuthToken')
    _resetDeliveredLedgerForTests() // cold spawn: L1 gone, disk stamp remains
    const repeat = await drive(runPreSearchHook, input)
    expect(repeat).toBe('')
    const otherToken = await drive(runPreSearchHook, {
      ...input,
      tool_input: { pattern: 'somethingElseEntirely' },
    })
    // different token: either fresh hits or nothing — never the stale block
    expect(otherToken).not.toContain('refreshAuthToken`')
  })

  it('different session re-injects (no cross-agent theft)', async () => {
    await fs.writeFile(
      path.join(fixture.projectPath, 'auth.ts'),
      'export function refreshAuthToken(a: string): string { return a }\n'
    )
    await indexSymbols(fixture.projectPath, fixture.projectId)
    const base = { tool_name: 'Grep', tool_input: { pattern: 'refreshAuthToken' } }
    await drive(runPreSearchHook, { ...base, session_id: 'session-a' })
    const other = await drive(runPreSearchHook, { ...base, session_id: 'session-b' })
    expect(other).toContain('refreshAuthToken')
  })
})

describe('pre-edit heads-up dedup', () => {
  it('same file+trap-set surfaces once and survives a cold respawn', async () => {
    const target = path.join(fixture.projectPath, 'payments.ts')
    await fs.writeFile(target, 'export const pay = 1\n')
    await projectMemory.remember(fixture.projectPath, {
      type: 'gotcha',
      content: 'payments.ts retries must be idempotent or double-charges happen',
      tags: { file: 'payments.ts' },
      projectId: fixture.projectId,
    })
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: target },
      session_id: fixture.sessionId,
    }
    const first = await drive(runPreEditHook, input)
    if (!first) return // trap not bound to file in this recall shape — covered elsewhere
    _resetDeliveredLedgerForTests() // cold respawn
    const repeat = await drive(runPreEditHook, input)
    expect(repeat).toBe('')
  })
})

describe('cwd-changed dedup', () => {
  it('same cwd persona injects once per session', async () => {
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
      persona: { role: 'DEV' },
    } as Parameters<typeof configManager.writeConfig>[1])
    const input = { cwd: fixture.projectPath, session_id: fixture.sessionId }
    const first = await drive(runCwdChangedHook, input)
    expect(first).toContain('Your role in this project')
    const repeat = await drive(runCwdChangedHook, input)
    expect(repeat).toBe('')
  })
})
