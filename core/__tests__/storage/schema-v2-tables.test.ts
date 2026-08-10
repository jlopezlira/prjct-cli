/**
 * Schema v2 (migration 37) — the additive relational foundation exists and the
 * database stays consistent. Purely additive: no existing data is touched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { prjctDb } from '../../storage/database'

const fixture: {
  tmpRoot: string
  projectId: string
} = {
  tmpRoot: '',
  projectId: '',
}

const original = pathManager.getGlobalProjectPath.bind(pathManager)

// Only the WIRED v2 tables remain (migration 44 dropped the dead forward schema).
const V2_TABLES = [
  'memory_entries',
  'memory_entry_tags',
  'analysis_finding',
  'analysis_convention',
  'analysis_stack_item',
  'analysis_command',
  'analysis_domain',
  'spec_review',
  'spec_selected_reviewer',
  'token_usage',
  'workflow_runs',
  'workflow_run_step',
  'gate_evaluation',
]

// Dropped as dead schema (migration 44) — must NOT exist.
const DROPPED_TABLES = [
  'memory_links',
  'spec_acceptance_criterion',
  'spec_scope',
  'spec_risk',
  'spec_test_step',
  'spec_linked_task',
  'spec_tag',
  'agent_runs',
  'agent_artifact',
  'subtask_dependency',
  'task_tag',
  'shipped_feature_tag',
  'idea_tag',
  'entity_timeline',
  'context_feedback_keyword',
  'context_feedback_file',
  'crew_runs',
  'crew_run_file',
  'team_enrollment',
  'workflows',
  'workflow_config',
  'workflow_rule_condition',
]

describe('Schema v2 tables (migration 37)', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-schema-v2-'))
    fixture.projectId = `schemav2-${Math.random().toString(36).slice(2, 10)}`
    pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
    prjctDb.getDb(fixture.projectId)
  })

  afterEach(async () => {
    prjctDb.close()
    pathManager.getGlobalProjectPath = original
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
  })

  it('creates every v2 table', () => {
    const rows = prjctDb.query<{ name: string }>(
      fixture.projectId,
      "SELECT name FROM sqlite_master WHERE type='table'"
    )
    const names = new Set(rows.map((r) => r.name))
    for (const t of V2_TABLES) {
      expect(names.has(t)).toBe(true)
    }
    // Dead forward-schema tables were dropped (migration 44).
    for (const t2 of DROPPED_TABLES) {
      expect(names.has(t2)).toBe(false)
    }
  })

  it('passes integrity_check and foreign_key_check', () => {
    const integrity = prjctDb.query<{ integrity_check: string }>(
      fixture.projectId,
      'PRAGMA integrity_check'
    )
    expect(integrity[0]?.integrity_check ?? integrity[0]).toBeDefined()
    const integrityVal = Object.values(integrity[0] ?? {})[0]
    expect(integrityVal).toBe('ok')
    const fkViolations = prjctDb.query(fixture.projectId, 'PRAGMA foreign_key_check')
    expect(fkViolations.length).toBe(0)
  })

  it('token_usage rejects out-of-range and enforces event_key uniqueness', () => {
    prjctDb.run(
      fixture.projectId,
      "INSERT INTO token_usage (id, work_cycle_id, event_key, source, input_tokens, output_tokens) VALUES ('t1','c1','k1','mcp',100,50)"
    )
    // duplicate event_key must fail
    expect(() =>
      prjctDb.run(
        fixture.projectId,
        "INSERT INTO token_usage (id, work_cycle_id, event_key, source, input_tokens, output_tokens) VALUES ('t2','c1','k1','mcp',1,1)"
      )
    ).toThrow()
    // CHECK upper bound must fail
    expect(() =>
      prjctDb.run(
        fixture.projectId,
        "INSERT INTO token_usage (id, work_cycle_id, event_key, source, input_tokens, output_tokens) VALUES ('t3','c1','k2','mcp',999999999,1)"
      )
    ).toThrow()
  })
})
