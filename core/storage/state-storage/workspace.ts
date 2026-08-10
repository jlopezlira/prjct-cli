/**
 * Workspace-aware (multi-agent parallel) task helpers + token-usage
 * accumulator. Extracted from StateStorage to keep that facade small.
 *
 * Helpers take a `Backend` exposing the public `read`/`update` API
 * plus a typed `publish` proxy and the two task-history helpers that
 * still live on the StateStorage instance.
 */

import type { StateJson, TaskFeedback, TaskHistoryEntry, WorkspaceTask } from '../../schemas/state'
import { getTimestamp } from '../../utils/date-helper'

export interface WorkspaceBackend {
  read(projectId: string): Promise<StateJson>
  update(projectId: string, fn: (s: StateJson) => StateJson): Promise<StateJson>
  publish(projectId: string, type: string, data: Record<string, unknown>): Promise<void>
  createTaskHistoryEntry(
    task: WorkspaceTask,
    completedAt: string,
    feedback?: TaskFeedback
  ): TaskHistoryEntry
  /** Persist a completed task's history entry into the typed `tasks` table. */
  persistHistoryEntry(projectId: string, entry: TaskHistoryEntry): void
}

export async function startTaskInWorkspace(
  backend: WorkspaceBackend,
  projectId: string,
  task: Omit<WorkspaceTask, 'startedAt'>,
  workspaceId: string
): Promise<WorkspaceTask> {
  const workspaceTask: WorkspaceTask = {
    ...task,
    workspaceId,
    startedAt: getTimestamp(),
  }

  await backend.update(projectId, (state) => {
    // Atomic per-workspace gate: re-checked against the FRESH state inside the
    // CAS updater, so two concurrent starts in the same workspace can't both
    // win (the outer validateTransition gives the friendly message; this is
    // the race-proof backstop that keeps activeTasks one-per-workspace).
    if ((state.activeTasks || []).some((t) => t.workspaceId === workspaceId)) {
      throw new Error('A task is already active in this workspace')
    }
    return {
      ...state,
      activeTasks: [...(state.activeTasks || []), workspaceTask],
      lastUpdated: getTimestamp(),
    }
  })

  await backend.publish(projectId, 'task.started', {
    taskId: workspaceTask.id,
    description: workspaceTask.description,
    startedAt: workspaceTask.startedAt,
    sessionId: workspaceTask.sessionId,
    workspaceId,
  })

  return workspaceTask
}

export async function getCurrentTaskForWorkspace(
  backend: WorkspaceBackend,
  projectId: string,
  workspaceId: string
): Promise<WorkspaceTask | null> {
  const state = await backend.read(projectId)
  return (state.activeTasks || []).find((t) => t.workspaceId === workspaceId) ?? null
}

export async function completeTaskInWorkspace(
  backend: WorkspaceBackend,
  projectId: string,
  workspaceId: string,
  feedback?: TaskFeedback
): Promise<WorkspaceTask | null> {
  const state = await backend.read(projectId)
  const task = (state.activeTasks || []).find((t) => t.workspaceId === workspaceId)
  if (!task) return null

  const completedAt = getTimestamp()

  // Capture the FRESH task inside the CAS updater (a concurrent update may
  // have mutated it since the outer read), then persist the history entry to
  // the typed `tasks` table (Schema v2 C4) — the blob no longer carries it.
  const freshSnapshots: WorkspaceTask[] = []
  await backend.update(projectId, (s) => {
    freshSnapshots.push((s.activeTasks || []).find((t) => t.workspaceId === workspaceId) ?? task)
    return {
      ...s,
      activeTasks: (s.activeTasks || []).filter((t) => t.workspaceId !== workspaceId),
      lastUpdated: completedAt,
    }
  })
  backend.persistHistoryEntry(
    projectId,
    backend.createTaskHistoryEntry(freshSnapshots.at(-1) ?? task, completedAt, feedback)
  )

  await backend.publish(projectId, 'task.completed', {
    taskId: task.id,
    description: task.description,
    startedAt: task.startedAt,
    completedAt,
    workspaceId,
  })

  return task
}

