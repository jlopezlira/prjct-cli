/**
 * Burn attribution — the by-host/source cost axis plus prjct's own
 * context-tax accumulator. Real-log attribution (2026-08-19) showed prjct at
 * ~1% of session input; these paths make that ratio visible from SQLite
 * (`prjct product cost`) without transcript archaeology.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import {
  buildWorkCostSnapshot,
  recordHookEmissionChars,
  recordTaskTokenUsage,
} from '../../services/work-cost-service'
import { prjctDb } from '../../storage/database'

const fixture: { projectPath: string; tmpRoot: string; projectId: string } = {
  projectPath: '',
  tmpRoot: '',
  projectId: '',
}

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-burn-root-'))
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-burn-project-'))
  fixture.projectId = `burn-${Math.random().toString(36).slice(2, 10)}`
  pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.tmpRoot, 'data'),
  })
  prjctDb.getDb(fixture.projectId)
})

afterEach(async () => {
  prjctDb.close()
  pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
  await fs.rm(fixture.projectPath, { recursive: true, force: true })
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
})

describe('bySource cost grouping', () => {
  it('groups token_usage by source so per-host burn is visible', async () => {
    recordTaskTokenUsage(fixture.projectId, 'task-1', 1000, 100, {
      source: 'kimi-transcript',
      model: 'kimi-code/k3',
    })
    recordTaskTokenUsage(fixture.projectId, 'task-2', 5000, 500, {
      source: 'codex-transcript',
      model: 'gpt-5.6-sol',
    })
    recordHookEmissionChars(fixture.projectId, 'task-1', 4000, 'kimi')

    const snapshot = buildWorkCostSnapshot(fixture.projectId, 7)
    const bySource = new Map(snapshot.bySource.map((s) => [s.source, s]))
    expect(bySource.get('kimi-transcript')?.tokensIn).toBe(1000)
    expect(bySource.get('codex-transcript')?.tokensIn).toBe(5000)
    expect(bySource.get('hook-injection:kimi')?.tokensIn).toBe(1000) // 4000 chars / 4
  })
})

describe('recordHookEmissionChars', () => {
  it('accumulates across turns (additive, unlike the SET-semantics upsert)', () => {
    recordHookEmissionChars(fixture.projectId, 'task-1', 4000, 'codex')
    recordHookEmissionChars(fixture.projectId, 'task-1', 2000, 'codex')
    const row = prjctDb.get<{ input_tokens: number; is_estimated: number }>(
      fixture.projectId,
      "SELECT input_tokens, is_estimated FROM token_usage WHERE source = 'hook-injection:codex'"
    )
    expect(row?.input_tokens).toBe(1500) // (4000 + 2000) / 4
    expect(row?.is_estimated).toBe(1)
  })

  it('skips without an active task and on zero chars', () => {
    recordHookEmissionChars(fixture.projectId, null, 4000, 'kimi')
    recordHookEmissionChars(fixture.projectId, 'task-1', 0, 'kimi')
    const rows = prjctDb.query(
      fixture.projectId,
      "SELECT id FROM token_usage WHERE source LIKE 'hook-injection:%'"
    )
    expect(rows.length).toBe(0)
  })
})
