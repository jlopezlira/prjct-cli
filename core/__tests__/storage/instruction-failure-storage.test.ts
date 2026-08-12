import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { prjctDb } from '../../storage/database'
import { instructionFailureStorage } from '../../storage/instruction-failure-storage'

const fixture: { tmpRoot: string; projectId: string } = { tmpRoot: '', projectId: '' }
const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

const baseInput = {
  source: 'friction-detector',
  runtime: 'codex',
  model: 'gpt-5',
  sessionId: 'session-1',
  taskId: 'task-1',
  category: 'scope-creep',
  expectedBehavior: 'Keep the original task scope.',
  observedBehavior: 'Added an unrelated refactor.',
  relatedRuleId: 'rule-scope',
  occurredAt: '2026-08-11T12:00:00.000Z',
}

describe('instruction failure storage', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-instruction-ledger-'))
    fixture.projectId = `instruction-${Math.random().toString(36).slice(2, 10)}`
    pathManager.getGlobalProjectPath = (projectId: string) => path.join(fixture.tmpRoot, projectId)
    prjctDb.getDb(fixture.projectId)
  })

  afterEach(async () => {
    prjctDb.close()
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
  })

  it('migration 64 creates the exact ledger columns and query indexes', () => {
    const sessionColumns = prjctDb
      .query<{ name: string }>(fixture.projectId, 'PRAGMA table_info(agent_sessions)')
      .map((row) => row.name)
    expect(sessionColumns).toContain('runtime')
    expect(sessionColumns).toContain('model')
    const columns = prjctDb
      .query<{ name: string }>(fixture.projectId, 'PRAGMA table_info(instruction_failures)')
      .map((row) => row.name)
    expect(columns).toEqual([
      'id',
      'project_id',
      'dedup_key',
      'source',
      'runtime',
      'model',
      'session_id',
      'task_id',
      'category',
      'expected_behavior',
      'observed_behavior',
      'related_rule_id',
      'disposition',
      'occurred_at',
      'created_at',
    ])
    const indexes = new Set(
      prjctDb
        .query<{ name: string }>(
          fixture.projectId,
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'instruction_failures'"
        )
        .map((row) => row.name)
    )
    expect(indexes.has('ix_instruction_failures_project_occurred')).toBe(true)
    expect(indexes.has('ix_instruction_failures_runtime_model')).toBe(true)
    expect(indexes.has('ix_instruction_failures_disposition_occurred')).toBe(true)
  })

  it('records idempotently using normalized expected and observed behavior', () => {
    const first = instructionFailureStorage.record(fixture.projectId, baseInput)
    const duplicate = instructionFailureStorage.record(fixture.projectId, {
      ...baseInput,
      expectedBehavior: '  keep   the ORIGINAL task scope. ',
      observedBehavior: 'added an unrelated   REFACTOR.',
      runtime: 'claude',
      model: 'opus',
    })

    expect(first.inserted).toBe(true)
    expect(duplicate.inserted).toBe(false)
    expect(duplicate.failure.id).toBe(first.failure.id)
    expect(
      prjctDb.get<{ value: number }>(
        fixture.projectId,
        'SELECT COUNT(*) AS value FROM instruction_failures'
      )?.value
    ).toBe(1)
  })

  it('backfills a real runtime/model onto a row first recorded as unknown, instead of locking it forever', () => {
    // Regression: dedupKeyFor() intentionally excludes runtime/model (the
    // same underlying failure can have attribution resolve late or
    // inconsistently) — a later occurrence with real attribution must not
    // be silently dropped by the dedup collapse, leaving the row stuck at
    // whatever the first occurrence happened to record.
    const first = instructionFailureStorage.record(fixture.projectId, {
      ...baseInput,
      runtime: 'unknown',
      model: 'unknown',
    })
    expect(first.inserted).toBe(true)
    expect(first.failure.runtime).toBe('unknown')
    expect(first.failure.model).toBe('unknown')

    const second = instructionFailureStorage.record(fixture.projectId, {
      ...baseInput,
      runtime: 'codex',
      model: 'gpt-5',
    })
    expect(second.inserted).toBe(false)
    expect(second.failure.id).toBe(first.failure.id)
    expect(second.failure.runtime).toBe('codex')
    expect(second.failure.model).toBe('gpt-5')

    // Once attributed, a later 'unknown' occurrence must not clobber it back.
    const third = instructionFailureStorage.record(fixture.projectId, {
      ...baseInput,
      runtime: 'unknown',
      model: 'unknown',
    })
    expect(third.failure.runtime).toBe('codex')
    expect(third.failure.model).toBe('gpt-5')

    expect(
      prjctDb.get<{ value: number }>(
        fixture.projectId,
        'SELECT COUNT(*) AS value FROM instruction_failures'
      )?.value
    ).toBe(1)
  })

  it('updates dispositions and prunes only old non-open rows', () => {
    const oldResolved = instructionFailureStorage.record(fixture.projectId, {
      ...baseInput,
      sessionId: 'old-resolved',
      occurredAt: '2026-01-01T00:00:00.000Z',
    }).failure
    const oldOpen = instructionFailureStorage.record(fixture.projectId, {
      ...baseInput,
      sessionId: 'old-open',
      category: 'skill-miss',
      occurredAt: '2026-01-01T00:00:00.000Z',
    }).failure
    const recentResolved = instructionFailureStorage.record(fixture.projectId, {
      ...baseInput,
      sessionId: 'recent-resolved',
      occurredAt: '2026-08-01T00:00:00.000Z',
    }).failure
    instructionFailureStorage.setDisposition(fixture.projectId, oldResolved.id, 'resolved')
    instructionFailureStorage.setDisposition(fixture.projectId, recentResolved.id, 'resolved')

    expect(
      instructionFailureStorage.pruneRetained(
        fixture.projectId,
        new Date('2026-08-11T00:00:00.000Z')
      )
    ).toBe(1)
    expect(instructionFailureStorage.getById(fixture.projectId, oldResolved.id)).toBeNull()
    expect(instructionFailureStorage.getById(fixture.projectId, oldOpen.id)?.disposition).toBe(
      'open'
    )
    expect(instructionFailureStorage.getById(fixture.projectId, recentResolved.id)).not.toBeNull()
  })
})
