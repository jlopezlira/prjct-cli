/**
 * Regression: getProjectId must NOT silently mint a random orphan project.
 *
 * Root cause it guards against: getProjectId() used to fall through to
 * pathManager.generateProjectId() === crypto.randomUUID() whenever
 * readConfig() returned null. Any path-resolution miss (daemon resolving
 * the wrong cwd, config transiently unreadable) forked a brand-new
 * project, scattering specs/memory across ghost projects with no error.
 *
 * Contract now: an uninitialized path resolves to '' (falsy sentinel
 * every caller already guards with `if (!projectId)`), never a UUID.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'

const fixture: {
  dir: string
} = {
  dir: '',
}

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-getpid-'))
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

describe('getProjectId — no silent orphan mint', () => {
  test('uninitialized path → empty string, NOT a random uuid', async () => {
    const id = await configManager.getProjectId(fixture.dir)
    expect(id).toBe('')
    // Belt: never a uuid-shaped value
    expect(id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i)
  })

  test('two consecutive calls on an uninitialized path are stable (no fork)', async () => {
    const a = await configManager.getProjectId(fixture.dir)
    const b = await configManager.getProjectId(fixture.dir)
    expect(a).toBe('')
    expect(b).toBe('')
    expect(a).toBe(b)
  })

  test('initialized path → the config projectId, unchanged', async () => {
    await fs.mkdir(path.join(fixture.dir, '.prjct'), { recursive: true })
    await configManager.writeConfig(fixture.dir, {
      projectId: 'bc401c41-c8b9-436a-ac78-c91cac82ab4f',
      dataPath: path.join(fixture.dir, '.prjct-data'),
    } as Parameters<typeof configManager.writeConfig>[1])

    const id = await configManager.getProjectId(fixture.dir)
    expect(id).toBe('bc401c41-c8b9-436a-ac78-c91cac82ab4f')
  })
})
