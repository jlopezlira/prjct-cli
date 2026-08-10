/**
 * Subtask lifecycle helpers for StateStorage.
 *
 * Functions take a `Backend` exposing the public `read`/`update` API
 * plus a typed `publish` proxy for the protected `publishEvent` method.
 * Keeps the `StateStorage` facade focused on routing while the heavy
 * subtask state machine lives here.
 */

import type { StateJson, Subtask, SubtaskCompletionData } from '../../schemas/state'
import { SubtaskCompletionDataSchema } from '../../schemas/state'
import { getTimestamp } from '../../utils/date-helper'

export interface SubtaskBackend {
  read(projectId: string): Promise<StateJson>
  update(projectId: string, fn: (s: StateJson) => StateJson): Promise<StateJson>
  publish(projectId: string, type: string, data: Record<string, unknown>): Promise<void>
}

interface SubtaskMutationResult {
  taskId: string
  current: Subtask
  next: Subtask | null
  progress?: { completed: number; total: number; percentage: number }
}

type ProgressCounter = (subtasks: Subtask[]) => number

const countCompleted: ProgressCounter = (subtasks) =>
  subtasks.filter((subtask) => subtask.status === 'completed').length

const countResolved: ProgressCounter = (subtasks) =>
  subtasks.filter(
    (subtask) =>
      subtask.status === 'completed' || subtask.status === 'failed' || subtask.status === 'skipped'
  ).length

async function mutateCurrentSubtask(
  backend: SubtaskBackend,
  projectId: string,
  mutate: (current: Subtask) => Subtask,
  countProgress?: ProgressCounter
): Promise<SubtaskMutationResult | null> {
  const resultRef: { value?: SubtaskMutationResult } = {}

  await backend.update(projectId, (state) => {
    if (!state.currentTask?.subtasks) return state

    const currentIndex = state.currentTask.currentSubtaskIndex || 0
    const current = state.currentTask.subtasks[currentIndex]
    if (!current) return state

    const updatedSubtasks = [...state.currentTask.subtasks]
    updatedSubtasks[currentIndex] = mutate(current)

    const nextIndex = currentIndex + 1
    const total = updatedSubtasks.length
    if (nextIndex < total) {
      updatedSubtasks[nextIndex] = {
        ...updatedSubtasks[nextIndex],
        status: 'in_progress',
        startedAt: getTimestamp(),
      }
    }

    const next = nextIndex < total ? updatedSubtasks[nextIndex] : null
    const progress = countProgress ? progressFrom(countProgress(updatedSubtasks), total) : undefined
    resultRef.value = {
      taskId: state.currentTask.id,
      current: updatedSubtasks[currentIndex],
      next,
      ...(progress ? { progress } : {}),
    }

    return {
      ...state,
      currentTask: {
        ...state.currentTask,
        subtasks: updatedSubtasks,
        currentSubtaskIndex: nextIndex < total ? nextIndex : currentIndex,
        ...(progress ? { subtaskProgress: progress } : {}),
      },
      lastUpdated: getTimestamp(),
    }
  })

  return resultRef.value ?? null
}

function progressFrom(
  completed: number,
  total: number
): NonNullable<SubtaskMutationResult['progress']> {
  return {
    completed,
    total,
    percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
  }
}

export async function createSubtasks(
  backend: SubtaskBackend,
  projectId: string,
  subtasks: Omit<Subtask, 'status' | 'startedAt' | 'completedAt' | 'output' | 'summary'>[]
): Promise<void> {
  const updatedState = await backend.update(projectId, (current) => {
    if (!current.currentTask) return current
    const fullSubtasks: Subtask[] = subtasks.map((subtask, index) => ({
      ...subtask,
      status: index === 0 ? 'in_progress' : 'pending',
      startedAt: index === 0 ? getTimestamp() : undefined,
      dependsOn: subtask.dependsOn || [],
    }))
    return {
      ...current,
      currentTask: {
        ...current.currentTask,
        subtasks: fullSubtasks,
        currentSubtaskIndex: 0,
        subtaskProgress: progressFrom(0, fullSubtasks.length),
      },
      lastUpdated: getTimestamp(),
    }
  })
  const taskId = updatedState.currentTask?.id ?? null
  const fullSubtasks = updatedState.currentTask?.subtasks ?? []

  if (!taskId) return

  await backend.publish(projectId, 'subtasks.created', {
    taskId,
    subtaskCount: fullSubtasks.length,
    subtasks: fullSubtasks.map((subtask) => ({
      id: subtask.id,
      description: subtask.description,
      domain: subtask.domain,
    })),
  })
}

