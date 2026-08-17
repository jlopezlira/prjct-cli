/**
 * Multi-workspace work overview — the read-side counterpart to task-service.
 *
 * One place that answers "what is active, and in which workspace?" so every
 * surface (CLI `prjct work` no-arg + legacy status, the MCP prjct_task_status
 * tool, and the session hooks) renders the SAME workspace-labelled view and
 * agrees on which work cycle belongs to the caller's worktree. This is what makes
 * the per-workspace state observable instead of silently singular.
 */

import type { CurrentTask, TaskHarness, WorkspaceTask } from '../schemas/state'
import { stateStorage } from '../storage/state-storage'
import { getTaskPipelineState, type TaskPipelineState } from '../storage/task-pipeline-storage'
import { runGit } from '../utils/exec'
import { deriveWorkspace, MAIN_WORKSPACE_ID } from './workspace-id'

export interface ActiveTaskView {
  id: string
  description: string
  workspaceId: string
  /** Short display id: `main` or the first 6 chars of the hash. */
  shortId: string
  /** `shortId · branch` — the workspace label rendered to users. */
  label: string
  branch?: string
  /** Linear issue id when the task is linked (preserved for `--md` output). */
  linearId?: string
  harness?: TaskHarness
  startedAt: string
  /** True when this task belongs to the caller's current worktree. */
  isCurrent: boolean
  pipeline?: TaskPipelineState
}

export interface TaskOverview {
  /** The caller's own workspace task, if any. */
  current: ActiveTaskView | null
  /** Every active task across the project, current-first. */
  all: ActiveTaskView[]
  /**
   * The main worktree's full task record (turnCount, tokens, owner…) —
   * `current` is the narrower cross-consumer projection. Callers that need
   * fields outside `ActiveTaskView` (e.g. buildProjectState) should read
   * this instead of issuing their own follow-up `getCurrentTask` fetch.
   * Set whenever a main-worktree task exists, regardless of which
   * workspace the caller is in (the snapshot already fetched it, so
   * exposing it costs nothing); null only when the main worktree is idle.
   */
  mainTaskRaw: CurrentTask | null
}

function labelFor(workspaceId: string, branch?: string): { shortId: string; label: string } {
  const shortId = workspaceId === MAIN_WORKSPACE_ID ? MAIN_WORKSPACE_ID : workspaceId.slice(0, 6)
  return { shortId, label: `${shortId} · ${branch ?? '(detached)'}` }
}

/**
 * Zombie sweep (fail-soft). activeTasks entries outlive their worktree when
 * the worktree is deleted without completing the cycle — the only other
 * removal path is an explicit complete. Cross-check each entry's worktreePath
 * against `git worktree list` (one spawn) and archive the ones whose path is
 * gone. Gated strictly on path non-existence, never on age: entries without
 * a worktreePath stay, and any git failure keeps the full list untouched.
 */
async function pruneOrphanedWorkspaceTasks(
  projectId: string,
  projectPath: string,
  activeTasks: WorkspaceTask[]
): Promise<WorkspaceTask[]> {
  const candidates = activeTasks.filter((t) => t.worktreePath)
  if (candidates.length === 0) return activeTasks

  const result = await runGit(['worktree', 'list', '--porcelain'], {
    cwd: projectPath,
    timeoutMs: 2000,
  })
  if (!result.ok) return activeTasks

  const livePaths = new Set(
    result.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())
  )
  const orphaned = candidates.filter((t) => !livePaths.has(t.worktreePath as string))
  if (orphaned.length === 0) return activeTasks

  const orphanedIds = new Set(orphaned.map((t) => t.workspaceId))
  await stateStorage.archiveOrphanedWorkspaceTasks(projectId, orphanedIds)
  return activeTasks.filter((t) => !orphanedIds.has(t.workspaceId))
}

/**
 * Collect the active task for the caller's worktree plus every other active
 * task in the project. `current` is resolved by deriving the caller's
 * workspaceId from `projectPath`; the main worktree maps onto the singular
 * currentTask, child worktrees onto their activeTasks[] slot.
 */
export async function collectActiveTasks(
  projectId: string,
  projectPath: string
): Promise<TaskOverview> {
  const ws = await deriveWorkspace(projectPath)
  const views: ActiveTaskView[] = []

  // One read for both — see getTaskSnapshot's docstring: getCurrentTask +
  // getActiveTasks each independently hit SQLite (daemon bypasses the doc
  // cache), so calling both back to back was 2 fetches of the same doc.
  const snapshot = await stateStorage.getTaskSnapshot(projectId)

  // Main worktree task (singular currentTask), surfaced as the `main` workspace.
  const mainTask = snapshot.currentTask
  if (mainTask) {
    const { shortId, label } = labelFor(MAIN_WORKSPACE_ID, mainTask.branch)
    views.push({
      id: mainTask.id,
      description: mainTask.description,
      workspaceId: MAIN_WORKSPACE_ID,
      shortId,
      label,
      branch: mainTask.branch,
      linearId: mainTask.linearId,
      harness: mainTask.harness,
      startedAt: mainTask.startedAt,
      isCurrent: ws.workspaceId === MAIN_WORKSPACE_ID,
      pipeline: getTaskPipelineState(projectId, mainTask.id, MAIN_WORKSPACE_ID) ?? undefined,
    })
  }

  // Child-worktree tasks (activeTasks[]). Defensive: skip any stray entry
  // tagged as the main workspace so it can never double-count with currentTask.
  // Zombie entries (worktree deleted) are archived by the sweep first.
  const activeTasks = await pruneOrphanedWorkspaceTasks(
    projectId,
    projectPath,
    snapshot.activeTasks
  )
  for (const t of activeTasks) {
    if (t.workspaceId === MAIN_WORKSPACE_ID) continue
    const { shortId, label } = labelFor(t.workspaceId, t.branch)
    views.push({
      id: t.id,
      description: t.description,
      workspaceId: t.workspaceId,
      shortId,
      label,
      branch: t.branch,
      linearId: t.linearId,
      harness: t.harness,
      startedAt: t.startedAt,
      isCurrent: ws.workspaceId === t.workspaceId,
      pipeline: getTaskPipelineState(projectId, t.id, t.workspaceId) ?? undefined,
    })
  }

  views.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent))
  const current = views.find((v) => v.isCurrent) ?? null
  return { current, all: views, mainTaskRaw: mainTask }
}

/** One-line plain-text rendering of a task with its workspace marker. */
export function formatActiveTaskLine(v: ActiveTaskView): string {
  const marker = v.isCurrent ? '→' : ' '
  const here = v.isCurrent ? '  (this worktree)' : ''
  return `${marker} ${v.label}    ${v.description}${here}`
}

/** Multi-workspace list view shared by legacy status and MCP task_status. */
export function formatActiveTaskList(overview: TaskOverview): string {
  if (overview.all.length === 0) return 'No active work cycle.'
  if (overview.all.length === 1 && overview.current) {
    const v = overview.current
    const pipeline = v.pipeline ? `\n  Pipeline: ${v.pipeline.station}` : ''
    return `Active: ${v.description}\n  Workspace: ${v.label}${pipeline}`
  }
  const lines = [`Active work cycles (${overview.all.length})`]
  for (const v of overview.all) lines.push(formatActiveTaskLine(v))
  return lines.join('\n')
}
