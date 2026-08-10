/**
 * `prjct spec audit --lenses` routing.
 *
 * Pins the bug that shipped in v2.46.0: the override flag must reach the
 * audit method THROUGH routeSpec. The router forwarded only `{ md }` and
 * dropped `lenses`, so `--lenses a,b` silently fell back to the deterministic
 * baseline. The earlier tests called `cmd.audit({lenses})` directly, bypassing
 * the router — so they missed it. This drives the real dispatch path.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PrjctCommands } from '../../commands/commands'
import { routeSpec } from '../../commands/route-spec'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { specService } from '../../services/spec-service'
import prjctDb from '../../storage/database'

const fixture: {
  projectPath: string
  projectId: string
  originalProjectsDir: string | undefined
} = {
  projectPath: '',
  projectId: '',
  originalProjectsDir: undefined as unknown as string | undefined,
}

async function freshProject(): Promise<void> {
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-lensroute-pd-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir

  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-lensroute-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `lensroute-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
})

afterEach(async () => {
  if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
  if (fixture.projectPath)
    await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  // PRJCT_PROJECTS_DIR is not honored by pathManager (mem_1560), so project
  // data actually lands in ~/.prjct-cli/projects/<id>. Clean it so this test
  // does not pollute the real projects dir.
  if (fixture.projectId)
    await fs
      .rm(path.join(os.homedir(), '.prjct-cli', 'projects', fixture.projectId), {
        recursive: true,
        force: true,
      })
      .catch(() => {})
  prjctDb.close()
})

const authMigrationSpec = () =>
  specService.create(fixture.projectPath, {
    title: 'auth + migration',
    content: { goal: 'Add token auth and a DB schema migration', scope: ['core/auth/x.ts'] },
    autoContext: false,
  })

describe('routeSpec — audit forwards --lenses to the method', () => {
  test('--lenses overrides the baseline (persists exactly the given set)', async () => {
    const spec = await authMigrationSpec()
    const res = await routeSpec(
      new PrjctCommands(),
      ['audit', spec.id],
      { lenses: 'architecture,security' },
      fixture.projectPath
    )
    expect(res.success).toBe(true)
    const after = await specService.get(fixture.projectPath, spec.id)
    expect(after?.content.selected_reviewers).toEqual(['architecture', 'security'])
  })

  test('without --lenses, the deterministic baseline is used (security + data here)', async () => {
    const spec = await authMigrationSpec()
    await routeSpec(new PrjctCommands(), ['audit', spec.id], {}, fixture.projectPath)
    const after = await specService.get(fixture.projectPath, spec.id)
    expect(after?.content.selected_reviewers).toContain('security')
    expect(after?.content.selected_reviewers).toContain('data')
    expect(after?.content.selected_reviewers).not.toEqual(['architecture', 'security'])
  })
})
