/**
 * SessionStart source routing under the delivery gate:
 *   startup/clear → full grounding block (stamped)
 *   compact       → ≤350-char re-anchor (the host just summarized the block)
 *   resume        → nothing when the session was already grounded; persona
 *                   -only when the stamp is missing
 * Plus the kimi park/consume round-trip for the new 'reanchor' value.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HookIo } from '../../hooks/_runner'
import {
  buildCompactReanchor,
  consumeKimiSessionInjection,
  runSessionStartHook,
} from '../../hooks/session-start'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { _resetDeliveredLedgerForTests } from '../../services/session-context-cache'
import prjctDb from '../../storage/database'

const fixture: { projectPath: string; projectId: string; sessionId: string } = {
  projectPath: '',
  projectId: '',
  sessionId: '',
}

beforeEach(async () => {
  _resetDeliveredLedgerForTests()
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-ss-sources-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `ss-src-${Math.random().toString(36).slice(2, 10)}`
  fixture.sessionId = `session-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
    persona: { role: 'DEV' },
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
})

afterEach(async () => {
  await fs.rm(fixture.projectPath, { recursive: true, force: true })
  prjctDb.close()
})

async function runSource(source: string, host?: string): Promise<{ context: string; raw: string }> {
  const chunks: string[] = []
  const afterEmits: Array<() => Promise<void>> = []
  const io: HookIo = {
    input: { source, session_id: fixture.sessionId },
    ...(host ? { hookHost: host as HookIo['hookHost'] } : {}),
    sink: (chunk) => chunks.push(chunk),
    detachAfterEmit: (fn) => afterEmits.push(fn),
  }
  await runSessionStartHook(fixture.projectPath, io)
  const raw = chunks.join('').trim()
  const context = ((): string => {
    try {
      const parsed = JSON.parse(raw) as { hookSpecificOutput?: { additionalContext?: string } }
      return parsed.hookSpecificOutput?.additionalContext ?? ''
    } catch {
      return ''
    }
  })()
  return { context, raw }
}

describe('SessionStart source matrix', () => {
  test('startup emits the full grounding block', async () => {
    const { context } = await runSource('startup')
    expect(context).toContain('# prjct: project context')
    expect(context).toContain('Your role in this project')
  })

  test('compact emits only the ≤350-char re-anchor, never the full block', async () => {
    await runSource('startup')
    const { context } = await runSource('compact')
    if (context) {
      expect(context.length).toBeLessThanOrEqual(350)
      expect(context).toContain('re-anchor')
      expect(context).not.toContain('# prjct: project context')
    }
  })

  test('resume after startup emits nothing (session already grounded)', async () => {
    await runSource('startup')
    const { context } = await runSource('resume')
    expect(context).toBe('')
  })

  test('resume without a grounding stamp falls back to persona-only', async () => {
    const { context } = await runSource('resume')
    expect(context).toContain('Your role in this project')
    expect(context).not.toContain('What this project already knows')
  })

  test('kimi parks reanchor on compact and the consumer round-trips it', async () => {
    const { raw } = await runSource('compact', 'kimi')
    expect(raw === '' || raw === '{}').toBe(true)
    const parked = await consumeKimiSessionInjection(fixture.projectId, fixture.sessionId)
    expect(parked).toBe('reanchor')
    // Consumed exactly once.
    expect(await consumeKimiSessionInjection(fixture.projectId, fixture.sessionId)).toBeNull()
  })

  test('buildCompactReanchor stays within budget with an active cycle', async () => {
    const { stateStorage } = await import('../../storage/state-storage')
    await stateStorage.startTask(fixture.projectId, {
      id: 'reanchor-task',
      description: 'a cycle description that is reasonably long to stress the truncation budget',
      startedAt: new Date().toISOString(),
      sessionId: fixture.sessionId,
    } as Parameters<typeof stateStorage.startTask>[1])
    const reanchor = await buildCompactReanchor(fixture.projectPath)
    expect(reanchor).not.toBeNull()
    expect(reanchor!.length).toBeLessThanOrEqual(350)
    expect(reanchor).toContain('Active cycle:')
  })
})