export async function completeSubtask(
  backend: SubtaskBackend,
  projectId: string,
  completionData: SubtaskCompletionData
): Promise<Subtask | null> {
  const validation = SubtaskCompletionDataSchema.safeParse(completionData)
  if (!validation.success) {
    const errors = validation.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`
    )
    throw new Error(`Subtask completion requires handoff data:\n${errors.join('\n')}`)
  }

  const { output, summary } = validation.data
  const result = await mutateCurrentSubtask(
    backend,
    projectId,
    (current) => ({
      ...current,
      status: 'completed',
      completedAt: getTimestamp(),
      output,
      summary,
    }),
    countCompleted
  )

  if (!result) return null

  await backend.publish(projectId, 'subtask.completed', {
    taskId: result.taskId,
    subtaskId: result.current.id,
    description: result.current.description,
    output,
    handoff: summary.outputForNextAgent,
    filesChanged: summary.filesChanged.length,
    progress: result.progress,
  })

  return result.next
}

export async function getCurrentSubtask(
  backend: SubtaskBackend,
  projectId: string
): Promise<Subtask | null> {
  const state = await backend.read(projectId)
  if (!state.currentTask?.subtasks) return null
  const index = state.currentTask.currentSubtaskIndex || 0
  return state.currentTask.subtasks[index] || null
}

export async function getNextSubtask(
  backend: SubtaskBackend,
  projectId: string
): Promise<Subtask | null> {
  const state = await backend.read(projectId)
  if (!state.currentTask?.subtasks) return null
  const nextIndex = (state.currentTask.currentSubtaskIndex || 0) + 1
  return state.currentTask.subtasks[nextIndex] || null
}

export async function getPreviousSubtask(
  backend: SubtaskBackend,
  projectId: string
): Promise<Subtask | null> {
  const state = await backend.read(projectId)
  if (!state.currentTask?.subtasks) return null
  const prevIndex = (state.currentTask.currentSubtaskIndex || 0) - 1
  if (prevIndex < 0) return null
  return state.currentTask.subtasks[prevIndex] || null
}

export async function getPreviousHandoff(
  backend: SubtaskBackend,
  projectId: string
): Promise<{
  fromSubtask: string
  outputForNextAgent: string
  filesChanged: Array<{ path: string; action: string }>
  whatWasDone: string[]
} | null> {
  const prev = await getPreviousSubtask(backend, projectId)
  if (!prev?.summary?.outputForNextAgent) return null
  return {
    fromSubtask: prev.description,
    outputForNextAgent: prev.summary.outputForNextAgent,
    filesChanged: prev.summary.filesChanged,
    whatWasDone: prev.summary.whatWasDone,
  }
}

export async function getSubtasks(backend: SubtaskBackend, projectId: string): Promise<Subtask[]> {
  const state = await backend.read(projectId)
  return state.currentTask?.subtasks || []
}

export async function getSubtaskProgress(
  backend: SubtaskBackend,
  projectId: string
): Promise<{ completed: number; total: number; percentage: number } | null> {
  const state = await backend.read(projectId)
  return state.currentTask?.subtaskProgress || null
}

export async function hasSubtasks(backend: SubtaskBackend, projectId: string): Promise<boolean> {
  const state = await backend.read(projectId)
  return (state.currentTask?.subtasks?.length || 0) > 0
}

export async function areAllSubtasksComplete(
  backend: SubtaskBackend,
  projectId: string
): Promise<boolean> {
  const state = await backend.read(projectId)
  if (!state.currentTask?.subtasks) return true
  return state.currentTask.subtasks.every(
    (subtask) =>
      subtask.status === 'completed' || subtask.status === 'failed' || subtask.status === 'skipped'
  )
}

export async function failSubtask(
  backend: SubtaskBackend,
  projectId: string,
  error: string
): Promise<Subtask | null> {
  const result = await mutateCurrentSubtask(
    backend,
    projectId,
    (current) => ({
      ...current,
      status: 'failed',
      completedAt: getTimestamp(),
      output: `Failed: ${error}`,
    }),
    countResolved
  )

  if (!result) return null

  await backend.publish(projectId, 'subtask.failed', {
    taskId: result.taskId,
    subtaskId: result.current.id,
    description: result.current.description,
    error,
  })

  return result.next
}

export async function skipSubtask(
  backend: SubtaskBackend,
  projectId: string,
  reason: string
): Promise<Subtask | null> {
  const result = await mutateCurrentSubtask(
    backend,
    projectId,
    (current) => ({
      ...current,
      status: 'skipped',
      completedAt: getTimestamp(),
      output: `Skipped: ${reason}`,
      skipReason: reason,
    }),
    countResolved
  )

  if (!result) return null

  await backend.publish(projectId, 'subtask.skipped', {
    taskId: result.taskId,
    subtaskId: result.current.id,
    description: result.current.description,
    reason,
  })

  return result.next
}

export async function blockSubtask(
  backend: SubtaskBackend,
  projectId: string,
  blocker: string
): Promise<Subtask | null> {
  const result = await mutateCurrentSubtask(backend, projectId, (current) => ({
    ...current,
    status: 'blocked',
    output: `Blocked: ${blocker}`,
    blockReason: blocker,
  }))

  if (!result) return null

  await backend.publish(projectId, 'subtask.blocked', {
    taskId: result.taskId,
    subtaskId: result.current.id,
    description: result.current.description,
    blocker,
  })

  return result.next
}
