/**
 * WorktreeService - Git worktree management for parallel agent sessions
 *
 * Creates, lists, and manages git worktrees so each parallel agent
 * operates in an isolated copy of the repo on its own branch.
 *
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { execAsync, execFileAsync } from '../utils/exec'
import { fileExists } from '../utils/file-helper'

// Types

interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  path: string
  /** Git branch checked out in this worktree */
  branch: string
  /** HEAD commit SHA */
  commit: string
  /** Whether this is the main (bare) worktree */
  isMain: boolean
  /** Task slug used to create this worktree (from directory name) */
  slug: string
  /** Git-level lock used while a new managed worktree is being registered. */
  locked?: boolean
}

interface WorktreeCreateOptions {
  /** Custom branch name (default: feat/{slug}) */
  branch?: string
  /** Base branch to create from (default: current HEAD) */
  baseBranch?: string
}

interface WorktreeCleanOptions {
  /** Worktrees backing live cycles; never remove even when still at the base commit. */
  protectedPaths?: readonly string[]
  /** Re-check live ownership immediately before deletion to close snapshot races. */
  isProtected?: (worktreePath: string) => Promise<boolean>
}

// Constants

/** Default directory for worktrees, relative to main worktree root */
const WORKTREE_DIR = '.worktrees'

// WorktreeService

class WorktreeService {
  /**
   * Create a new git worktree for a task.
   * Creates branch feat/{slug} and worktree at .worktrees/{slug}.
   */
  async create(
    projectPath: string,
    slug: string,
    options: WorktreeCreateOptions = {}
  ): Promise<WorktreeInfo> {
    const mainPath = await this.getMainWorktree(projectPath)
    const worktreePath = path.join(mainPath, WORKTREE_DIR, slug)
    const branch = options.branch || `feat/${slug}`

    await fs.mkdir(path.join(mainPath, WORKTREE_DIR), { recursive: true })

    // Git's lock is created atomically with the worktree registration. It
    // protects the creation→task-registration window from concurrent cleanup.
    const args = [
      'worktree',
      'add',
      '--lock',
      '--reason',
      'prjct task registration in progress',
      '-b',
      branch,
      worktreePath,
      ...(options.baseBranch ? [options.baseBranch] : []),
    ]
    await execFileAsync('git', args, {
      cwd: mainPath,
    })

    // Get commit SHA
    const { stdout: commit } = await execAsync('git rev-parse HEAD', {
      cwd: worktreePath,
    })

    return {
      path: worktreePath,
      branch,
      commit: commit.trim(),
      isMain: false,
      slug,
    }
  }

  /** Release the creation lock after the task is durably registered. */
  async unlock(worktreePath: string): Promise<void> {
    // A worktree that no longer exists on disk (removed manually or by
    // `clean` after a merge) holds no lock — nothing to release.
    if (!(await fileExists(worktreePath))) return
    const mainPath = await this.getMainWorktree(worktreePath)
    const registered = (await this.list(mainPath)).find(
      (worktree) => path.resolve(worktree.path) === path.resolve(worktreePath)
    )
    if (!registered?.locked) return
    await execFileAsync('git', ['worktree', 'unlock', worktreePath], { cwd: mainPath })
  }

