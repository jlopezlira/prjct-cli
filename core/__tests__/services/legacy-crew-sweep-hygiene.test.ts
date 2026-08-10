/**
 * Worktree hygiene: every `prjct sync` must purge `.prjct/sessions|audits|deploy`
 * from the customer working tree and rewrite crew agent files that still
 * instruct disk writes there.
 *
 * Customer #3 (2026-07): templates were fixed years ago, but customized
 * agent files kept telling agents to dump plan.md under `.prjct/sessions/`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import {
  containsForbiddenWriteInstruction,
  FORBIDDEN_WORKTREE_WRITE_NEEDLES,
  legacyCrewSweep,
  WORKTREE_GHOST_DIRS,
} from '../../services/legacy-crew-sweep'
import { prjctDb } from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const STALE_LEADER = `---
name: leader
description: stale
---

# Leader

Write a plan to \`.prjct/sessions/<task-slug>/plan.md\` then hand off.
Subagents write to \`.prjct/sessions/<task-slug>/<role>.md\`.
`

const CLEAN_LEADER = `---
name: leader
description: clean
---

# Leader

Never write reports to disk. Use prjct CLI verbs only.
`

describe('legacyCrewSweep — worktree hygiene', () => {
  const fixture: {
    projectPath: string
    projectId: string
  } = {
    projectPath: '',
    projectId: '',
  }

  beforeEach(async () => {
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-hygiene-'))
    await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
    fixture.projectId = `hygiene-${Math.random().toString(36).slice(2, 10)}`
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
    })
    patchPathManager(fixture.projectPath)
    prjctDb.get(fixture.projectId, 'SELECT 1')
  })

  afterEach(async () => {
    restorePathManager()
    if (fixture.projectPath)
      await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  })

  test('exports the hard-law ghost dir + needle lists', () => {
    expect([...WORKTREE_GHOST_DIRS]).toEqual(['sessions', 'audits', 'deploy'])
    expect(FORBIDDEN_WORKTREE_WRITE_NEEDLES.some((n) => n.includes('sessions'))).toBe(true)
  })

  test('detects affirmative write instructions, not mere bans', () => {
    expect(
      containsForbiddenWriteInstruction(
        'Write a plan to `.prjct/sessions/<task-slug>/plan.md` then hand off.'
      )
    ).toBe(true)
    expect(containsForbiddenWriteInstruction('done -> .prjct/sessions/<task-slug>/impl.md')).toBe(
      true
    )
    // "Hide under ~/.prjct-cli" is still a physical file — forbidden
    expect(
      containsForbiddenWriteInstruction(
        'SESSION_ROOT = ~/.prjct-cli/projects/abc/sessions\nWrite under SESSION_ROOT/<task-slug>/'
      )
    ).toBe(true)
    // Ban-only text must NOT force-refresh (false positive protection)
    expect(
      containsForbiddenWriteInstruction(
        'Never write `.prjct/sessions/` into the customer worktree. Forbidden path.'
      )
    ).toBe(false)
    expect(
      containsForbiddenWriteInstruction(
        'No client-tree session dumps (`.prjct/sessions/**` must not exist).'
      )
    ).toBe(false)
  })

  test('purges .prjct/sessions and ingests content into SQLite (no disk re-home)', async () => {
    const sessionsDir = path.join(fixture.projectPath, '.prjct', 'sessions', 'some-task')
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.writeFile(path.join(sessionsDir, 'plan.md'), '# plan body for SQL ingest\n', 'utf-8')

    const result = await legacyCrewSweep(fixture.projectPath, fixture.projectId)

    expect(result.ghostDirsPurged).toContain('sessions')
    expect(result.ghostFilesIngested).toBeGreaterThanOrEqual(1)

    // Gone from customer worktree — never re-homed onto another disk path
    await expect(
      fs.access(path.join(fixture.projectPath, '.prjct', 'sessions'))
    ).rejects.toBeDefined()

    // Traceable in SQLite via remember/events
    const { projectMemory } = await import('../../memory/project-memory')
    const hits = projectMemory.recall(fixture.projectId, { types: ['context'], limit: 25 })
    expect(hits.some((h) => h.content.includes('plan body for SQL ingest'))).toBe(true)

    // Idempotent: second run is a quiet no-op
    const again = await legacyCrewSweep(fixture.projectPath, fixture.projectId)
    expect(again.ghostDirsPurged).toEqual([])
    expect(again.ghostFilesIngested).toBe(0)
  })

  test('purges .prjct/audits and .prjct/deploy without rescue', async () => {
    await fs.mkdir(path.join(fixture.projectPath, '.prjct', 'audits'), { recursive: true })
    await fs.writeFile(path.join(fixture.projectPath, '.prjct', 'audits', 'x.md'), 'x', 'utf-8')
    await fs.mkdir(path.join(fixture.projectPath, '.prjct', 'deploy'), { recursive: true })
    await fs.writeFile(path.join(fixture.projectPath, '.prjct', 'deploy', 'check.md'), 'y', 'utf-8')

    const result = await legacyCrewSweep(fixture.projectPath, fixture.projectId)

    expect(result.ghostDirsPurged.sort()).toEqual(['audits', 'deploy'])
    await expect(
      fs.access(path.join(fixture.projectPath, '.prjct', 'audits'))
    ).rejects.toBeDefined()
    await expect(
      fs.access(path.join(fixture.projectPath, '.prjct', 'deploy'))
    ).rejects.toBeDefined()
    // config still there
    const configStat = await fs.stat(path.join(fixture.projectPath, '.prjct', 'prjct.config.json'))
    expect(configStat.isFile()).toBe(true)
  })

  test('repairs stale crew agent files that instruct .prjct/sessions/ writes', async () => {
    const leaderPath = path.join(fixture.projectPath, '.claude', 'agents', 'leader.md')
    await fs.mkdir(path.dirname(leaderPath), { recursive: true })
    await fs.writeFile(leaderPath, STALE_LEADER, 'utf-8')

    // Clean sibling must be left alone
    const implPath = path.join(fixture.projectPath, '.claude', 'agents', 'implementer.md')
    await fs.writeFile(implPath, CLEAN_LEADER, 'utf-8')

    const result = await legacyCrewSweep(fixture.projectPath, fixture.projectId)

    expect(result.agentFilesRepaired).toContain('.claude/agents/leader.md')
    expect(result.agentFilesRepaired).not.toContain('.claude/agents/implementer.md')

    const repaired = await fs.readFile(leaderPath, 'utf-8')
    expect(repaired).not.toContain('.prjct/sessions/')
    // Current template hard law is present
    expect(repaired.toLowerCase()).toMatch(/sqlite|never write|prjct/)

    const untouched = await fs.readFile(implPath, 'utf-8')
    expect(untouched).toBe(CLEAN_LEADER)
  })

  test('repairs CLAUDE.md crew block that still points at .prjct/sessions/', async () => {
    const claude = [
      '# My project',
      '',
      '<!-- prjct:crew:start - DO NOT REMOVE THIS MARKER -->',
      'Write results to `.prjct/sessions/<task-slug>/<role>.md`.',
      '<!-- prjct:crew:end - DO NOT REMOVE THIS MARKER -->',
      '',
    ].join('\n')
    await fs.writeFile(path.join(fixture.projectPath, 'CLAUDE.md'), claude, 'utf-8')

    const result = await legacyCrewSweep(fixture.projectPath, fixture.projectId)

    expect(result.agentFilesRepaired).toContain('CLAUDE.md')
    const next = await fs.readFile(path.join(fixture.projectPath, 'CLAUDE.md'), 'utf-8')
    expect(next).toContain('# My project')
    expect(next).toContain('<!-- prjct:crew:start')
    expect(next).not.toContain('.prjct/sessions/')
    expect(next).toMatch(/Hard persistence rule|Never write/i)
  })

  test('does not touch a clean tree', async () => {
    const result = await legacyCrewSweep(fixture.projectPath, fixture.projectId)
    expect(result.ghostDirsPurged).toEqual([])
    expect(result.agentFilesRepaired).toEqual([])
    expect(result.errors).toEqual([])
  })

  test('collapses duplicate CLAUDE.md crew blocks (short end marker + append)', async () => {
    const claude = [
      '# My project',
      '',
      '<!-- prjct:crew:start - DO NOT REMOVE THIS MARKER -->',
      'Write results to `.prjct/sessions/<task-slug>/<role>.md`.',
      '<!-- prjct:crew:end -->',
      '',
      '<!-- prjct:crew:start - DO NOT REMOVE THIS MARKER -->',
      'Second block already clean.',
      '<!-- prjct:crew:end - DO NOT REMOVE THIS MARKER -->',
      '',
    ].join('\n')
    await fs.writeFile(path.join(fixture.projectPath, 'CLAUDE.md'), claude, 'utf-8')

    const result = await legacyCrewSweep(fixture.projectPath, fixture.projectId)
    expect(result.agentFilesRepaired).toContain('CLAUDE.md')

    const next = await fs.readFile(path.join(fixture.projectPath, 'CLAUDE.md'), 'utf-8')
    expect(next).toContain('# My project')
    expect((next.match(/prjct:crew:start/g) ?? []).length).toBe(1)
    expect((next.match(/prjct:crew:end/g) ?? []).length).toBe(1)
    expect(next).not.toContain('.prjct/sessions/<task')
    expect(next).toMatch(/Hard persistence rule|Never write/i)
  })
})

describe('legacyCrewSweep — client .prjct config-only', () => {
  const fixture: {
    projectPath: string
    projectId: string
  } = {
    projectPath: '',
    projectId: '',
  }

  beforeEach(async () => {
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-cfgonly-'))
    await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
    fixture.projectId = `cfg-${Math.random().toString(36).slice(2, 10)}`
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
    })
    patchPathManager(fixture.projectPath)
    prjctDb.get(fixture.projectId, 'SELECT 1')
  })

  afterEach(async () => {
    restorePathManager()
    if (fixture.projectPath)
      await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  })

  test('migrates CHECKPOINTS.md to SQLite then deletes it from client tree', async () => {
    const cp = path.join(fixture.projectPath, '.prjct', 'CHECKPOINTS.md')
    await fs.writeFile(cp, '# CHECKPOINTS\n- [ ] custom gate\n', 'utf-8')

    const result = await legacyCrewSweep(fixture.projectPath, fixture.projectId)
    expect(result.checkpointsMigrated).toBe(true)
    expect(result.clientPrjctJunkPurged).toContain('CHECKPOINTS.md')
    await expect(fs.access(cp)).rejects.toBeDefined()

    // still only config
    const entries = await fs.readdir(path.join(fixture.projectPath, '.prjct'))
    expect(entries).toEqual(['prjct.config.json'])
  })

  test('migrates team.json then deletes — no disk mirror left', async () => {
    const tj = path.join(fixture.projectPath, '.prjct', 'team.json')
    await fs.writeFile(
      tj,
      JSON.stringify({
        required: true,
        minVersion: '3.0.0',
        enrolledAt: '2026-01-01T00:00:00.000Z',
        enrolledBy: 'test',
      }),
      'utf-8'
    )

    const result = await legacyCrewSweep(fixture.projectPath, fixture.projectId)
    expect(result.teamMigrated).toBe(true)
    expect(result.clientPrjctJunkPurged).toContain('team.json')
    await expect(fs.access(tj)).rejects.toBeDefined()
    const entries = await fs.readdir(path.join(fixture.projectPath, '.prjct'))
    expect(entries).toEqual(['prjct.config.json'])
  })

  test('second sync is quiet no-op when only config remains', async () => {
    await legacyCrewSweep(fixture.projectPath, fixture.projectId)
    const again = await legacyCrewSweep(fixture.projectPath, fixture.projectId)
    expect(again.clientPrjctJunkPurged).toEqual([])
    expect(again.ghostDirsPurged).toEqual([])
    expect(again.errors).toEqual([])
  })
})
