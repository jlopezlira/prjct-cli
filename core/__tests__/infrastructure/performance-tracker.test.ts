/**
 * PerformanceTracker Tests
 *
 * Tests for:
 * - Timing marks (start/end)
 * - Memory snapshots
 * - Metric recording to SQLite
 * - Context correctness recording
 * - Subtask handoff recording
 * - Report generation
 *
 * @see PRJ-297
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { performanceTracker } from '../../infrastructure/performance-tracker'
import prjctDb from '../../storage/database'

// Test Setup

const fixture: {
  tmpRoot: string | null
  testProjectId: string
} = {
  tmpRoot: null,
  testProjectId: '',
}

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

describe('PerformanceTracker', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-perf-test-'))
    fixture.testProjectId = 'test-project-perf'

    pathManager.getGlobalProjectPath = (projectId: string) => {
      return path.join(fixture.tmpRoot!, projectId)
    }
  })

  afterEach(async () => {
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath

    // Close SQLite connection before cleaning up
    prjctDb.close(fixture.testProjectId)

    if (fixture.tmpRoot) {
      await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
      fixture.tmpRoot = null
    }
  })

  // Timing Tests

  describe('timing marks', () => {
    it('should measure elapsed time between start and end', async () => {
      performanceTracker.markStart('test-op')

      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 10))

      const durationMs = performanceTracker.markEnd('test-op')
      expect(durationMs).not.toBeNull()
      expect(durationMs!).toBeGreaterThan(0)
      expect(durationMs!).toBeLessThan(1000) // Shouldn't take more than 1s
    })

    it('should return null for non-existent mark', () => {
      const result = performanceTracker.markEnd('nonexistent')
      expect(result).toBeNull()
    })

    it('should clean up marks after end', () => {
      performanceTracker.markStart('cleanup-test')
      performanceTracker.markEnd('cleanup-test')

      // Second call should return null
      const result = performanceTracker.markEnd('cleanup-test')
      expect(result).toBeNull()
    })
  })

  // Memory Tests

  describe('memory snapshots', () => {
    it('should return valid memory snapshot', () => {
      const snapshot = performanceTracker.snapshotMemory()

      expect(snapshot.heapUsed).toBeGreaterThan(0)
      expect(snapshot.heapTotal).toBeGreaterThan(0)
      expect(snapshot.rss).toBeGreaterThan(0)
      expect(snapshot.external).toBeGreaterThanOrEqual(0)
      expect(snapshot.heapTotal).toBeGreaterThan(1024 * 1024) // > 1MB
    })

    it('should record memory to SQLite', () => {
      const snapshot = performanceTracker.recordMemory(fixture.testProjectId)

      expect(snapshot.heapUsed).toBeGreaterThan(0)

      // Verify events were written to SQLite
      const events = prjctDb.query<{ type: string; data: string }>(
        fixture.testProjectId,
        'SELECT metric AS type, data FROM perf_samples ORDER BY id'
      )

      // Should have 4 entries (heap_used, heap_total, rss, external_memory)
      expect(events.length).toBe(4)
      expect(events.map((e) => e.type)).toEqual([
        'heap_used',
        'heap_total',
        'rss',
        'external_memory',
      ])
    })
  })

  // Recording Tests

  describe('metric recording', () => {
    it('should record timing metric to SQLite', () => {
      performanceTracker.recordTiming(fixture.testProjectId, 'startup_time', 350.5)

      const events = prjctDb.query<{ type: string; data: string }>(
        fixture.testProjectId,
        "SELECT metric AS type, data FROM perf_samples WHERE metric = 'startup_time'"
      )

      expect(events.length).toBe(1)
      const parsed = JSON.parse(events[0].data)
      expect(parsed.metric).toBe('startup_time')
      expect(parsed.value).toBe(350.5)
      expect(parsed.unit).toBe('ms')
    })

    it('should record timing with context', () => {
      performanceTracker.recordTiming(fixture.testProjectId, 'command_duration', 120, {
        command: 'sync',
      })

      const events = prjctDb.query<{ data: string }>(
        fixture.testProjectId,
        "SELECT data FROM perf_samples WHERE metric = 'command_duration'"
      )

      const parsed = JSON.parse(events[0].data)
      expect(parsed.context).toEqual({ command: 'sync' })
    })

    it('should append multiple metrics', () => {
      performanceTracker.recordTiming(fixture.testProjectId, 'startup_time', 300)
      performanceTracker.recordTiming(fixture.testProjectId, 'startup_time', 250)
      performanceTracker.recordTiming(fixture.testProjectId, 'command_duration', 50)

      const events = prjctDb.query<{ type: string }>(
        fixture.testProjectId,
        'SELECT metric AS type FROM perf_samples'
      )

      expect(events.length).toBe(3)
    })

    it('does not write new telemetry into the events log', () => {
      performanceTracker.recordTiming(fixture.testProjectId, 'command_duration', 50, {
        command: 'status',
      })
      performanceTracker.recordMemory(fixture.testProjectId)

      const telemetryEvents = prjctDb.query<{ n: number }>(
        fixture.testProjectId,
        "SELECT COUNT(*) AS n FROM events WHERE type LIKE 'perf.%'"
      )
      const samples = prjctDb.query<{ n: number }>(
        fixture.testProjectId,
        'SELECT COUNT(*) AS n FROM perf_samples'
      )

      expect(telemetryEvents[0]?.n).toBe(0)
      expect(samples[0]?.n).toBe(5)
    })
  })

  // Context Correctness Tests

  describe('context correctness', () => {
    it('should record context correctness entry', () => {
      performanceTracker.recordContextCorrectness(fixture.testProjectId, {
        taskId: 'task_123',
        receivedSync: true,
        syncFieldsInjected: ['analysis', 'patterns'],
      })

      const events = prjctDb.query<{ data: string }>(
        fixture.testProjectId,
        "SELECT data FROM perf_samples WHERE metric = 'context_correctness'"
      )

      expect(events.length).toBe(1)
      const parsed = JSON.parse(events[0].data)
      expect(parsed.metric).toBe('context_correctness')
      expect(parsed.taskId).toBe('task_123')
      expect(parsed.receivedSync).toBe(true)
    })
  })

  // Subtask Handoff Tests

  describe('subtask handoff', () => {
    it('should record handoff entry', () => {
      performanceTracker.recordSubtaskHandoff(fixture.testProjectId, {
        taskId: 'task_456',
        subtaskId: 'subtask-001',
        outputPopulated: true,
      })

      const events = prjctDb.query<{ data: string }>(
        fixture.testProjectId,
        "SELECT data FROM perf_samples WHERE metric = 'subtask_handoff'"
      )

      expect(events.length).toBe(1)
      const parsed = JSON.parse(events[0].data)
      expect(parsed.metric).toBe('subtask_handoff')
      expect(parsed.outputPopulated).toBe(true)
    })
  })

  // Report Generation Tests

  describe('report generation', () => {
    it('should return empty report when no data', () => {
      const report = performanceTracker.getReport(fixture.testProjectId)

      expect(report.period).toBe('7d')
      expect(report.startup).toBeUndefined()
      expect(report.memory).toBeUndefined()
      expect(report.contextCorrectness).toBeUndefined()
      expect(report.subtaskHandoff).toBeUndefined()
    })

    it('should aggregate startup time metrics', () => {
      performanceTracker.recordTiming(fixture.testProjectId, 'startup_time', 300)
      performanceTracker.recordTiming(fixture.testProjectId, 'startup_time', 400)
      performanceTracker.recordTiming(fixture.testProjectId, 'startup_time', 500)

      const report = performanceTracker.getReport(fixture.testProjectId)

      expect(report.startup).toBeDefined()
      expect(report.startup!.avg).toBe(400)
      expect(report.startup!.min).toBe(300)
      expect(report.startup!.max).toBe(500)
      expect(report.startup!.count).toBe(3)
    })

    it('should aggregate memory metrics', () => {
      performanceTracker.recordMemory(fixture.testProjectId)

      const report = performanceTracker.getReport(fixture.testProjectId)

      expect(report.memory).toBeDefined()
      expect(report.memory!.avgHeapMB).toBeGreaterThan(0)
      expect(report.memory!.peakHeapMB).toBeGreaterThan(0)
    })

    it('should aggregate context correctness', () => {
      performanceTracker.recordContextCorrectness(fixture.testProjectId, {
        taskId: 't1',
        receivedSync: true,
      })
      performanceTracker.recordContextCorrectness(fixture.testProjectId, {
        taskId: 't2',
        receivedSync: false,
      })

      const report = performanceTracker.getReport(fixture.testProjectId)

      expect(report.contextCorrectness).toBeDefined()
      expect(report.contextCorrectness!.total).toBe(2)
      expect(report.contextCorrectness!.receivedSync).toBe(1)
      expect(report.contextCorrectness!.rate).toBe(50)
    })

    it('should aggregate subtask handoff', () => {
      performanceTracker.recordSubtaskHandoff(fixture.testProjectId, {
        taskId: 't1',
        subtaskId: 's1',
        outputPopulated: true,
      })
      performanceTracker.recordSubtaskHandoff(fixture.testProjectId, {
        taskId: 't1',
        subtaskId: 's2',
        outputPopulated: true,
      })
      performanceTracker.recordSubtaskHandoff(fixture.testProjectId, {
        taskId: 't1',
        subtaskId: 's3',
        outputPopulated: false,
      })

      const report = performanceTracker.getReport(fixture.testProjectId)

      expect(report.subtaskHandoff).toBeDefined()
      expect(report.subtaskHandoff!.total).toBe(3)
      expect(report.subtaskHandoff!.outputPopulated).toBe(2)
      expect(report.subtaskHandoff!.rate).toBe(67)
    })

    it('should aggregate command durations', () => {
      performanceTracker.recordTiming(fixture.testProjectId, 'command_duration', 100, {
        command: 'sync',
      })
      performanceTracker.recordTiming(fixture.testProjectId, 'command_duration', 200, {
        command: 'sync',
      })
      performanceTracker.recordTiming(fixture.testProjectId, 'command_duration', 50, {
        command: 'status',
      })

      const report = performanceTracker.getReport(fixture.testProjectId)

      expect(report.commandDurations).toBeDefined()
      expect(report.commandDurations!.sync).toBeDefined()
      expect(report.commandDurations!.sync.avg).toBe(150)
      expect(report.commandDurations!.sync.count).toBe(2)
      expect(report.commandDurations!.status).toBeDefined()
      expect(report.commandDurations!.status.avg).toBe(50)
    })

    it('should filter by date range', () => {
      // Record some metrics
      performanceTracker.recordTiming(fixture.testProjectId, 'startup_time', 300)

      // Report for 0 days (should find nothing before today)
      const report = performanceTracker.getReport(fixture.testProjectId, 0)
      // With 0 days, sinceDate = today, so entries from "now" should still match
      // because the filter is >= sinceIso (same day)
      expect(report.startup).toBeDefined()
    })
  })
})
