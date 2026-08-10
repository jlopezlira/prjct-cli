/**
 * Workspace identity — derive a stable, per-worktree `workspaceId` from a path.
 *
 * The multi-agent runtime keys each active task to a *workspace* so parallel
 * agents (each in its own git worktree) don't clobber a single shared task.
 * This is the ONE place that decides what a workspace is; the CLI, the MCP
 * tools, and the hooks all derive identity here so there is zero drift.
 *
 * Identity rule (decision: key by git worktree):
 *   - main worktree (or a non-git path) → the sentinel `MAIN_WORKSPACE_ID`.
 *     Single-agent / single-worktree usage stays on this id, so it maps 1:1
 *     onto the legacy singular `currentTask` and behaves exactly as before.
 *   - a child worktree → `sha256Short(realpath(worktreeRoot))`. Realpath
 *     normalizes symlinks and macOS `/var`↔`/private/var`, and using the
 *     worktree ROOT (not the passed cwd) means any subdirectory of the
 *     worktree resolves to the same id.
 *
 * The returned `label` is the human/agent-facing tag (short id · branch) that
 * the output contract renders so it is always clear WHICH workspace a task
 * belongs to.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { runGit } from '../utils/exec'
import { sha256Short } from '../utils/hash'

/** Sentinel id for the main worktree (and any non-worktree path). */
export const MAIN_WORKSPACE_ID = 'main'

export interface WorkspaceContext {
  /** Stable key: `MAIN_WORKSPACE_ID` or sha256Short(realpath(worktreeRoot)). */
  workspaceId: string
  /** Realpath'd worktree root, or the passed path when not a git worktree. */
  worktreePath: string
  /** Short display id: `'main'` or the first 6 chars of the hash. */
  shortId: string
  /** Current branch, or undefined when detached / unknown. */
  branch?: string
  /** True for the main worktree or a non-git path. */
  isMain: boolean
  /** Output-contract label, e.g. `fdf22d · feat/foo` or `main · trunk`. */
  label: string
  /**
   * Set when git itself failed (timeout/spawn/overflow) and the identity above
   * is a DEGRADED main-sentinel fallback, not a verified main worktree. Write
   * paths MUST refuse to key state on it — a transient git error must never
   * bleed a linked worktree's task state into main.
   */
  gitError?: 'timeout' | 'spawn' | 'overflow'
}

/** Realpath a path, falling back to the input when it can't be resolved. */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return p
  }
}

function buildLabel(shortId: string, branch?: string): string {
  return `${shortId} · ${branch ?? '(detached)'}`
}

/**
 * Per-path memo with a short TTL. `deriveWorkspace` runs on hot paths (the
 * prompt hook fires every turn; the no-arg CLI/MCP status reads call it too),
 * so we avoid a git fork per call. The workspaceId is path-derived and never
 * changes, but the `branch`/`label` CAN change in a long-running MCP server
 * when the user checks out a different branch — the TTL bounds that staleness
 * to a few seconds while still collapsing bursts within a single turn.
 */
interface CacheEntry {
  ctx: WorkspaceContext
  at: number
}
const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5000

/**
 * Derive the workspace context for a given path (cwd or an MCP `projectPath`).
 * Never throws — degrades to the main sentinel on any git/fs failure so the
 * caller can always fall back to singular behavior. When git ITSELF failed
 * (timeout/spawn) the degraded fallback carries `gitError`: write paths must
 * refuse it (see WorkspaceContext.gitError), read-only paths may degrade.
 *
 * Uses a SINGLE `git rev-parse` invocation (multiple flags → multiple output
 * lines) instead of several sequential forks, to stay cheap on the hot path.
 */
export async function deriveWorkspace(cwd: string): Promise<WorkspaceContext> {
  const now = Date.now()
  const cached = cache.get(cwd)
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.ctx

  const ctx = await computeWorkspace(cwd)
  cache.set(cwd, { ctx, at: now })
  return ctx
}

async function computeWorkspace(cwd: string): Promise<WorkspaceContext> {
  // One fork: rev-parse prints one line per flag, in order.
  const result = await runGit(
    ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD'],
    { cwd }
  )

  if (!result.ok) {
    // Typed exit = genuinely not a git repo → main sentinel on the raw path
    // (normal, documented behavior). timeout/spawn = git is broken: the
    // sentinel is then a DEGRADED guess — flag it so write paths refuse to
    // key task state on an identity that could belong to a linked worktree.
    const worktreePath = await safeRealpath(cwd)
    return {
      workspaceId: MAIN_WORKSPACE_ID,
      worktreePath,
      shortId: MAIN_WORKSPACE_ID,
      isMain: true,
      label: buildLabel(MAIN_WORKSPACE_ID),
      ...(result.kind === 'exit' ? {} : { gitError: result.kind }),
    }
  }

  const [tl = '', gd = '', cd = '', br = ''] = result.stdout.trim().split('\n')
  const toplevel = tl.trim()
  const gitDir = gd.trim()
  const commonDir = cd.trim()
  const branch = br.trim() && br.trim() !== 'HEAD' ? br.trim() : undefined

  // A child worktree has a per-worktree git-dir distinct from the shared
  // common-dir; in the main worktree they resolve to the same directory.
  const isMain = path.resolve(cwd, gitDir) === path.resolve(cwd, commonDir)
  const worktreePath = await safeRealpath(toplevel || cwd)

  if (isMain) {
    return {
      workspaceId: MAIN_WORKSPACE_ID,
      worktreePath,
      shortId: MAIN_WORKSPACE_ID,
      branch,
      isMain: true,
      label: buildLabel(MAIN_WORKSPACE_ID, branch),
    }
  }

  const workspaceId = sha256Short(worktreePath)
  const shortId = workspaceId.slice(0, 6)
  return {
    workspaceId,
    worktreePath,
    shortId,
    branch,
    isMain: false,
    label: buildLabel(shortId, branch),
  }
}
