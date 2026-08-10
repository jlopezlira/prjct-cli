/**
 * Read-only query helpers + clear/has on StateStorage. Extracted to
 * keep the facade focused on lifecycle mutations.
 *
 * Schema v2 (C4): task HISTORY reads come from the typed `tasks` table
 * (completed rows + their cold `data` extras), not the state blob — the blob
 * only carries the live state machine (currentTask/pausedTasks/activeTasks).
 */

import type { PreviousTask, StateJson, TaskHistoryEntry } from '../../schemas/state'
import { getTimestamp } from '../../utils/date-helper'
import { prjctDb } from '../database'

export interface QueryBackend {
  read(projectId: string): Promise<StateJson>
  update(projectId: string, fn: (s: StateJson) => StateJson): Promise<StateJson>
  getPausedTasksFromState(state: StateJson): PreviousTask[]
}

/** Parity with the legacy blob list, which was FIFO-capped at 20 entries. */
const HISTORY_LIMIT = 20

interface HistoryRow {
  id: string
  description: string
  type: string | null
  branch: string | null
  linear_id: string | null
  pr_url: string | null
  started_at: string
  completed_at: string
  tokens_in: number | null
  tokens_out: number | null
  data: string | null
}

function rowToHistoryEntry(r: HistoryRow): TaskHistoryEntry {
  const cold = (() => {
    if (!r.data) return {} as Partial<TaskHistoryEntry>
    try {
      return JSON.parse(r.data) as Partial<TaskHistoryEntry>
    } catch {
      return {} as Partial<TaskHistoryEntry>
    }
  })()
  const entry: TaskHistoryEntry = {
    taskId: r.id,
    title: cold.title ?? r.description,
    classification: (r.type ?? 'improvement') as TaskHistoryEntry['classification'],
    startedAt: r.started_at,
    completedAt: r.completed_at,
    subtaskCount: cold.subtaskCount ?? 0,
    subtaskSummaries: cold.subtaskSummaries ?? [],
    outcome: cold.outcome ?? 'Task completed',
    branchName: r.branch ?? 'unknown',
  }
  if (r.linear_id != null) entry.linearId = r.linear_id
  if (cold.linearUuid != null) entry.linearUuid = cold.linearUuid
  if (r.pr_url != null) entry.prUrl = r.pr_url
  if (cold.feedback) entry.feedback = cold.feedback
  if (cold.harness) entry.harness = cold.harness
  if (r.tokens_in) entry.tokensIn = r.tokens_in
  if (r.tokens_out) entry.tokensOut = r.tokens_out
  return entry
}

function queryHistory(projectId: string, extraWhere = '', ...params: string[]): TaskHistoryEntry[] {
  try {
    return prjctDb
      .query<HistoryRow>(
        projectId,
        `SELECT id, description, type, branch, linear_id, pr_url, started_at, completed_at, tokens_in, tokens_out, data
         FROM tasks
         WHERE status = 'completed' AND completed_at IS NOT NULL ${extraWhere}
         ORDER BY completed_at DESC, rowid DESC LIMIT ${HISTORY_LIMIT}`,
        ...params
      )
      .map(rowToHistoryEntry)
  } catch {
    return [] // history is best-effort context — never break a caller
  }
}

export async function clearTask(backend: QueryBackend, projectId: string): Promise<void> {
  await backend.update(projectId, () => ({
    currentTask: null,
    previousTask: null,
    pausedTasks: [],
    activeTasks: [],
    lastUpdated: getTimestamp(),
  }))
}

export async function hasTask(backend: QueryBackend, projectId: string): Promise<boolean> {
  const state = await backend.read(projectId)
  const paused = backend.getPausedTasksFromState(state)
  return state.currentTask !== null || paused.length > 0
}

export async function getPausedTask(
  backend: QueryBackend,
  projectId: string
): Promise<PreviousTask | null> {
  const state = await backend.read(projectId)
  const paused = backend.getPausedTasksFromState(state)
  return paused[0] || null
}

export async function getAllPausedTasks(
  backend: QueryBackend,
  projectId: string
): Promise<PreviousTask[]> {
  const state = await backend.read(projectId)
  return backend.getPausedTasksFromState(state)
}

export async function getTaskHistory(
  _backend: QueryBackend,
  projectId: string
): Promise<TaskHistoryEntry[]> {
  return queryHistory(projectId)
}

export async function getMostRecentTask(
  _backend: QueryBackend,
  projectId: string
): Promise<TaskHistoryEntry | null> {
  return queryHistory(projectId)[0] || null
}

export async function getTaskHistoryByType(
  _backend: QueryBackend,
  projectId: string,
  classification: TaskHistoryEntry['classification']
): Promise<TaskHistoryEntry[]> {
  return queryHistory(projectId, 'AND type = ?', classification)
}

/**
 * Aggregate feedback from all task history entries (PRJ-272).
 * Used by sync to feed task discoveries back into analysis and agent
 * generation. Returns consolidated patterns, stack confirmations, issues,
 * and agent accuracy. Recurring issues (≥2 occurrences) get promoted to
 * known gotchas.
 */
export async function getAggregatedFeedback(
  backend: QueryBackend,
  projectId: string
): Promise<{
  stackConfirmed: string[]
  patternsDiscovered: string[]
  agentAccuracy: Array<{ agent: string; rating: string; note?: string }>
  issuesEncountered: string[]
  knownGotchas: string[]
}> {
  const history = await getTaskHistory(backend, projectId)
  const entriesWithFeedback = history.filter((h) => h.feedback)

  const stackConfirmed: string[] = []
  const patternsDiscovered: string[] = []
  const agentAccuracy: Array<{ agent: string; rating: string; note?: string }> = []
  const allIssues: string[] = []

  for (const entry of entriesWithFeedback) {
    const fb = entry.feedback!
    if (Array.isArray(fb.stackConfirmed)) stackConfirmed.push(...fb.stackConfirmed)
    if (Array.isArray(fb.patternsDiscovered)) patternsDiscovered.push(...fb.patternsDiscovered)
    if (Array.isArray(fb.agentAccuracy)) agentAccuracy.push(...fb.agentAccuracy)
    if (Array.isArray(fb.issuesEncountered)) allIssues.push(...fb.issuesEncountered)
  }

  const uniqueStack = [...new Set(stackConfirmed)]
  const uniquePatterns = [...new Set(patternsDiscovered)]

  const issueCounts = new Map<string, number>()
  for (const issue of allIssues) {
    issueCounts.set(issue, (issueCounts.get(issue) || 0) + 1)
  }
  const knownGotchas = [...issueCounts.entries()]
    .filter(([_, count]) => count >= 2)
    .map(([issue]) => issue)

  return {
    stackConfirmed: uniqueStack,
    patternsDiscovered: uniquePatterns,
    agentAccuracy,
    issuesEncountered: [...new Set(allIssues)],
    knownGotchas,
  }
}
