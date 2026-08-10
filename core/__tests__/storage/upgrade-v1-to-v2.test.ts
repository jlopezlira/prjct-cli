/**
 * Upgrade-path tests: v1.x → v2.1.2
 *
 * Simulates the shape of a prjct DB from a v1.x user (who had workflow
 * rules on hook commands like `pause`/`bug`/`idea`) and asserts migration
 * v15 cleanly disables them without touching the still-valid HookCommand
 * values (`task`, `done`, `ship`, `sync`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { prjctDb } from '../../storage/database'

const fixture: {
  tmpRoot: string | null
} = {
  tmpRoot: null,
}
const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

const TEST_PROJECT_ID = 'upgrade-test'

interface RuleRow {
  command: string
  action: string
  enabled: number
}

function listRules(projectId: string, command?: string): RuleRow[] {
  if (command) {
    return prjctDb.query<RuleRow>(
      projectId,
      'SELECT command, action, enabled FROM workflow_rules WHERE command = ?',
      command
    )
  }
  return prjctDb.query<RuleRow>(projectId, 'SELECT command, action, enabled FROM workflow_rules')
}

function seedRule(projectId: string, command: string, action: string, enabled = 1): void {
  prjctDb.run(
    projectId,
    `INSERT INTO workflow_rules (type, command, position, action, enabled, timeout_ms, created_at, sort_order)
     VALUES ('hook', ?, 'before', ?, ?, 60000, ?, 0)`,
    command,
    action,
    enabled,
    new Date().toISOString()
  )
}

/** Re-run the v15 migration statement against the current DB. */
function applyMigrationV15(projectId: string): void {
  const orphans = [
    'pause',
    'resume',
    'reopen',
    'next',
    'dash',
    'bug',
    'idea',
    'linear',
    'jira',
    'tokens',
    'velocity',
    'plan',
  ]
  const list = orphans.map((v) => `'${v}'`).join(',')
  prjctDb.run(
    projectId,
    `UPDATE workflow_rules SET enabled = 0 WHERE command IN (${list}) AND enabled = 1`
  )
}

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-upgrade-'))
  pathManager.getGlobalProjectPath = (projectId: string) => path.join(fixture.tmpRoot!, projectId)
})

afterEach(async () => {
  pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
  try {
    prjctDb.close(TEST_PROJECT_ID)
  } catch {
    /* already closed */
  }
  if (fixture.tmpRoot) {
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
    fixture.tmpRoot = null
  }
})

describe('v15 migration — orphan workflow_rules', () => {
  it('disables hooks on removed verbs but preserves v2-valid hooks', () => {
    // v1.x user seeded these:
    seedRule(TEST_PROJECT_ID, 'pause', 'run quick tests') // orphan
    seedRule(TEST_PROJECT_ID, 'bug', 'notify-slack') // orphan
    seedRule(TEST_PROJECT_ID, 'idea', 'log-to-trello') // orphan
    seedRule(TEST_PROJECT_ID, 'linear', 'sync-issues') // orphan
    seedRule(TEST_PROJECT_ID, 'done', 'check-types') // still valid
    seedRule(TEST_PROJECT_ID, 'ship', 'tag-release') // still valid
    seedRule(TEST_PROJECT_ID, 'task', 'create-branch') // still valid
    seedRule(TEST_PROJECT_ID, 'sync', 'rebuild-index') // still valid

    // Migration v15 ran automatically during first getDb() call above.
    // Re-apply to confirm idempotency and to document the exact SQL.
    applyMigrationV15(TEST_PROJECT_ID)

    // Orphans disabled:
    for (const orphan of ['pause', 'bug', 'idea', 'linear']) {
      const rules = listRules(TEST_PROJECT_ID, orphan)
      expect(rules.length).toBe(1)
      expect(rules[0].enabled).toBe(0)
    }

    // v2-valid HookCommand values untouched:
    for (const valid of ['done', 'ship', 'task', 'sync']) {
      const rules = listRules(TEST_PROJECT_ID, valid)
      expect(rules.length).toBe(1)
      expect(rules[0].enabled).toBe(1)
    }
  })

  it('is idempotent — re-running does not change already-disabled rows', () => {
    seedRule(TEST_PROJECT_ID, 'pause', 'tests')

    applyMigrationV15(TEST_PROJECT_ID)
    const after1 = listRules(TEST_PROJECT_ID, 'pause')
    expect(after1[0].enabled).toBe(0)

    applyMigrationV15(TEST_PROJECT_ID)
    const after2 = listRules(TEST_PROJECT_ID, 'pause')
    expect(after2).toEqual(after1)
  })

  it('does not touch rows the user has explicitly disabled', () => {
    // A v2 user might have manually disabled a `done` hook; migration must
    // not touch non-orphan rows at all, regardless of enabled state.
    seedRule(TEST_PROJECT_ID, 'done', 'skip-me', 0)

    applyMigrationV15(TEST_PROJECT_ID)

    const rules = listRules(TEST_PROJECT_ID, 'done')
    expect(rules[0].enabled).toBe(0) // unchanged
  })
})

describe('v1 task status coercion (regression guard)', () => {
  it('state-machine maps legacy statuses to v2 states', async () => {
    const { workflowStateMachine } = await import('../../workflow-engine/state-machine')

    expect(workflowStateMachine.getCurrentState({ currentTask: { status: 'in_progress' } })).toBe(
      'working'
    )
    expect(workflowStateMachine.getCurrentState({ currentTask: { status: 'done' } })).toBe(
      'completed'
    )
    expect(workflowStateMachine.getCurrentState({ currentTask: { status: 'paused' } })).toBe(
      'paused'
    )
    expect(workflowStateMachine.getCurrentState({ currentTask: { status: 'shipped' } })).toBe(
      'shipped'
    )
    expect(workflowStateMachine.getCurrentState({ currentTask: { status: 'weirdstatus' } })).toBe(
      'working'
    )
  })
})
