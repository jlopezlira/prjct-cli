import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { worktreeService } from '../../services/worktree-service'

const fixture: { root: string; main: string } = { root: '', main: '' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-worktree-clean-'))
  fixture.main = path.join(fixture.root, 'main')
  await fs.mkdir(fixture.main)
  git(fixture.main, 'init', '-q', '-b', 'main')
  git(fixture.main, 'config', 'user.email', 'test@prjct.local')
  git(fixture.main, 'config', 'user.name', 'test')
  await fs.writeFile(path.join(fixture.main, 'base.txt'), 'base\n')
  git(fixture.main, 'add', '.')
  git(fixture.main, 'commit', '-q', '-m', 'base')
})

afterEach(async () => {
  await fs.rm(fixture.root, { recursive: true, force: true })
})

describe('worktreeService.clean', () => {
  test('re-reads live HEAD before removing a worktree that advanced after listing', async () => {
    const advanced = path.join(fixture.main, '.worktrees', 'advanced')
    git(fixture.main, 'worktree', 'add', '-q', '-b', 'feat/advanced', advanced)
    const advancedOnce = { value: false }

    const removed = await worktreeService.clean(fixture.main, {
      isProtected: async (worktreePath) => {
        if (worktreePath !== advanced || advancedOnce.value) return false
        advancedOnce.value = true
        await fs.writeFile(path.join(advanced, 'new.txt'), 'not merged\n')
        git(advanced, 'add', '.')
        git(advanced, 'commit', '-q', '-m', 'advanced after listing')
        return false
      },
    })

    expect(removed).toEqual([])
    expect(await fs.stat(advanced)).toBeTruthy()
    expect(git(advanced, 'rev-parse', 'HEAD')).not.toBe(git(fixture.main, 'rev-parse', 'HEAD'))
  })

  test('force-removes a locked worktree when task registration rolls back', async () => {
    const created = await worktreeService.create(fixture.main, 'rollback')

    await worktreeService.remove(created.path, true)

    await expect(fs.access(created.path)).rejects.toThrow()
    expect(git(fixture.main, 'branch', '--list', created.branch)).toBe('')
  })

  test('preserves a newly created worktree until task registration unlocks it', async () => {
    const created = await worktreeService.create(fixture.main, 'creating')
    const registeredBefore = await worktreeService.list(fixture.main)

    expect(registeredBefore.find((wt) => wt.path === created.path)?.locked).toBe(true)
    expect(await worktreeService.clean(fixture.main)).toEqual([])
    expect(await fs.stat(created.path)).toBeTruthy()

    await worktreeService.unlock(created.path)
    await expect(worktreeService.unlock(created.path)).resolves.toBeUndefined()
    expect(await worktreeService.clean(fixture.main)).toEqual(['creating'])
    await expect(fs.access(created.path)).rejects.toThrow()
  })

  test('removes only stale, clean, merged prjct-managed worktrees', async () => {
    const managedRoot = path.join(fixture.main, '.worktrees')
    const merged = path.join(managedRoot, 'merged')
    const active = path.join(managedRoot, 'active')
    const dirty = path.join(managedRoot, 'dirty')
    const missing = path.join(managedRoot, 'missing')
    const userOwned = path.join(fixture.root, 'user-owned')
    const liveRecheck = path.join(managedRoot, 'live-recheck')

    git(fixture.main, 'worktree', 'add', '-q', '-b', 'feat/merged', merged)
    await fs.writeFile(path.join(merged, 'merged.txt'), 'merged\n')
    git(merged, 'add', '.')
    git(merged, 'commit', '-q', '-m', 'merged work')
    git(fixture.main, 'merge', '-q', '--no-ff', 'feat/merged', '-m', 'merge feature')

    git(fixture.main, 'worktree', 'add', '-q', '-b', 'feat/active', active)
    git(fixture.main, 'worktree', 'add', '-q', '-b', 'feat/dirty', dirty)
    await fs.writeFile(path.join(dirty, 'untracked.txt'), 'keep me\n')
    git(fixture.main, 'worktree', 'add', '-q', '-b', 'feat/missing', missing)
    await fs.rm(missing, { recursive: true, force: true })
    git(fixture.main, 'worktree', 'add', '-q', '-b', 'feat/user-owned', userOwned)
    git(fixture.main, 'worktree', 'add', '-q', '-b', 'feat/live-recheck', liveRecheck)

    const liveOwnership = { checks: 0 }
    const removed = await worktreeService.clean(fixture.main, {
      protectedPaths: [active],
      isProtected: async (worktreePath) => {
        if (worktreePath !== liveRecheck) return false
        liveOwnership.checks += 1
        return liveOwnership.checks > 1
      },
    })

    expect(removed.sort()).toEqual(['merged', 'missing'])
    await expect(fs.access(merged)).rejects.toThrow()
    await expect(fs.access(missing)).rejects.toThrow()
    expect(await fs.stat(active)).toBeTruthy()
    expect(await fs.stat(dirty)).toBeTruthy()
    expect(await fs.stat(userOwned)).toBeTruthy()
    expect(await fs.stat(liveRecheck)).toBeTruthy()
    expect(liveOwnership.checks).toBe(2)
    const registered = git(fixture.main, 'worktree', 'list', '--porcelain')
    expect(registered).not.toContain(merged)
    expect(registered).not.toContain(missing)
    expect(registered).toContain(active)
    expect(registered).toContain(dirty)
    expect(registered).toContain(userOwned)
    expect(registered).toContain(liveRecheck)
  })
})
