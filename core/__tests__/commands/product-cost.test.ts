import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProductCommands } from '../../commands/product'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import {
  buildWorkCostSnapshot,
  publishWorkCostSnapshots,
  recordTaskTokenUsage,
  type WorkCostSnapshot,
} from '../../services/work-cost-service'
import { prjctDb } from '../../storage/database'
import { syncPendingStorage } from '../../storage/sync-pending-storage'

const fixture: {
  projectPath: string
  tmpRoot: string
  projectId: string
} = {
  projectPath: '',
  tmpRoot: '',
  projectId: '',
}

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

describe('insights cost', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-cost-root-'))
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-cost-project-'))
    fixture.projectId = `cost-${Math.random().toString(36).slice(2, 10)}`
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

  it('reports measured token burn and most expensive work cycles', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const now = new Date().toISOString()
    try {
      prjctDb.run(
        fixture.projectId,
        `INSERT INTO tasks
         (id, description, status, started_at, completed_at, tokens_in, tokens_out)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'task-1',
        'Fix cloud context chronology',
        'completed',
        now,
        now,
        12000,
        3000
      )
      prjctDb.run(
        fixture.projectId,
        `INSERT INTO memory_surface_log (memory_id, task_id, created_at, query_text, surface)
         VALUES (?, ?, ?, ?, ?)`,
        'mem_1',
        'task-1',
        now,
        'cloud chronology',
        'work'
      )
      prjctDb.run(
        fixture.projectId,
        `INSERT INTO memory_usefulness (memory_id, score, ref_count, fetch_count, last_used_at)
         VALUES (?, ?, ?, ?, ?)`,
        'mem_1',
        1,
        1,
        1,
        now
      )

      const result = await new ProductCommands().insightsCost('30', fixture.projectPath, {
        md: true,
      })
      const snapshot = result as typeof result & WorkCostSnapshot

      expect(result.success).toBe(true)
      expect(snapshot.tokensTotal).toBe(15000)
      expect(snapshot.tokenCoveragePercent).toBe(100)
      expect(snapshot.surfacedContext).toBe(1)
    } finally {
      log.mockRestore()
    }
  })

  it('rescues historical work and declared token usage from events', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const now = new Date().toISOString()
    try {
      prjctDb.appendEvent(fixture.projectId, 'memory.task_started', {
        task: 'Investigate repeated agent exploration',
        taskId: 'task-historical',
      })
      prjctDb.appendEvent(fixture.projectId, 'memory.feature_shipped', {
        feature: 'file cue rollout',
      })
      prjctDb.appendEvent(fixture.projectId, 'memory.remember.context', {
        content:
          'Claude spent about 55k tokens exploring existing code because file cues were missing.',
      })
      prjctDb.run(
        fixture.projectId,
        'UPDATE events SET timestamp = ? WHERE type IN (?, ?, ?)',
        now,
        'memory.task_started',
        'memory.feature_shipped',
        'memory.remember.context'
      )

      const result = await new ProductCommands().insightsCost('30', fixture.projectPath, {
        md: true,
      })
      const snapshot = result as typeof result & WorkCostSnapshot

      expect(result.success).toBe(true)
      expect(snapshot.workCycles).toBe(1)
      expect(snapshot.historicalRescue.eventWorkStarts).toBe(1)
      expect(snapshot.historicalRescue.eventShips).toBe(1)
      expect(snapshot.historicalRescue.declaredTokensTotal).toBe(55000)
      expect(snapshot.gaps).toContain(
        'Work history was rescued from events, but normalized task rows are missing.'
      )
    } finally {
      log.mockRestore()
    }
  })

  it('keeps missing task/session/token capture visible', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const result = await new ProductCommands().insightsCost('30', fixture.projectPath, {
        md: true,
      })
      const snapshot = result as typeof result & WorkCostSnapshot

      expect(result.success).toBe(true)
      expect(snapshot.workCycles).toBe(0)
      expect(snapshot.gaps).toContain(
        'No work cycles were found in tasks or historical events for this window.'
      )
    } finally {
      log.mockRestore()
    }
  })

  it('publishes retrospective snapshots as sync analytics events', async () => {
    await publishWorkCostSnapshots(fixture.projectId, [30])

    const pending = syncPendingStorage.list(fixture.projectId)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.event.entityType).toBe('work_cost_snapshots')
    expect(pending[0]?.event.entityId).toBe('work-cost-30d')
    expect(pending[0]?.event.eventType).toBe('upsert')
  })

  it('AC8: redacts free-text declared-token prose from the cloud payload', () => {
    // Seed a remembered note that mentions tokens AND carries a secret-like phrase.
    const now = new Date().toISOString()
    prjctDb.appendEvent(fixture.projectId, 'memory.remember.learning', {
      content: 'Saved ~5000 tokens by caching; key sk-live-SECRET-pii-12345',
      tags: {},
      provenance: 'declared',
    })
    prjctDb.run(
      fixture.projectId,
      'UPDATE events SET timestamp = ? WHERE type = ?',
      now,
      'memory.remember.learning'
    )

    // Local snapshot keeps the prose (used by the local cost report)...
    const local = buildWorkCostSnapshot(fixture.projectId, 30)
    const localMentions = local.historicalRescue.topDeclaredTokenMentions
    expect(localMentions.length).toBeGreaterThan(0)
    expect(localMentions.some((m) => m.summary.includes('SECRET'))).toBe(true)

    // ...but the cloud payload must NOT (only structured numeric fields).
    return publishWorkCostSnapshots(fixture.projectId, [30]).then(() => {
      const pending = syncPendingStorage.list(fixture.projectId)
      const published = pending.find((p) => p.event.entityId === 'work-cost-30d')
      const data = published?.event.data as WorkCostSnapshot
      const cloudMentions = data.historicalRescue.topDeclaredTokenMentions
      expect(cloudMentions.length).toBeGreaterThan(0)
      for (const m of cloudMentions) {
        expect(m.summary).toBe('[redacted]')
        expect(typeof m.tokens).toBe('number')
      }
      const serialized = JSON.stringify(data)
      expect(serialized.includes('SECRET')).toBe(false)
    })
  })

  it('AC8: redacts mostExpensive[].description (user task intent) from the cloud payload', () => {
    // A work-cycle description is free text authored by the user/agent (e.g.
    // `prjct work "rotate the sk-live-SECRET key"` or the Stop-hook transcript
    // description) — the same secret-leak class as the declared-token prose,
    // but carried through recordTaskTokenUsage -> token_usage.description ->
    // mostExpensive[], a path the original AC8 redaction missed entirely.
    recordTaskTokenUsage(fixture.projectId, 'task-secret', 1000, 200, {
      description: 'rotate the sk-live-SECRET-pii-99999 key',
      source: 'cli',
    })

    const local = buildWorkCostSnapshot(fixture.projectId, 30)
    expect(local.mostExpensive.some((t) => t.description.includes('SECRET'))).toBe(true)

    return publishWorkCostSnapshots(fixture.projectId, [30]).then(() => {
      const pending = syncPendingStorage.list(fixture.projectId)
      const published = pending.find((p) => p.event.entityId === 'work-cost-30d')
      const data = published?.event.data as WorkCostSnapshot
      expect(data.mostExpensive.length).toBeGreaterThan(0)
      for (const t of data.mostExpensive) {
        expect(t.description).toBe('[redacted]')
      }
      const serialized = JSON.stringify(data)
      expect(serialized.includes('SECRET')).toBe(false)
    })
  })

  it('a corrupted out-of-range token count never leaks in via the tasks.tokens_in/out fallback', () => {
    // token_usage's CHECK(input_tokens/output_tokens BETWEEN 0 AND 10_000_000)
    // exists specifically to keep corrupted counts out of cost reports. Before
    // this fix, recordTaskTokenUsage still wrote the corrupted value straight
    // to tasks.tokens_in/out unconditionally, and buildWorkCostSnapshot's
    // legacy-fallback merge (toCostTask) picked it up anyway for any task with
    // no token_usage row — silently defeating the CHECK for exactly the
    // corrupted-value case it exists to catch.
    const now = new Date().toISOString()
    prjctDb.run(
      fixture.projectId,
      `INSERT INTO tasks (id, description, status, started_at, completed_at, tokens_in, tokens_out)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'task-corrupt',
      'Legit small cycle',
      'completed',
      now,
      now,
      500,
      100
    )

    recordTaskTokenUsage(fixture.projectId, 'task-corrupt', 999_999_999, 1, { source: 'cli' })

    // token_usage correctly rejected it (existing coverage in cost-meta.test.ts)...
    const tokenUsageRows = prjctDb.query(
      fixture.projectId,
      'SELECT id FROM token_usage WHERE work_cycle_id = ?',
      'task-corrupt'
    )
    expect(tokenUsageRows.length).toBe(0)

    // ...and tasks.tokens_in/out must ALSO have rejected the corrupted write
    // (same bound applied before either write) — the original legit values
    // survive untouched, not overwritten with the corrupted 999,999,999.
    const taskRow = prjctDb.query<{ tokens_in: number; tokens_out: number }>(
      fixture.projectId,
      'SELECT tokens_in, tokens_out FROM tasks WHERE id = ?',
      'task-corrupt'
    )[0]
    expect(taskRow.tokens_in).toBe(500)
    expect(taskRow.tokens_out).toBe(100)

    // End-to-end: the snapshot reflects the legit value, never the corrupted one.
    const snapshot = buildWorkCostSnapshot(fixture.projectId, 30)
    const entry = snapshot.mostExpensive.find((t) => t.id === 'task-corrupt')
    expect(entry?.tokensIn).toBe(500)
  })

  it('reports measurement reliability gaps and next actions', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const now = new Date().toISOString()
    try {
      prjctDb.appendEvent(fixture.projectId, 'memory.task_started', {
        task: 'Improve measurement proof',
        taskId: 'task-reliability',
      })
      prjctDb.run(
        fixture.projectId,
        'UPDATE events SET timestamp = ? WHERE type = ?',
        now,
        'memory.task_started'
      )

      const result = await new ProductCommands().insights('reliability 30', fixture.projectPath, {
        md: true,
      })

      expect(result.success).toBe(true)
      expect(result).toMatchObject({
        tokenCoveragePercent: 0,
        sessionCoveragePercent: 0,
      })
      expect(log.mock.calls[0]?.[0]).toContain('# prjct Reliability')
      expect(log.mock.calls[0]?.[0]).toContain('Work-cycle normalization')
      expect(log.mock.calls[0]?.[0]).toContain('Next Actions')
    } finally {
      log.mockRestore()
    }
  })

  it('prints a memory doctor fix-plan for cleanup actions', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const oldMs = Date.now() - 20 * 24 * 60 * 60 * 1000
    try {
      // memory-doctor reads the single-source memory_entries (epoch-ms times).
      prjctDb.run(
        fixture.projectId,
        `INSERT INTO memory_entries
           (id, project_id, type, title, content, provenance, content_hash,
            user_triggered, revision_count, created_at, updated_at)
         VALUES (?, ?, 'inbox', 'list', 'list', 'declared', 'h_low', 0, 0, ?, ?)`,
        'mem_low_signal',
        fixture.projectId,
        oldMs,
        oldMs
      )

      const result = await new ProductCommands().insights('quality fix-plan', fixture.projectPath, {
        md: true,
      })

      expect(result.success).toBe(true)
      expect(log.mock.calls[0]?.[0]).toContain('## Fix Plan')
      expect(log.mock.calls[0]?.[0]).toContain('mem_low_signal')
      expect(log.mock.calls[0]?.[0]).toContain('not an auto-fix')
    } finally {
      log.mockRestore()
    }
  })

  it('shows event-measured token cycles in performance output', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      recordTaskTokenUsage(fixture.projectId, 'task-event-only', 900, 100, {
        description: 'Event-only measured work',
        agent: 'codex',
      })

      const result = await new ProductCommands().performance('30', fixture.projectPath, {
        md: true,
      })

      expect(result.success).toBe(true)
      expect(result.cycles).toBe(1)
      expect(log.mock.calls[0]?.[0]).toContain('Event-only measured work')
      expect(log.mock.calls[0]?.[0]).toContain('1000')
    } finally {
      log.mockRestore()
    }
  })
})

describe('recordTaskTokenUsage — oversized counts clamp instead of vanishing', () => {
  it('clamps to the CHECK bound and marks the row estimated', async () => {
    const { recordTaskTokenUsage } = await import('../../services/work-cost-service')
    const { prjctDb } = await import('../../storage/database')
    // Marathon-session shape: input+cache beyond the 10M CHECK bound used to
    // be silently REJECTED by the constraint — token coverage read 0 forever.
    recordTaskTokenUsage(fixture.projectId, 'clamp-task', 25_000_000, 4_000_000, {
      source: 'claude-transcript',
    })
    const row = prjctDb.get<{ input_tokens: number; is_estimated: number }>(
      fixture.projectId,
      "SELECT input_tokens, is_estimated FROM token_usage WHERE work_cycle_id = 'clamp-task'"
    )
    expect(row?.input_tokens).toBe(10_000_000) // clamped, not dropped
    expect(row?.is_estimated).toBe(1) // honesty flag
  })
})
