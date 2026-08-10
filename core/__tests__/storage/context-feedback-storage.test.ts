/**
 * Context Feedback Storage Tests
 *
 * Tests the RL feedback loop for file suggestion improvement:
 * - Recording suggestions at task start
 * - Completing feedback with actual files and precision/recall
 * - Historical boost calculations
 * - Cold start behavior
 * - Keyword overlap filtering
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { contextFeedbackStorage } from '../../storage/context-feedback-storage'
import { prjctDb } from '../../storage/database'

// Test Setup

const fixture: {
  tmpRoot: string
  testProjectId: string
} = {
  tmpRoot: '',
  testProjectId: '',
}

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

describe('Context Feedback Storage', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-cf-test-'))
    fixture.testProjectId = 'test-cf-project'

    pathManager.getGlobalProjectPath = (projectId: string) => path.join(fixture.tmpRoot, projectId)

    await fs.mkdir(path.join(fixture.tmpRoot, fixture.testProjectId), { recursive: true })

    // Initialize the database (triggers all migrations)
    prjctDb.getDb(fixture.testProjectId)
  })

  afterEach(async () => {
    prjctDb.close()
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath

    if (fixture.tmpRoot) {
      await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
    }
  })

  // Recording Suggestions

  it('should record suggestions and persist to DB', () => {
    contextFeedbackStorage.recordSuggestions(
      fixture.testProjectId,
      'task-1',
      ['auth', 'login', 'user'],
      ['src/auth/login.ts', 'src/models/user.ts']
    )

    const row = prjctDb.get<{ task_id: string; keywords: string; suggested_files: string }>(
      fixture.testProjectId,
      'SELECT task_id, keywords, suggested_files FROM context_feedback WHERE task_id = ?',
      'task-1'
    )

    expect(row).not.toBeNull()
    expect(row!.task_id).toBe('task-1')
    expect(JSON.parse(row!.keywords)).toEqual(['auth', 'login', 'user'])
    expect(JSON.parse(row!.suggested_files)).toEqual(['src/auth/login.ts', 'src/models/user.ts'])
  })

  // Completing Feedback

  it('should calculate precision and recall correctly', () => {
    // Suggested 2 files, only 1 was actually used, but user also used 1 extra
    contextFeedbackStorage.recordSuggestions(
      fixture.testProjectId,
      'task-2',
      ['auth', 'login'],
      ['src/auth/login.ts', 'src/auth/session.ts']
    )

    contextFeedbackStorage.completeFeedback(fixture.testProjectId, 'task-2', [
      'src/auth/login.ts',
      'src/auth/middleware.ts',
    ])

    const row = prjctDb.get<{
      precision: number
      recall: number
      actual_files: string
      completed_at: string
    }>(
      fixture.testProjectId,
      'SELECT precision, recall, actual_files, completed_at FROM context_feedback WHERE task_id = ?',
      'task-2'
    )

    expect(row).not.toBeNull()
    // Precision: 1 correct out of 2 suggested = 0.5
    expect(row!.precision).toBe(0.5)
    // Recall: 1 found out of 2 actual = 0.5
    expect(row!.recall).toBe(0.5)
    expect(JSON.parse(row!.actual_files)).toEqual(['src/auth/login.ts', 'src/auth/middleware.ts'])
    expect(row!.completed_at).toBeTruthy()
  })

  it('should handle perfect precision and recall', () => {
    contextFeedbackStorage.recordSuggestions(
      fixture.testProjectId,
      'task-3',
      ['button', 'component'],
      ['src/components/Button.tsx']
    )

    contextFeedbackStorage.completeFeedback(fixture.testProjectId, 'task-3', [
      'src/components/Button.tsx',
    ])

    const row = prjctDb.get<{ precision: number; recall: number }>(
      fixture.testProjectId,
      'SELECT precision, recall FROM context_feedback WHERE task_id = ?',
      'task-3'
    )

    expect(row!.precision).toBe(1)
    expect(row!.recall).toBe(1)
  })

  // Historical Boosts

  it('should return positive scores for previously-relevant files', () => {
    // Record a completed task where auth files were actually used
    contextFeedbackStorage.recordSuggestions(
      fixture.testProjectId,
      'task-a',
      ['auth', 'login'],
      ['src/auth/login.ts']
    )
    contextFeedbackStorage.completeFeedback(fixture.testProjectId, 'task-a', [
      'src/auth/login.ts',
      'src/auth/middleware.ts',
    ])

    // Query boosts for a similar task
    const boosts = contextFeedbackStorage.getHistoricalBoosts(fixture.testProjectId, [
      'auth',
      'session',
    ])

    // auth/login.ts and auth/middleware.ts should have positive boosts
    expect(boosts.get('src/auth/login.ts')).toBeGreaterThan(0)
    expect(boosts.get('src/auth/middleware.ts')).toBeGreaterThan(0)
  })

  it('should return negative scores for false-positive suggestions', () => {
    // Record a task where suggested file was NOT actually used
    contextFeedbackStorage.recordSuggestions(
      fixture.testProjectId,
      'task-b',
      ['auth', 'login'],
      ['src/auth/login.ts', 'src/unrelated/file.ts']
    )
    contextFeedbackStorage.completeFeedback(fixture.testProjectId, 'task-b', ['src/auth/login.ts'])

    const boosts = contextFeedbackStorage.getHistoricalBoosts(fixture.testProjectId, [
      'auth',
      'login',
    ])

    // unrelated/file.ts was suggested but not used — should be penalized
    expect(boosts.get('src/unrelated/file.ts')).toBeLessThan(0)
    // login.ts was both suggested and used — should be boosted
    expect(boosts.get('src/auth/login.ts')).toBeGreaterThan(0)
  })

  it('should return empty map on cold start (no data)', () => {
    const boosts = contextFeedbackStorage.getHistoricalBoosts(fixture.testProjectId, [
      'auth',
      'login',
    ])
    expect(boosts.size).toBe(0)
  })

  it('should return empty map for empty keywords', () => {
    contextFeedbackStorage.recordSuggestions(
      fixture.testProjectId,
      'task-c',
      ['auth'],
      ['src/auth/login.ts']
    )
    contextFeedbackStorage.completeFeedback(fixture.testProjectId, 'task-c', ['src/auth/login.ts'])

    const boosts = contextFeedbackStorage.getHistoricalBoosts(fixture.testProjectId, [])
    expect(boosts.size).toBe(0)
  })

  it('should filter by keyword overlap — unrelated tasks should not influence', () => {
    // Task about auth
    contextFeedbackStorage.recordSuggestions(
      fixture.testProjectId,
      'task-auth',
      ['auth', 'login', 'session'],
      ['src/auth/login.ts']
    )
    contextFeedbackStorage.completeFeedback(fixture.testProjectId, 'task-auth', [
      'src/auth/login.ts',
      'src/auth/session.ts',
    ])

    // Task about database (completely different keywords)
    contextFeedbackStorage.recordSuggestions(
      fixture.testProjectId,
      'task-db',
      ['database', 'migration', 'schema'],
      ['src/db/migration.ts']
    )
    contextFeedbackStorage.completeFeedback(fixture.testProjectId, 'task-db', [
      'src/db/migration.ts',
      'src/db/schema.ts',
    ])

    // Query boosts for a new auth task — DB files should NOT appear
    const boosts = contextFeedbackStorage.getHistoricalBoosts(fixture.testProjectId, [
      'auth',
      'password',
    ])

    // Auth files should be boosted (keyword overlap with auth task)
    expect(boosts.has('src/auth/login.ts') || boosts.has('src/auth/session.ts')).toBe(true)

    // DB files should NOT be boosted (no keyword overlap)
    expect(boosts.has('src/db/migration.ts')).toBe(false)
    expect(boosts.has('src/db/schema.ts')).toBe(false)
  })

  it('should normalize scores to [-1, 1] range', () => {
    // Create multiple feedback entries to accumulate scores
    for (const i of Array.from({ length: 5 }, (_, index) => index)) {
      contextFeedbackStorage.recordSuggestions(
        fixture.testProjectId,
        `task-norm-${i}`,
        ['component', 'button'],
        ['src/components/Button.tsx', 'src/utils/helpers.ts']
      )
      contextFeedbackStorage.completeFeedback(fixture.testProjectId, `task-norm-${i}`, [
        'src/components/Button.tsx',
      ])
    }

    const boosts = contextFeedbackStorage.getHistoricalBoosts(fixture.testProjectId, [
      'component',
      'button',
    ])

    for (const [, score] of boosts) {
      expect(score).toBeGreaterThanOrEqual(-1)
      expect(score).toBeLessThanOrEqual(1)
    }
  })
})
