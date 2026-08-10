/**
 * `prjct spec audit` — dynamic lenses, end to end.
 *
 * Pins the behavior change: audit no longer dispatches a FIXED trio
 * (strategic / architecture / design). It computes a per-spec lens set,
 * persists it as `selected_reviewers`, and the auto-promote gate checks
 * exactly that set — so a 1-lens spec promotes on a single passing review,
 * and an open-vocab lens (security/data/…) counts toward the gate.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SpecCommands } from '../../commands/spec'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { specService } from '../../services/spec-service'
import prjctDb from '../../storage/database'

const fixture: {
  projectPath: string
  projectId: string
  originalProjectsDir: string | undefined
  cmd: SpecCommands
} = {
  projectPath: '',
  projectId: '',
  originalProjectsDir: undefined as unknown as string | undefined,
  cmd: undefined as unknown as SpecCommands,
}

async function freshProject(): Promise<void> {
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-audit-lens-pd-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir

  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-audit-lens-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `lens-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
}

beforeEach(async () => {
  prjctDb.close()
  await freshProject()
  fixture.cmd = new SpecCommands()
})

afterEach(async () => {
  if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
  if (fixture.projectPath)
    await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  // PRJCT_PROJECTS_DIR is not honored by pathManager (mem_1560), so project
  // data lands in ~/.prjct-cli/projects/<id>; clean it to avoid polluting the
  // real projects dir.
  if (fixture.projectId)
    await fs
      .rm(path.join(os.homedir(), '.prjct-cli', 'projects', fixture.projectId), {
        recursive: true,
        force: true,
      })
      .catch(() => {})
  prjctDb.close()
})

describe('prjct spec audit — dynamic lenses', () => {
  test('persists a spec-shaped lens set, not the fixed trio', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'auth + migration',
      content: {
        goal: 'Add token auth and a DB schema migration for sessions',
        scope: ['core/auth/session.ts'],
      },
      autoContext: false,
    })

    const res = await fixture.cmd.audit(created.id, fixture.projectPath, {})
    expect(res.success).toBe(true)

    const lenses =
      (await specService.get(fixture.projectPath, created.id))?.content.selected_reviewers ?? []
    expect(lenses).toContain('architecture')
    expect(lenses).toContain('security')
    expect(lenses).toContain('data')
    expect(lenses).not.toContain('design') // no UI/CLI surface signalled
  })

  test('--lenses override persists exactly the given set', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'doc tweak',
      content: { goal: 'Clarify the README intro' },
      autoContext: false,
    })

    await fixture.cmd.audit(created.id, fixture.projectPath, { lenses: 'architecture' })
    expect(
      (await specService.get(fixture.projectPath, created.id))?.content.selected_reviewers
    ).toEqual(['architecture'])
  })

  test('a single-lens spec auto-promotes after ONE passing review', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'trivial',
      content: { goal: 'Fix a typo in the README' },
      autoContext: false,
    })

    await fixture.cmd.audit(created.id, fixture.projectPath, {}) // baseline → ['architecture']
    expect((await specService.get(fixture.projectPath, created.id))?.status).toBe('draft')

    const res = await fixture.cmd.recordReview(created.id, fixture.projectPath, {
      reviewer: 'architecture',
      verdict: 'pass',
      notes: 'feasible',
    })
    expect(res.success).toBe(true)
    expect((await specService.get(fixture.projectPath, created.id))?.status).toBe('reviewed')
  })

  test('open-vocab lens (security) is accepted and counts toward the gate', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'auth change',
      content: { goal: 'Add token auth to the api', scope: ['core/auth/x.ts'] },
      autoContext: false,
    })

    await fixture.cmd.audit(created.id, fixture.projectPath, { lenses: 'security' })
    const res = await fixture.cmd.recordReview(created.id, fixture.projectPath, {
      reviewer: 'security',
      verdict: 'pass',
      notes: 'threat model ok',
    })
    expect(res.success).toBe(true)
    expect((await specService.get(fixture.projectPath, created.id))?.status).toBe('reviewed')
  })

  test('does not promote until ALL selected lenses pass', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'multi lens',
      content: { goal: 'Add token auth and a DB migration', scope: ['core/auth/x.ts'] },
      autoContext: false,
    })
    await fixture.cmd.audit(created.id, fixture.projectPath, {
      lenses: 'architecture,security,data',
    })

    await fixture.cmd.recordReview(created.id, fixture.projectPath, {
      reviewer: 'architecture',
      verdict: 'pass',
      notes: 'ok',
    })
    await fixture.cmd.recordReview(created.id, fixture.projectPath, {
      reviewer: 'security',
      verdict: 'pass',
      notes: 'ok',
    })
    // data not yet recorded → still draft
    expect((await specService.get(fixture.projectPath, created.id))?.status).toBe('draft')

    await fixture.cmd.recordReview(created.id, fixture.projectPath, {
      reviewer: 'data',
      verdict: 'pass',
      notes: 'ok',
    })
    expect((await specService.get(fixture.projectPath, created.id))?.status).toBe('reviewed')
  })
})