  /**
   * Remove a worktree and optionally delete its branch.
   */
  async remove(worktreePath: string, deleteBranch = false): Promise<void> {
    const mainPath = await this.getMainWorktree(worktreePath)

    // Get branch name before removing
    const branch = deleteBranch
      ? await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: worktreePath })
          .then(({ stdout }) => stdout.trim())
          .catch(() => undefined)
      : undefined

    // Two force flags are Git's explicit escape hatch for a locked worktree.
    // `remove(..., true)` is the rollback path for failed task registration,
    // so it must also clean the atomic creation lock.
    await execFileAsync('git', ['worktree', 'remove', '--force', '--force', worktreePath], {
      cwd: mainPath,
    })

    if (deleteBranch && branch && branch !== 'main' && branch !== 'master') {
      try {
        await execAsync(`git branch -D "${branch}"`, { cwd: mainPath })
      } catch {
        // Branch may not exist or may be checked out elsewhere
      }
    }
  }

  /**
   * List all worktrees for a project.
   */
  async list(projectPath: string): Promise<WorktreeInfo[]> {
    const mainPath = await this.getMainWorktree(projectPath)

    const { stdout } = await execAsync('git worktree list --porcelain', {
      cwd: mainPath,
    })

    return this.parsePorcelainOutput(stdout, mainPath)
  }

  /**
   * Detect if the given path is inside a git worktree (not the main tree).
   * Returns the worktree info if yes, null if in main tree or not a git repo.
   */
  async detect(cwd: string): Promise<WorktreeInfo | null> {
    try {
      const { stdout: gitCommon } = await execAsync('git rev-parse --git-common-dir', { cwd })
      const { stdout: gitDir } = await execAsync('git rev-parse --git-dir', { cwd })

      const commonDir = path.resolve(cwd, gitCommon.trim())
      const currentGitDir = path.resolve(cwd, gitDir.trim())

      // If they differ, we're in a worktree
      if (commonDir !== currentGitDir) {
        const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd })
        const { stdout: commit } = await execAsync('git rev-parse HEAD', { cwd })
        const { stdout: toplevel } = await execAsync('git rev-parse --show-toplevel', { cwd })

        const worktreePath = toplevel.trim()
        const slug = path.basename(worktreePath)

        return {
          path: worktreePath,
          branch: branch.trim(),
          commit: commit.trim(),
          isMain: false,
          slug,
        }
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * Get the path to the main (primary) worktree.
   */
  async getMainWorktree(cwd: string): Promise<string> {
    try {
      const { stdout } = await execAsync('git worktree list --porcelain', { cwd })
      const firstLine = stdout.split('\n')[0]
      if (firstLine?.startsWith('worktree ')) {
        return firstLine.replace('worktree ', '').trim()
      }
    } catch {
      // Not a git repo or git not available
    }

    // Fallback: use git toplevel
    const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd })
    return stdout.trim()
  }

  /**
   * Run post-creation setup for a worktree:
   * - Copy .env from main worktree
   * - Symlink .prjct config
   */
  async setup(worktreePath: string, mainPath: string): Promise<void> {
    // Copy .env if it exists
    const mainEnv = path.join(mainPath, '.env')
    if (await fileExists(mainEnv)) {
      await fs.copyFile(mainEnv, path.join(worktreePath, '.env'))
    }

    // Symlink .prjct directory so worktree shares the same projectId
    const mainPrjct = path.join(mainPath, '.prjct')
    const worktreePrjct = path.join(worktreePath, '.prjct')
    if ((await fileExists(mainPrjct)) && !(await fileExists(worktreePrjct))) {
      await fs.symlink(mainPrjct, worktreePrjct, 'dir')
    }
  }

  /**
   * Clean up before removing a worktree.
   */
  async teardown(_worktreePath: string): Promise<void> {
    // Future: deregister workspace session, capture snapshot, etc.
  }

  /**
   * Remove worktrees whose branches have been merged or deleted.
   */
  async clean(projectPath: string, options: WorktreeCleanOptions = {}): Promise<string[]> {
    const mainPath = await this.getMainWorktree(projectPath)
    const managedRoot = path.join(mainPath, WORKTREE_DIR)
    const currentPath = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: projectPath,
    }).then(({ stdout }) => path.resolve(stdout.trim()))
    const protectedPaths = new Set((options.protectedPaths ?? []).map((p) => path.resolve(p)))
    const beforePrune = await this.list(projectPath)
    const removed = (
      await Promise.all(
        beforePrune.map(async (wt) =>
          !wt.isMain && this.isManagedPath(wt.path, managedRoot) && !(await fileExists(wt.path))
            ? wt.slug
            : null
        )
      )
    ).filter((slug): slug is string => slug !== null)

    // Missing directories leave git metadata behind. Prune only those stale
    // registrations first; this never removes a live worktree directory.
    await execFileAsync('git', ['worktree', 'prune'], { cwd: mainPath })

    for (const wt of await this.list(projectPath)) {
      const resolvedPath = path.resolve(wt.path)
      if (
        wt.isMain ||
        wt.locked ||
        resolvedPath === currentPath ||
        protectedPaths.has(resolvedPath) ||
        (await options.isProtected?.(resolvedPath)) ||
        !this.isManagedPath(resolvedPath, managedRoot)
      ) {
        continue
      }

      const clean = await execFileAsync('git', ['status', '--porcelain'], { cwd: wt.path })
        .then(({ stdout }) => stdout.trim().length === 0)
        .catch(() => false)
      if (!clean) continue

      // The list snapshot can be stale: a task may commit after clean starts.
      // Bind ancestry to the worktree's live HEAD immediately before deletion.
      const liveHead = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: wt.path }).then(
        ({ stdout }) => stdout.trim(),
        () => null
      )
      if (!liveHead) continue

      const merged = await execFileAsync('git', ['merge-base', '--is-ancestor', liveHead, 'HEAD'], {
        cwd: mainPath,
      }).then(
        () => true,
        () => false
      )
      if (!merged) continue

      // Ownership may appear while status and ancestry checks are running.
      // Re-read it at the deletion boundary, after every slow git operation.
      if (await options.isProtected?.(resolvedPath)) continue

      // No --force and no branch deletion: git gets the final safety check,
      // and the branch remains recoverable after the directory is removed.
      await execFileAsync('git', ['worktree', 'remove', wt.path], { cwd: mainPath })
      removed.push(wt.slug)
    }

    await fs.rmdir(managedRoot).catch(() => undefined)
    return removed
  }

  // Private Helpers

  private parsePorcelainOutput(output: string, mainPath: string): WorktreeInfo[] {
    const worktrees: WorktreeInfo[] = []
    const blocks = output.trim().split('\n\n')

    for (const block of blocks) {
      if (!block.trim()) continue

      const lines = block.trim().split('\n')
      const { wtPath, commit, branch, isBare, locked } = lines.reduce(
        (info, line) => {
          if (line.startsWith('worktree ')) info.wtPath = line.replace('worktree ', '').trim()
          else if (line.startsWith('HEAD ')) info.commit = line.replace('HEAD ', '').trim()
          else if (line.startsWith('branch ')) {
            info.branch = line.replace('branch refs/heads/', '').trim()
          } else if (line === 'bare') info.isBare = true
          else if (line === 'detached') info.branch = '(detached)'
          else if (line === 'locked' || line.startsWith('locked ')) info.locked = true
          return info
        },
        { wtPath: '', commit: '', branch: '', isBare: false, locked: false }
      )

      if (wtPath) {
        const isMain = wtPath === mainPath || isBare
        worktrees.push({
          path: wtPath,
          branch,
          commit,
          isMain,
          slug: isMain ? 'main' : path.basename(wtPath),
          locked,
        })
      }
    }

    return worktrees
  }

  private isManagedPath(candidate: string, managedRoot: string): boolean {
    const relative = path.relative(path.resolve(managedRoot), path.resolve(candidate))
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
  }
}

// Singleton Export

export const worktreeService = new WorktreeService()
