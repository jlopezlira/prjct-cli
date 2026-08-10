/**
 * Pause / resume / archive helpers for the active work cycle. Extracted to
 * keep the StateStorage facade small.
 */

import { generateUUID } from '../../schemas/schemas'
import type { CurrentTask, PreviousTask, StateJson } from '../../schemas/state'
import { getTimestamp } from '../../utils/date-helper'
import { archiveStorage } from '../archive-storage'

export interface LifecycleBackend {
  read(projectId: string): Promise<StateJson>
  update(projectId: string, fn: (s: StateJson) => StateJson): Promise<StateJson>
  publish(projectId: string, type: string, data: Record<string, unknown>): Promise<void>
  validateTransition(state: StateJson, transition: 'pause' | 'resume'): void
  getPausedTasksFromState(state: StateJson): PreviousTask[]
  maxPausedTasks: number
  stalenessThresholdDays: number
}

export async function pauseTask(
  backend: LifecycleBackend,
  projectId: string,
  reason?: string
): Promise<PreviousTask | null> {
  const resultRef: { pausedTask?: PreviousTask; pausedCount: number } = { pausedCount: 0 }

  await backend.update(projectId, (state) => {
    if (!state.currentTask) return state
    backend.validateTransition(state, 'pause')
    resultRef.pausedTask = {
      ...state.currentTask,
      status: 'paused',
      pausedAt: getTimestamp(),
      pauseReason: reason,
    }
    const pausedTasks = [resultRef.pausedTask, ...backend.getPausedTasksFromState(state)].slice(
      0,
      backend.maxPausedTasks
    )
    resultRef.pausedCount = pausedTasks.length
    return {
      ...state,
      currentTask: null,
      previousTask: null,
      pausedTasks,
      lastUpdated: getTimestamp(),
    }
  })

  if (!resultRef.pausedTask) return null
  const pausedTask = resultRef.pausedTask

  await backend.publish(projectId, 'task.paused', {
    taskId: pausedTask.id,
    description: pausedTask.description,
    pausedAt: pausedTask.pausedAt,
    reason,
    pausedCount: resultRef.pausedCount,
  })

  return pausedTask
}

export async function resumeTask(
  backend: LifecycleBackend,
  projectId: string,
  taskId?: string
): Promise<CurrentTask | null> {
  const resultRef: { currentTask?: CurrentTask; remainingPaused: number } = { remainingPaused: 0 }

  await backend.update(projectId, (state) => {
    const pausedTasks = backend.getPausedTasksFromState(state)
    if (pausedTasks.length === 0) return state
    backend.validateTransition(state, 'resume')

    const targetIndex = taskId ? pausedTasks.findIndex((t) => t.id === taskId) : 0
    if (targetIndex === -1) return state

    const target = pausedTasks[targetIndex]
    const remaining = pausedTasks.filter((_, i) => i !== targetIndex)
    const { status: _, pausedAt: __, pauseReason: ___, ...preserved } = target
    resultRef.currentTask = {
      ...preserved,
      startedAt: getTimestamp(),
      sessionId: target.sessionId ?? generateUUID(),
    }
    resultRef.remainingPaused = remaining.length

    return {
      ...state,
      currentTask: resultRef.currentTask,
      previousTask: null,
      pausedTasks: remaining,
      lastUpdated: getTimestamp(),
    }
  })

  if (!resultRef.currentTask) return null
  const currentTask = resultRef.currentTask

  await backend.publish(projectId, 'task.resumed', {
    taskId: currentTask.id,
    description: currentTask.description,
    resumedAt: currentTask.startedAt,
    remainingPaused: resultRef.remainingPaused,
  })

  return currentTask
}

export async function getStalePausedTasks(
  backend: LifecycleBackend,
  projectId: string
): Promise<PreviousTask[]> {
  const state = await backend.read(projectId)
  const pausedTasks = backend.getPausedTasksFromState(state)
  const threshold = Date.now() - backend.stalenessThresholdDays * 24 * 60 * 60 * 1000

  return pausedTasks.filter((t) => new Date(t.pausedAt).getTime() < threshold)
}

/**
 * Archive stale paused tasks (PRJ-267). Persists to archive table before
 * removing from active storage. Returns archived tasks.
 */
export async function archiveStalePausedTasks(
  backend: LifecycleBackend,
  projectId: string
): Promise<PreviousTask[]> {
  const threshold = Date.now() - backend.stalenessThresholdDays * 24 * 60 * 60 * 1000
  const archivedBatches: PreviousTask[][] = []

  await backend.update(projectId, (state) => {
    const pausedTasks = backend.getPausedTasksFromState(state)
    const stale = pausedTasks.filter((t) => new Date(t.pausedAt).getTime() < threshold)
    archivedBatches.push(stale)
    if (stale.length === 0) return state
    const fresh = pausedTasks.filter((t) => new Date(t.pausedAt).getTime() >= threshold)
    return {
      ...state,
      pausedTasks: fresh,
      previousTask: null,
      lastUpdated: getTimestamp(),
    }
  })

  const stale = archivedBatches[0] ?? []
  if (stale.length === 0) return []

  archiveStorage.archiveMany(
    projectId,
    stale.map((task) => ({
      entityType: 'paused_task' as const,
      entityId: task.id,
      entityData: task,
      summary: task.description,
      reason: 'staleness',
    }))
  )

  for (const task of stale) {
    await backend.publish(projectId, 'task.archived', {
      taskId: task.id,
      description: task.description,
      pausedAt: task.pausedAt,
      reason: 'staleness',
    })
  }

  return stale
}