export async function getActiveTasks(
  backend: WorkspaceBackend,
  projectId: string
): Promise<WorkspaceTask[]> {
  const state = await backend.read(projectId)
  return state.activeTasks || []
}

export async function getActiveTaskCount(
  backend: WorkspaceBackend,
  projectId: string
): Promise<number> {
  const state = await backend.read(projectId)
  return (state.activeTasks || []).length
}

export async function updateWorkspaceTask(
  backend: WorkspaceBackend,
  projectId: string,
  workspaceId: string,
  fields: Partial<WorkspaceTask> & Record<string, unknown>
): Promise<WorkspaceTask | null> {
  const state = await backend.read(projectId)
  const existing = (state.activeTasks || []).find((t) => t.workspaceId === workspaceId)
  if (!existing) return null

  // Merge by workspaceId INSIDE the updater (not by a stale positional index),
  // so a concurrent insert/remove can't make the index point at the wrong row.
  // Keys set to `null` are deleted (clear optional markers like pendingHandoffId).
  const merge = (t: WorkspaceTask): WorkspaceTask => {
    const next: Record<string, unknown> = { ...t }
    for (const [k, v] of Object.entries(fields)) {
      if (v === null) delete next[k]
      else if (v !== undefined) next[k] = v
    }
    next.workspaceId = workspaceId
    return next as WorkspaceTask
  }

  const mergedSnapshots: WorkspaceTask[] = []
  await backend.update(projectId, (s) => ({
    ...s,
    activeTasks: (s.activeTasks || []).map((t) => {
      if (t.workspaceId !== workspaceId) return t
      const merged = merge(t)
      mergedSnapshots.push(merged)
      return merged
    }),
    lastUpdated: getTimestamp(),
  }))

  return mergedSnapshots.at(-1) ?? existing
}

export async function addTokens(
  backend: WorkspaceBackend,
  projectId: string,
  tokensIn: number,
  tokensOut: number,
  workspaceId?: string
): Promise<{ tokensIn: number; tokensOut: number } | null> {
  const state = await backend.read(projectId)

  // Deltas are summed INSIDE the updater against the freshest token totals, so
  // concurrent flushes accumulate instead of clobbering (closing over an
  // outer-read sum would lose the other writer's tokens on CAS retry). The
  // committed total is captured from the winning updater run.

  // Multi-agent: accumulate against the named workspace's task in activeTasks[].
  // Without a workspaceId (or for the main worktree) accumulate on currentTask.
  // This avoids the silent no-op where a child-worktree task has no currentTask.
  if (workspaceId) {
    if (!(state.activeTasks || []).some((t) => t.workspaceId === workspaceId)) return null
    const committedTotals: { tokensIn: number; tokensOut: number }[] = []
    await backend.update(projectId, (s) => ({
      ...s,
      activeTasks: (s.activeTasks || []).map((t) => {
        if (t.workspaceId !== workspaceId) return t
        const newIn = (t.tokensIn || 0) + tokensIn
        const newOut = (t.tokensOut || 0) + tokensOut
        committedTotals.push({ tokensIn: newIn, tokensOut: newOut })
        return { ...t, tokensIn: newIn, tokensOut: newOut }
      }),
      lastUpdated: getTimestamp(),
    }))
    return committedTotals.at(-1) ?? null
  }

  if (!state.currentTask) return null

  const committedTotals: { tokensIn: number; tokensOut: number }[] = []
  await backend.update(projectId, (s) => {
    if (!s.currentTask) return s
    const newIn = (s.currentTask.tokensIn || 0) + tokensIn
    const newOut = (s.currentTask.tokensOut || 0) + tokensOut
    committedTotals.push({ tokensIn: newIn, tokensOut: newOut })
    return {
      ...s,
      currentTask: { ...s.currentTask, tokensIn: newIn, tokensOut: newOut },
      lastUpdated: getTimestamp(),
    }
  })

  return committedTotals.at(-1) ?? null
}
