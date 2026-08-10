/**
 * Workspace identity derivation. Builds a REAL git repo + worktree in a temp
 * dir so the git-common-dir detection runs for real (not mocked), then asserts
 * the identity rules the multi-agent layer relies on: deterministic per
 * worktree, distinct across worktrees, stable from a subdirectory, and the
 * main-worktree sentinel.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { exec } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { deriveWorkspace, MAIN_WORKSPACE_ID } from '../../services/workspace-id'

const execAsync = promisify(exec)

async function createWorkspaceFixture(): Promise<{
  root: string
  mainRepo: string
  wtA: string
  wtB: string
}> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-ws-')))
  const mainRepo = path.join(root, 'repo')
  await fs.mkdir(mainRepo, { recursive: true })

  const git = (cmd: string, cwd: string) => execAsync(`git ${cmd}`, { cwd })
  await git('init -q', mainRepo)
  await git('config user.email t@t.io', mainRepo)
  await git('config user.name test', mainRepo)
  await fs.writeFile(path.join(mainRepo, 'f.txt'), 'hi')
  await git('add -A', mainRepo)
  await git('commit -q -m init', mainRepo)

  const wtA = path.join(root, 'wt-a')
  const wtB = path.join(root, 'wt-b')
  await git(`worktree add -q "${wtA}" -b feat-a`, mainRepo)
  await git(`worktree add -q "${wtB}" -b feat-b`, mainRepo)

  return { root, mainRepo, wtA, wtB }
}

const workspaceFixture = createWorkspaceFixture()

afterAll(async () => {
  const { root } = await workspaceFixture
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
})

describe('deriveWorkspace', () => {
  test('main worktree → sentinel id, isMain', async () => {
    const { mainRepo } = await workspaceFixture
    const ws = await deriveWorkspace(mainRepo)
    expect(ws.workspaceId).toBe(MAIN_WORKSPACE_ID)
    expect(ws.isMain).toBe(true)
    expect(ws.shortId).toBe(MAIN_WORKSPACE_ID)
  })

  test('child worktree → hashed id, not main', async () => {
    const { wtA } = await workspaceFixture
    const ws = await deriveWorkspace(wtA)
    expect(ws.workspaceId).not.toBe(MAIN_WORKSPACE_ID)
    expect(ws.isMain).toBe(false)
    expect(ws.workspaceId).toHaveLength(16)
    expect(ws.branch).toBe('feat-a')
    expect(ws.label).toContain('feat-a')
  })

  test('deterministic — same worktree, same id', async () => {
    const { wtA } = await workspaceFixture
    const a1 = await deriveWorkspace(wtA)
    const a2 = await deriveWorkspace(wtA)
    expect(a1.workspaceId).toBe(a2.workspaceId)
  })

  test('distinct worktrees → distinct ids', async () => {
    const { wtA, wtB } = await workspaceFixture
    const a = await deriveWorkspace(wtA)
    const b = await deriveWorkspace(wtB)
    expect(a.workspaceId).not.toBe(b.workspaceId)
  })

  test('subdirectory of a worktree → same id as its root', async () => {
    const { wtA } = await workspaceFixture
    const sub = path.join(wtA, 'src', 'deep')
    await fs.mkdir(sub, { recursive: true })
    const rootWs = await deriveWorkspace(wtA)
    const subWs = await deriveWorkspace(sub)
    expect(subWs.workspaceId).toBe(rootWs.workspaceId)
    expect(subWs.isMain).toBe(false)
  })

  test('non-git path → main sentinel (degrade, never throw)', async () => {
    const { root } = await workspaceFixture
    const plain = path.join(root, 'not-a-repo')
    await fs.mkdir(plain, { recursive: true })
    const ws = await deriveWorkspace(plain)
    expect(ws.workspaceId).toBe(MAIN_WORKSPACE_ID)
    expect(ws.isMain).toBe(true)
  })
})

/**
 * PATH-hijack: an empty dir as PATH means `git` resolves nowhere, so spawn
 * fails with a real ENOENT — exercises the infra-failure path without mocks.
 */
async function withBrokenGit<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-no-git-'))
  const oldPath = process.env.PATH
  process.env.PATH = dir
  try {
    return await fn()
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

describe('deriveWorkspace — degraded identity (WS1)', () => {
  test('git infra failure → main sentinel FLAGGED with gitError (write paths refuse)', async () => {
    if (process.platform === 'win32') return
    const { wtA } = await workspaceFixture
    // Fresh path — deriveWorkspace memoizes per cwd for 5s.
    const fresh = path.join(wtA, 'fresh-sub')
    await fs.mkdir(fresh, { recursive: true })
    await withBrokenGit(async () => {
      const ws = await deriveWorkspace(fresh)
      expect(ws.workspaceId).toBe(MAIN_WORKSPACE_ID)
      expect(ws.isMain).toBe(true)
      expect(ws.gitError).toBe('spawn')
    })
  })
})
