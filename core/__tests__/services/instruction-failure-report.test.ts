import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import {
  buildInstructionFailureReport,
  parseInstructionReportWindow,
  renderInstructionFailureReportMd,
} from '../../services/instruction-failure-report'
import { prjctDb } from '../../storage/database'
import { instructionFailureStorage } from '../../storage/instruction-failure-storage'

const fixture: { tmpRoot: string; projectId: string } = { tmpRoot: '', projectId: '' }
const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

describe('instruction failure report', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-instruction-report-'))
    fixture.projectId = `instruction-report-${Math.random().toString(36).slice(2, 10)}`
    pathManager.getGlobalProjectPath = (projectId: string) => path.join(fixture.tmpRoot, projectId)
    prjctDb.getDb(fixture.projectId)
  })

  afterEach(async () => {
    prjctDb.close()
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
  })

  it('accepts only the documented windows and defaults to 7d', () => {
    expect(parseInstructionReportWindow(undefined)).toBe('7d')
    expect(parseInstructionReportWindow('24h')).toBe('24h')
    expect(parseInstructionReportWindow('14d')).toBe('14d')
    expect(() => parseInstructionReportWindow('90d')).toThrow('Invalid instruction window')
  })

  it('distinguishes no observability from observed sessions with zero failures', () => {
    const none = buildInstructionFailureReport(fixture.projectId, '7d', {
      now: new Date('2026-08-11T12:00:00.000Z'),
    })
    expect(none.state).toBe('no-observability')
    expect(none.total).toBe(0)

    prjctDb.run(
      fixture.projectId,
      `INSERT INTO agent_sessions (id, project_id, started_at, runtime, model, created_at)
       VALUES ('observed-1', ?, '2026-08-11T10:00:00.000Z', 'codex', 'gpt-5.6', '2026-08-11T10:00:00.000Z')`,
      fixture.projectId
    )
    const clean = buildInstructionFailureReport(fixture.projectId, '7d', {
      now: new Date('2026-08-11T12:00:00.000Z'),
    })
    expect(clean.state).toBe('zero-failures')
    expect(clean.sessionAttributionRate).toBe(1)
    expect(renderInstructionFailureReportMd(clean)).toContain('0 instruction failures')
  })

  it('reports attribution, grouped dispositions, legacy inputs, and a single-stream false-positive rate', () => {
    const occurredAt = '2026-08-11T10:00:00.000Z'
    const shared = {
      source: 'friction-detector',
      runtime: 'codex',
      model: 'gpt-5',
      taskId: 'task-1',
      category: 'scope-creep',
      expectedBehavior: 'Stay in scope.',
      observedBehavior: 'Expanded scope.',
      relatedRuleId: 'scope-rule',
      occurredAt,
    }
    instructionFailureStorage.record(fixture.projectId, { ...shared, sessionId: 'session-1' })
    const resolved = instructionFailureStorage.record(fixture.projectId, {
      ...shared,
      sessionId: 'session-2',
      category: 'skill-miss',
    }).failure
    const falsePositive = instructionFailureStorage.record(fixture.projectId, {
      ...shared,
      runtime: 'unknown',
      model: 'unknown',
      sessionId: 'session-3',
      category: 'process-safety',
    }).failure
    instructionFailureStorage.setDisposition(fixture.projectId, resolved.id, 'resolved')
    instructionFailureStorage.setDisposition(fixture.projectId, falsePositive.id, 'false_positive')
    // Deliberately unrelated to the 3 failures above (different session
    // ids, no shared id) — guidanceActivations is reported as its own
    // volume metric, but must NOT feed falseTriggerRate's denominator
    // (that was the bug: dividing across two uncorrelated event streams
    // produced a coincidental ratio, not a real false-positive rate).
    for (const index of [1, 2, 3, 4]) {
      instructionFailureStorage.recordGuidanceActivation(fixture.projectId, {
        sessionId: `activation-${index}`,
        ruleId: 'scope-rule',
      })
    }

    prjctDb.run(
      fixture.projectId,
      `INSERT INTO memory_entries
       (id, project_id, type, content, provenance, content_hash, created_at, updated_at)
       VALUES ('mem_legacy', ?, 'improvement-signal', 'legacy', 'automatic', 'legacy-hash', ?, ?)`,
      fixture.projectId,
      new Date(occurredAt).getTime(),
      new Date(occurredAt).getTime()
    )
    prjctDb.run(
      fixture.projectId,
      `INSERT INTO memory_entry_tags (entry_id, key, value, is_machine)
       VALUES ('mem_legacy', 'source', 'skill-miss-detector', 0)`
    )

    const report = buildInstructionFailureReport(fixture.projectId, '7d', {
      now: new Date('2026-08-11T12:00:00.000Z'),
    })
    expect(report).toMatchObject({
      state: 'failures-observed',
      total: 3,
      attributed: 2,
      attributionRate: 2 / 3,
      open: 1,
      resolved: 1,
      falsePositive: 1,
      guidanceActivations: 4,
      falseTriggerRate: 1 / 3,
      legacyUnattributedInputs: 1,
    })
    expect(report.groups).toHaveLength(3)
    expect(report.unresolved).toHaveLength(1)
    expect(report.unresolved[0]?.observedBehavior).toBe('Expanded scope.')
    expect(renderInstructionFailureReportMd(report)).toContain('Legacy unattributed inputs: 1')
    expect(renderInstructionFailureReportMd(report)).toContain('## Open cases')
  })
})
