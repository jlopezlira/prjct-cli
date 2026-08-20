import fs from 'node:fs'
import path from 'node:path'

export interface RepositoryWorkflowState {
  /** Merge or rebase metadata is present in this worktree's git directory. */
  hasMergeConflicts: boolean
}

const CACHE_TTL_MS = 1_000
const cache = new Map<string, { at: number; value: RepositoryWorkflowState }>()

function gitDirectory(projectPath: string): string | null {
  const dotGit = path.join(projectPath, '.git')
  try {
    const stat = fs.statSync(dotGit)
    if (stat.isDirectory()) return dotGit
    if (!stat.isFile()) return null
    const pointer = fs
      .readFileSync(dotGit, 'utf8')
      .trim()
      .match(/^gitdir:\s*(.+)$/i)?.[1]
      ?.trim()
    if (!pointer) return null
    return path.resolve(projectPath, pointer)
  } catch {
    return null
  }
}

function exists(target: string): boolean {
  try {
    return fs.existsSync(target)
  } catch {
    return false
  }
}

/**
 * Cheap, fail-soft repository-state routing. Worktree-local git metadata is
 * enough to recognize an in-progress merge/rebase without spawning git on
 * every prompt. A short cache keeps this hot-path check effectively free.
 */
export function detectRepositoryWorkflowState(projectPath: string): RepositoryWorkflowState {
  const key = path.resolve(projectPath)
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value

  const gitDir = gitDirectory(key)
  const value = Object.freeze({
    hasMergeConflicts: Boolean(
      gitDir &&
        (exists(path.join(gitDir, 'MERGE_HEAD')) ||
          exists(path.join(gitDir, 'rebase-merge')) ||
          exists(path.join(gitDir, 'rebase-apply')))
    ),
  })
  if (cache.size > 32) cache.clear()
  cache.set(key, { at: now, value })
  return value
}

export function _resetRepositoryWorkflowStateForTests(): void {
  cache.clear()
}
