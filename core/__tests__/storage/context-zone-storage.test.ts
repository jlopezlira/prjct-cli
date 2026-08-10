/**
 * Context Zone Storage Tests
 *
 * Tests persistence of zone transitions and compaction events.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { contextZoneStorage } from '../../storage/context-zone-storage'
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

describe('Context Zone Storage', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-cz-test-'))
    fixture.testProjectId = 'test-cz-project'

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

  // Zone Transitions

  it('should record and retrieve zone transitions', () => {
    contextZoneStorage.recordTransition(fixture.testProjectId, {
      from: 'smart',
      to: 'warning',
      usagePercent: 42.5,
      timestamp: '2026-03-03T10:00:00Z',
      action: 'compact_recommended',
    })

    const transitions = contextZoneStorage.getTransitions(fixture.testProjectId)
    expect(transitions).toHaveLength(1)
    expect(transitions[0].from).toBe('smart')
    expect(transitions[0].to).toBe('warning')
    expect(transitions[0].usagePercent).toBe(42.5)
    expect(transitions[0].action).toBe('compact_recommended')
  })

  it('should respect limit on transitions', () => {
    for (const i of Array.from({ length: 5 }, (_, index) => index)) {
      contextZoneStorage.recordTransition(fixture.testProjectId, {
        from: 'smart',
        to: 'warning',
        usagePercent: 40 + i,
        timestamp: `2026-03-03T${10 + i}:00:00Z`,
        action: null,
      })
    }

    const limited = contextZoneStorage.getTransitions(fixture.testProjectId, 3)
    expect(limited).toHaveLength(3)
  })

  // Compaction Events

  it('should record compaction events', () => {
    contextZoneStorage.recordCompaction(fixture.testProjectId, 'truth_snapshot', 50, 12)

    // Verify via summary
    const summary = contextZoneStorage.getSummary(fixture.testProjectId, 1)
    expect(summary.compactions).toBe(1)
  })

  // Summary

  it('should return 100% smart when no transitions exist', () => {
    const summary = contextZoneStorage.getSummary(fixture.testProjectId)
    expect(summary.smartPercent).toBe(100)
    expect(summary.warningPercent).toBe(0)
    expect(summary.dumbPercent).toBe(0)
    expect(summary.compactions).toBe(0)
  })

  it('should calculate zone distribution from transitions', () => {
    // 2 transitions to warning, 1 to dumb
    contextZoneStorage.recordTransition(fixture.testProjectId, {
      from: 'smart',
      to: 'warning',
      usagePercent: 42,
      timestamp: new Date().toISOString(),
      action: null,
    })
    contextZoneStorage.recordTransition(fixture.testProjectId, {
      from: 'warning',
      to: 'warning',
      usagePercent: 50,
      timestamp: new Date().toISOString(),
      action: null,
    })
    contextZoneStorage.recordTransition(fixture.testProjectId, {
      from: 'warning',
      to: 'dumb',
      usagePercent: 65,
      timestamp: new Date().toISOString(),
      action: null,
    })

    const summary = contextZoneStorage.getSummary(fixture.testProjectId, 7)
    expect(summary.warningPercent).toBeGreaterThan(0)
    expect(summary.dumbPercent).toBeGreaterThan(0)
  })
})
