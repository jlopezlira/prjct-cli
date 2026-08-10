/**
 * custom_workflows + workflow_rules pull handlers — completing the workflows
 * group round-trip. custom_workflows keys by name (stable across machines);
 * workflow_rules mirrors by source id (INSERT OR REPLACE). Neither echoes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import prjctDb from '../../storage/database'
import { syncPendingStorage } from '../../storage/sync-pending-storage'
import { customWorkflowsHandler } from '../../sync/entity-handlers/custom-workflows'
import { workflowRulesHandler } from '../../sync/entity-handlers/workflow-rules'

const fixture: {
  tempDir: string
  originalProjectsDir: string | undefined
  projectId: string
} = {
  tempDir: '',
  originalProjectsDir: undefined as unknown as string | undefined,
  projectId: '',
}

describe('workflow entity handlers', () => {
  beforeEach(async () => {
    fixture.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-wf-handler-'))
    fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
    process.env.PRJCT_PROJECTS_DIR = fixture.tempDir
    fixture.projectId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
  })

  afterEach(async () => {
    if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
    else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
    await fs.rm(fixture.tempDir, { recursive: true, force: true })
  })

  test('pulled custom_workflows stay disabled on insert and update', async () => {
    await customWorkflowsHandler.upsert(fixture.projectId, {
      id: 9,
      name: 'deploy',
      description: 'ship it',
      metadata: { steps: 2 },
      enabled: 1,
      is_builtin: 0,
    })
    await customWorkflowsHandler.upsert(fixture.projectId, {
      id: 99, // different source id, same name → still one row
      name: 'deploy',
      description: 'ship it (v2)',
      enabled: 1,
      is_builtin: 0,
    })

    const rows = prjctDb.query<{ name: string; description: string; enabled: number }>(
      fixture.projectId,
      'SELECT name, description, enabled FROM custom_workflows WHERE name = ?',
      'deploy'
    )
    expect(rows.length).toBe(1)
    expect(rows[0].description).toBe('ship it (v2)')
    expect(rows[0].enabled).toBe(0)
  })

  test('pulled custom_workflows preserve an existing local enablement decision', async () => {
    prjctDb.run(
      fixture.projectId,
      `INSERT INTO custom_workflows
         (name, description, created_at, updated_at, is_builtin, enabled, metadata)
       VALUES (?, ?, ?, ?, 0, 1, NULL)`,
      'deploy-local',
      'local definition',
      new Date().toISOString(),
      new Date().toISOString()
    )

    await customWorkflowsHandler.upsert(fixture.projectId, {
      name: 'deploy-local',
      description: 'remote metadata refresh',
      enabled: 0,
      is_builtin: 0,
    })

    const row = prjctDb.get<{ enabled: number; description: string }>(
      fixture.projectId,
      'SELECT enabled, description FROM custom_workflows WHERE name = ?',
      'deploy-local'
    )
    expect(row?.enabled).toBe(1)
    expect(row?.description).toBe('remote metadata refresh')
  })

  test('custom_workflows delete is a no-op — pulled row stays inert', async () => {
    await customWorkflowsHandler.upsert(fixture.projectId, {
      name: 'temp',
      enabled: 1,
      is_builtin: 0,
    })
    await customWorkflowsHandler.delete(fixture.projectId, { name: 'temp' })
    const row = prjctDb.get<{ enabled: number }>(
      fixture.projectId,
      'SELECT enabled FROM custom_workflows WHERE name = ?',
      'temp'
    )
    expect(row?.enabled).toBe(0)
  })

  test('custom_workflows handler does not echo to the sync queue', async () => {
    const before = syncPendingStorage.list(fixture.projectId).length
    await customWorkflowsHandler.upsert(fixture.projectId, {
      name: 'noecho',
      enabled: 1,
      is_builtin: 0,
    })
    expect(syncPendingStorage.list(fixture.projectId).length).toBe(before)
  })

  test('workflow_rules use a negative remote-id namespace and stay inert', async () => {
    await workflowRulesHandler.upsert(fixture.projectId, {
      id: 42,
      type: 'gate',
      command: 'ship',
      position: 'before',
      action: 'run tests',
      enabled: 1,
      timeout_ms: 5000,
      sort_order: 0,
    })
    await workflowRulesHandler.upsert(fixture.projectId, {
      id: 42,
      type: 'gate',
      command: 'ship',
      position: 'before',
      action: 'run tests AND lint',
      enabled: 1,
      timeout_ms: 5000,
      sort_order: 0,
    })

    const rows = prjctDb.query<{
      id: number
      action: string
      enabled: number
      trust_source: string
    }>(
      fixture.projectId,
      'SELECT id, action, enabled, trust_source FROM workflow_rules WHERE id = ?',
      -42
    )
    expect(rows.length).toBe(1)
    expect(rows[0].action).toBe('run tests AND lint')
    expect(rows[0].enabled).toBe(0)
    expect(rows[0].trust_source).toBe('imported')
  })

  test('remote rule id collision never overwrites a positive local rule', async () => {
    prjctDb.run(
      fixture.projectId,
      `INSERT INTO workflow_rules
         (id, type, command, position, action, enabled, timeout_ms, created_at,
          sort_order, parallel, trust_source)
       VALUES (42, 'step', 'ship', 'before', 'local-only', 1, 5000, ?, 0, 1, 'local')`,
      new Date().toISOString()
    )

    await workflowRulesHandler.upsert(fixture.projectId, {
      id: 42,
      type: 'step',
      command: 'ship',
      position: 'before',
      action: 'remote-payload',
      enabled: 1,
      trust_source: 'local',
    })

    const local = prjctDb.get<{ action: string; enabled: number; trust_source: string }>(
      fixture.projectId,
      'SELECT action, enabled, trust_source FROM workflow_rules WHERE id = 42'
    )
    const remote = prjctDb.get<{ action: string; enabled: number; trust_source: string }>(
      fixture.projectId,
      'SELECT action, enabled, trust_source FROM workflow_rules WHERE id = -42'
    )
    expect(local).toEqual({ action: 'local-only', enabled: 1, trust_source: 'local' })
    expect(remote).toEqual({ action: 'remote-payload', enabled: 0, trust_source: 'imported' })
  })

  test('legacy positive imported rows converge into the remote namespace', async () => {
    prjctDb.run(
      fixture.projectId,
      `INSERT INTO workflow_rules
         (id, type, command, position, action, enabled, timeout_ms, created_at,
          sort_order, parallel, trust_source)
       VALUES (9, 'step', 'ship', 'before', 'legacy', 0, 5000, ?, 0, 1, 'imported')`,
      new Date().toISOString()
    )

    await workflowRulesHandler.upsert(fixture.projectId, {
      id: 9,
      type: 'step',
      command: 'ship',
      position: 'before',
      action: 'current',
      enabled: 1,
      trust_source: 'local',
    })

    expect(prjctDb.get(fixture.projectId, 'SELECT id FROM workflow_rules WHERE id = 9')).toBeNull()
    expect(
      prjctDb.get<{ action: string; trust_source: string }>(
        fixture.projectId,
        'SELECT action, trust_source FROM workflow_rules WHERE id = -9'
      )
    ).toEqual({ action: 'current', trust_source: 'imported' })
  })

  test('workflow_rules delete is a no-op — local row is never removed', async () => {
    await workflowRulesHandler.upsert(fixture.projectId, {
      id: 7,
      type: 'step',
      command: 'task',
      position: 'after',
      action: 'note',
    })
    await workflowRulesHandler.delete(fixture.projectId, { id: 7 })
    const row = prjctDb.get<{ id: number }>(
      fixture.projectId,
      'SELECT id FROM workflow_rules WHERE id = ?',
      -7
    )
    // A remote delete never drops the local rule.
    expect(row?.id).toBe(-7)
  })

  test('ignores malformed events (missing name / id)', async () => {
    const cw = () =>
      prjctDb.get<{ c: number }>(fixture.projectId, 'SELECT COUNT(*) c FROM custom_workflows')?.c ??
      0
    const wr = () =>
      prjctDb.get<{ c: number }>(fixture.projectId, 'SELECT COUNT(*) c FROM workflow_rules')?.c ?? 0
    const beforeCw = cw()
    const beforeWr = wr()

    await customWorkflowsHandler.upsert(fixture.projectId, { description: 'no name' })
    await workflowRulesHandler.upsert(fixture.projectId, { type: 'step' }) // no id

    expect(cw()).toBe(beforeCw)
    expect(wr()).toBe(beforeWr)
  })
})
