/**
 * SessionStart surfaces project-understanding STALENESS — ceiling (a) for #1.
 *
 * The architecture/risks map is built at `prjct sync`. When code drifts past it,
 * the harness must say so once per session so the model refreshes instead of
 * trusting a frozen snapshot. Gated on GENUINE drift (commits since a real
 * sync), so a never-synced bootstrap doesn't nag every session.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildSessionContext } from '../../hooks/session-start'
import pathManager from '../../infrastructure/path-manager'
import { createStalenessChecker } from '../../services/staleness-checker'
import { prjctDb } from '../../storage/database'
import type { LocalConfig } from '../../types/config'

let tmpRoot: string
let repo: string
const projectId = 'staleness-session-test'
const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: repo, encoding: 'utf-8' }).trim()
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stale-sess-'))
  repo = path.join(tmpRoot, 'repo')
  await fs.mkdir(repo, { recursive: true })
  pathManager.getGlobalProjectPath = (id: string) => path.join(tmpRoot, id)
  git('init -b main')
  git('config user.email e@e.com')
  git('config user.name e')
  await fs.writeFile(path.join(repo, 'f.txt'), 'base\n')
  git('add -A')
  git('commit -qm base')
})

afterEach(async () => {
  prjctDb.close(projectId)
  pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
})

const cfg = { projectId } as unknown as LocalConfig

describe('SessionStart — understanding staleness', () => {
  it('surfaces a drift notice when code moved well past the last sync', async () => {
    const synced = git('rev-parse --short HEAD')
    prjctDb.setDoc(projectId, 'project', {
      name: 'x',
      lastSync: new Date(Date.now() - 86_400_000).toISOString(),
      lastSyncCommit: synced,
    })
    // 12 commits of drift — past the 10-commit threshold.
    for (let i = 0; i < 12; i++) {
      await fs.appendFile(path.join(repo, 'f.txt'), `c${i}\n`)
      git(`commit -qam c${i}`)
    }
    const r = await buildSessionContext(repo, cfg, { digest: false })
    expect(r).not.toBeNull()
    expect(r).toContain('Understanding may be stale')
    expect(r).toContain('12 commits')
  })

  it('stays silent on drift when the sync is current (identity still ok)', async () => {
    const head = git('rev-parse --short HEAD')
    prjctDb.setDoc(projectId, 'project', {
      name: 'x',
      lastSync: new Date().toISOString(),
      lastSyncCommit: head, // synced AT head → zero commits since
    })
    const r = await buildSessionContext(repo, cfg, { digest: false })
    // No persona, no digest, no drift → identity only (L1 cwd), no staleness nag.
    expect(r).not.toBeNull()
    expect(r).toContain('## Project identity (cwd)')
    expect(r).not.toContain('Understanding may be stale')
    expect(r).not.toContain('commits since')
  })

  it('keeps exact commit counts and unique final changed paths for low drift', async () => {
    const synced = git('rev-parse --short HEAD')
    prjctDb.setDoc(projectId, 'project', {
      name: 'x',
      lastSync: new Date().toISOString(),
      lastSyncCommit: synced,
    })

    await fs.appendFile(path.join(repo, 'f.txt'), 'first\n')
    git('commit -qam first')
    await fs.writeFile(path.join(repo, 'package.json'), '{"name":"staleness-fixture"}\n')
    git('add package.json')
    git('commit -qm package')
    await fs.appendFile(path.join(repo, 'f.txt'), 'last\n')
    git('commit -qam last')

    const status = await createStalenessChecker(repo).check(projectId)
    expect(status.commitsSinceSync).toBe(3)
    expect([...status.changedFiles].sort()).toEqual(['f.txt', 'package.json'])
    expect(status.significantChanges).toEqual(['package.json'])
  })
})
