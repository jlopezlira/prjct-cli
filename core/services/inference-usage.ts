/**
 * Agnostic inference-usage service.
 *
 * Callers pass { model, tokensIn, tokensOut }. Hosts (Claude, Grok, Codex,
 * Kimi, MCP, CLI) only adapt their logs into that shape. Pricing and the
 * `prjct cost` report never name a model.
 */

import { prjctDb } from '../storage/database'
import { recordTaskTokenUsage } from './work-cost-service'

export interface InferenceUsage {
  model: string
  tokensIn: number
  tokensOut: number
  measuredAt: number
  host: string
  sessionId: string
  /** True when in/out were not billed separately (totals only). */
  estimated?: boolean
}

export function recordInferenceUsage(
  projectId: string,
  taskId: string,
  usage: InferenceUsage
): void {
  const model = usage.model.trim()
  if (!model || model === 'unknown') return
  if (usage.tokensIn + usage.tokensOut <= 0) return
  recordTaskTokenUsage(projectId, taskId, usage.tokensIn, usage.tokensOut, {
    model,
    agent: usage.host,
    runtime: usage.host,
    source: `${usage.host}-session:${usage.sessionId}:${model}`,
    isEstimated: usage.estimated === true,
    measuredAt: usage.measuredAt,
    observationId: `${usage.host}:${usage.sessionId}`,
    usageKind: 'model',
  })
}

interface TaskWindow {
  id: string
  started_at: string
  completed_at: string | null
}

function overlappingTaskId(tasks: TaskWindow[], measuredAt: number): string | null {
  return (
    tasks.find((t) => {
      const start = Date.parse(t.started_at)
      const end = t.completed_at ? Date.parse(t.completed_at) : Number.POSITIVE_INFINITY
      return measuredAt >= start && measuredAt <= end
    })?.id ?? null
  )
}

/** Persist collected host usage into token_usage. One row per (session, model). */
export function persistInferenceUsage(projectId: string, usages: InferenceUsage[]): number {
  const tasks = prjctDb.query<TaskWindow>(
    projectId,
    `SELECT id, started_at, COALESCE(completed_at, shipped_at) AS completed_at
     FROM tasks WHERE started_at IS NOT NULL`
  )
  const written = { count: 0 }
  for (const usage of usages) {
    const taskId = overlappingTaskId(tasks, usage.measuredAt) ?? usage.sessionId
    recordInferenceUsage(projectId, taskId, usage)
    written.count += 1
  }
  return written.count
}
