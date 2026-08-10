/**
 * WS-B: recordTaskTokenUsage captures model / runtime / isEstimated / source
 * in the token event payload (the write side of the telemetry redesign — a
 * narrow `addCost`-style verb feeds these). Exact-vs-estimated must survive.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { recordTaskTokenUsage, TASK_TOKENS_EVENT } from '../../services/work-cost-service'
import { prjctDb } from '../../storage/database'

const fixture: {
  tmpRoot: string
  projectId: string
} = {
  tmpRoot: '',
  projectId: '',
}

const original = pathManager.getGlobalProjectPath.bind(pathManager)

describe('recordTaskTokenUsage meta', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-cost-meta-'))
    fixture.projectId = `costmeta-${Math.random().toString(36).slice(2, 10)}`
    pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
    prjctDb.getDb(fixture.projectId)
  })

  afterEach(async () => {
    prjctDb.close()
    pathManager.getGlobalProjectPath = original
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
  })

  function lastTokenEvent(): Record<string, unknown> {
    const rows = prjctDb.query<{ data: string }>(
      fixture.projectId,
      'SELECT data FROM events WHERE type = ? ORDER BY id DESC LIMIT 1',
      TASK_TOKENS_EVENT
    )
    expect(rows.length).toBe(1)
    return JSON.parse(rows[0].data)
  }

  it('persists model, runtime, isEstimated and source', () => {
    recordTaskTokenUsage(fixture.projectId, 'task-1', 1000, 200, {
      model: 'claude-opus-4-8',
      runtime: 'claude',
      isEstimated: false,
      source: 'mcp',
    })
    const data = lastTokenEvent()
    expect(data.tokensIn).toBe(1000)
    expect(data.tokensOut).toBe(200)
    expect(data.model).toBe('claude-opus-4-8')
    expect(data.runtime).toBe('claude')
    expect(data.isEstimated).toBe(false)
    expect(data.source).toBe('mcp')
  })

  it('omits unknown fields and keeps backward-compatible payload', () => {
    recordTaskTokenUsage(fixture.projectId, 'task-2', 5, 5)
    const data = lastTokenEvent()
    expect(data.taskId).toBe('task-2')
    expect('model' in data).toBe(false)
    expect('isEstimated' in data).toBe(false)
  })

  it('marks estimated counts explicitly', () => {
    recordTaskTokenUsage(fixture.projectId, 'task-3', 10, 10, { isEstimated: true, source: 'cli' })
    const data = lastTokenEvent()
    expect(data.isEstimated).toBe(true)
    expect(data.source).toBe('cli')
  })

  it('C2: dual-writes a typed token_usage row with is_estimated + model, upserting latest', () => {
    recordTaskTokenUsage(fixture.projectId, 'task-tu', 1000, 200, {
      model: 'claude-opus-4-8',
      runtime: 'claude',
      isEstimated: false,
      source: 'mcp',
    })
    // A later (cumulative) report for the same cycle+source upserts, not duplicates.
    recordTaskTokenUsage(fixture.projectId, 'task-tu', 1500, 300, {
      isEstimated: false,
      source: 'mcp',
    })

    const rows = prjctDb.query<{
      input_tokens: number
      output_tokens: number
      is_estimated: number
      model_id: string | null
      source: string
    }>(
      fixture.projectId,
      'SELECT input_tokens, output_tokens, is_estimated, model_id, source FROM token_usage WHERE work_cycle_id = ?',
      'task-tu'
    )
    expect(rows.length).toBe(1) // upserted, not duplicated
    expect(rows[0].input_tokens).toBe(1500)
    expect(rows[0].output_tokens).toBe(300)
    expect(rows[0].is_estimated).toBe(0)
    expect(rows[0].source).toBe('mcp')
  })

  it('C2: silently rejects corrupted out-of-range token counts (CHECK bound)', () => {
    // Event still records, but the typed token_usage row is rejected by CHECK.
    recordTaskTokenUsage(fixture.projectId, 'task-huge', 999_999_999, 1, { source: 'cli' })
    const rows = prjctDb.query(
      fixture.projectId,
      'SELECT id FROM token_usage WHERE work_cycle_id = ?',
      'task-huge'
    )
    expect(rows.length).toBe(0)
  })

  it('C2: distinct sources for the same cycle do not collide on event_key (regression)', () => {
    // core/hooks/stop.ts (Claude transcript, exact) and core/commands/primitives.ts
    // (manual CLI, agent-agnostic) both used to omit `source`, defaulting to the
    // same 'cli' bucket -> identical event_key `${taskId}:cli` -> the second
    // write silently overwrote the first via ON CONFLICT DO UPDATE. Each caller
    // now passes its own distinct source.
    recordTaskTokenUsage(fixture.projectId, 'task-shared', 50000, 8000, {
      source: 'claude-transcript',
      isEstimated: false,
    })
    recordTaskTokenUsage(fixture.projectId, 'task-shared', 120, 40, { source: 'cli-manual' })

    const rows = prjctDb.query<{ source: string; input_tokens: number; output_tokens: number }>(
      fixture.projectId,
      'SELECT source, input_tokens, output_tokens FROM token_usage WHERE work_cycle_id = ? ORDER BY source',
      'task-shared'
    )
    // Both measurements survive as distinct rows — neither destroyed the other.
    expect(rows.length).toBe(2)
    const transcript = rows.find((r) => r.source === 'claude-transcript')
    const manual = rows.find((r) => r.source === 'cli-manual')
    expect(transcript?.input_tokens).toBe(50000)
    expect(transcript?.output_tokens).toBe(8000)
    expect(manual?.input_tokens).toBe(120)
    expect(manual?.output_tokens).toBe(40)
  })
})
