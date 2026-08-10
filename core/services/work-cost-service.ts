import prjctDb from '../storage/database'
import type { SqliteBindings } from '../storage/database/sqlite-compat'
import { publishCRUD } from '../sync/publish-helper'

interface CountRow {
  value: number
}

interface CostTaskRow {
  id: string
  description: string
  status: string
  started_at: string | null
  completed_at: string | null
  shipped_at: string | null
  tokens_in: number | null
  tokens_out: number | null
}

interface EventRow {
  type: string
  data: string
  timestamp: string
}

interface PerfAggregateRow {
  samples: number
  total: number | null
  average: number | null
}

export interface WorkCostTask {
  id: string
  description: string
  status: string
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  minutes: number | null
}

export interface DeclaredTokenMention {
  tokens: number
  sourceType: string
  occurredAt: string
  summary: string
}

export interface HistoricalRescue {
  inferredWorkCycles: number
  taskTableCycles: number
  eventWorkStarts: number
  eventStatusChanges: number
  eventShips: number
  syncRuns: number
  memoryEvents: number
  postEditEvents: number
  declaredTokenMentions: number
  declaredTokensTotal: number
  topDeclaredTokenMentions: DeclaredTokenMention[]
}

export interface WorkCostSnapshot {
  id: string
  windowDays: number
  generatedAt: string
  workCycles: number
  knownTokenCycles: number
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  tokenCoveragePercent: number
  measuredSessions: number
  surfacedContext: number
  usefulContext: number
  contextZoneEvents: number
  compactions: number
  commandSamples: number
  commandMs: number
  avgStartupMs: number | null
  mostExpensive: WorkCostTask[]
  /** Per-model token spend in the window (from token_usage.model_id rows). */
  byModel: Array<{ model: string; tokensIn: number; tokensOut: number }>
  historicalRescue: HistoricalRescue
  gaps: string[]
}

export const TASK_TOKENS_EVENT = 'memory.task_tokens'

/** Must match token_usage's CHECK(input_tokens/output_tokens BETWEEN 0 AND …) in migrations.ts. */
const TOKEN_COUNT_MAX = 10_000_000

/**
 * Persist measured token usage for a work cycle. Agent-agnostic: any agent
 * (Claude via the Stop-hook transcript, or Codex/Gemini/… via the
 * `prjct_task_set_status` MCP tool / `prjct status --tokens-*` CLI) records the
 * same way, so `tokenCoveragePercent` becomes real — the prerequisite for
 * proving prjct's net token savings.
 *
 * Primary write is an EVENT (prjct's north star: inputs are events to process,
 * not rows to dump), keyed by task so the snapshot can aggregate it even though
 * the live work flow keeps state in state-storage, not the legacy `tasks`
 * table. We also mirror onto `tasks` best-effort for migrated installs. SET
 * semantics: the latest report is the authoritative cumulative total.
 * Never throws.
 */
export function recordTaskTokenUsage(
  projectId: string,
  taskId: string,
  tokensIn: number,
  tokensOut: number,
  meta?: {
    description?: string
    agent?: string
    /** Model id when the runtime exposes it (e.g. claude-opus-4-8); else unknown. */
    model?: string
    /** Runtime/host: claude|codex|gemini|... when known. */
    runtime?: string
    /** True when the count is an estimate, not exact provider usage. */
    isEstimated?: boolean
    /** Where the measurement came from: transcript|mcp|cli. */
    source?: string
  }
): void {
  if (!taskId || tokensIn + tokensOut <= 0) return
  // Two failure shapes above the CHECK bound, two policies:
  //  - PLAUSIBLE overage (a marathon session's input+cache can pass 10M):
  //    CLAMP to the bound and mark estimated — a dropped row read as "no
  //    usage at all" and kept token coverage at 0% for exactly the sessions
  //    that cost the most.
  //  - IMPLAUSIBLE values (corrupted parse, e.g. 999,999,999): reject, as the
  //    CHECK always intended — clamping corruption would launder it.
  const PLAUSIBLE_MAX = 50_000_000
  if (tokensIn > PLAUSIBLE_MAX || tokensOut > PLAUSIBLE_MAX) return
  const clamped = tokensIn > TOKEN_COUNT_MAX || tokensOut > TOKEN_COUNT_MAX
  const ti = Math.min(Math.round(tokensIn), TOKEN_COUNT_MAX)
  const to = Math.min(Math.round(tokensOut), TOKEN_COUNT_MAX)
  if (clamped) meta = { ...meta, isEstimated: true }
  try {
    prjctDb.appendEvent(
      projectId,
      TASK_TOKENS_EVENT,
      {
        taskId,
        tokensIn: ti,
        tokensOut: to,
        ...(meta?.description ? { description: meta.description } : {}),
        ...(meta?.agent ? { agent: meta.agent } : {}),
        ...(meta?.model ? { model: meta.model } : {}),
        ...(meta?.runtime ? { runtime: meta.runtime } : {}),
        ...(meta?.isEstimated !== undefined ? { isEstimated: meta.isEstimated } : {}),
        ...(meta?.source ? { source: meta.source } : {}),
      },
      taskId
    )
  } catch {
    /* measurement must never block the caller */
  }
  // Same bound as token_usage's CHECK constraint (below) — applied here too so
  // the legacy tasks.tokens_in/out mirror never carries a value token_usage
  // would reject. Without this, a corrupted/out-of-range count that CHECK
  // correctly keeps out of token_usage still landed in tasks.tokens_in/out,
  // and buildWorkCostSnapshot's legacy-fallback merge (toCostTask, for tasks
  // with no token_usage row) would silently surface it anyway — defeating the
  // CHECK's whole purpose for exactly the corrupted-value case it exists for.
  const inBounds = ti >= 0 && ti <= TOKEN_COUNT_MAX && to >= 0 && to <= TOKEN_COUNT_MAX
  if (inBounds) {
    try {
      prjctDb.run(
        projectId,
        'UPDATE tasks SET tokens_in = ?, tokens_out = ? WHERE id = ?',
        ti,
        to,
        taskId
      )
    } catch {
      /* best-effort mirror — the event is the source of truth */
    }
  }
  // Schema v2 dual-write (C2): mirror into the typed token_usage table with an
  // explicit is_estimated flag and model/runtime, so cost aggregation can later
  // read structured rows (and exact/estimated never get mixed). Keyed by
  // (work_cycle_id, source) with upsert = current SET semantics (latest total
  // wins). The CHECK bound silently rejects corrupted values. Best-effort.
  try {
    const source = meta?.source ?? 'cli'
    const eventKey = `${taskId}:${source}`
    const now = Date.now()
    prjctDb.run(
      projectId,
      `INSERT INTO token_usage
         (id, work_cycle_id, event_key, source, is_estimated, input_tokens, output_tokens, model_id, description, measured_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_key) DO UPDATE SET
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         is_estimated = excluded.is_estimated,
         model_id = excluded.model_id,
         description = COALESCE(excluded.description, token_usage.description),
         measured_at = excluded.measured_at`,
      eventKey,
      taskId,
      eventKey,
      source,
      meta?.isEstimated ? 1 : 0,
      ti,
      to,
      meta?.model ?? null,
      meta?.description ?? null,
      now,
      now
    )
  } catch {
    /* best-effort typed mirror — the event row stays the source of truth */
  }
}

// (measuredCyclesFromEvents removed — token_usage is the single read source for
// cost; the memory.task_tokens events remain only as the append-only audit log.)

interface TokenUsageRow {
  work_cycle_id: string | null
  input_tokens: number
  output_tokens: number
  is_estimated: number
  description: string | null
}

/**
 * C2 read path: aggregate measured usage from the typed `token_usage` table —
 * one cycle per work_cycle_id, latest measurement wins (ORDER BY measured_at
 * DESC). Structured (exact/estimated is a column), no JSON.parse.
 */
function measuredCyclesFromTokenUsage(projectId: string, since: string): Map<string, WorkCostTask> {
  const sinceMs = Date.parse(since)
  const rows = query<TokenUsageRow>(
    projectId,
    `SELECT work_cycle_id, input_tokens, output_tokens, is_estimated, description
     FROM token_usage
     WHERE measured_at >= ?
     ORDER BY measured_at DESC`,
    Number.isFinite(sinceMs) ? sinceMs : 0
  )
  const byCycle = new Map<string, WorkCostTask>()
  for (const row of rows) {
    const id = row.work_cycle_id
    if (!id || byCycle.has(id)) continue // first seen = latest (DESC)
    const tokensIn = nullableNumber(row.input_tokens) ?? 0
    const tokensOut = nullableNumber(row.output_tokens) ?? 0
    if (tokensIn + tokensOut <= 0) continue
    byCycle.set(id, {
      id,
      description: row.description ?? id,
      status: row.is_estimated ? 'estimated' : 'measured',
      tokensIn,
      tokensOut,
      tokensTotal: tokensIn + tokensOut,
      minutes: null,
    })
  }
  return byCycle
}

export function buildWorkCostSnapshot(projectId: string, days: number): WorkCostSnapshot {
  const since = sinceIso(days)
  const now = new Date().toISOString()
  const taskRows = query<CostTaskRow>(
    projectId,
    `SELECT id, description, status, started_at, completed_at, shipped_at, tokens_in, tokens_out
     FROM tasks
     WHERE COALESCE(completed_at, shipped_at, started_at) >= ?
     ORDER BY COALESCE(completed_at, shipped_at, started_at) DESC`,
    since
  )
  // C2 read: token_usage is the authoritative structured token store
  // (exact/estimated split, CHECK-bounded, backfilled from events by
  // migration 39 + dual-written live) and wins whenever a cycle has a row
  // there. `tasks.tokens_in/out` is a legacy fallback for cycles with no
  // token_usage row (pre-C2 migrated installs, or a token_usage write that
  // failed independently of the tasks UPDATE) — recordTaskTokenUsage applies
  // the SAME CHECK bound to both writes, so this fallback can never surface a
  // value token_usage would have rejected. The `memory.task_tokens` events
  // are no longer read for cost — they remain as the append-only audit log.
  const merged = new Map<string, WorkCostTask>()
  for (const task of taskRows.map(toCostTask)) {
    if (task) merged.set(task.id, task)
  }
  for (const [id, cycle] of measuredCyclesFromTokenUsage(projectId, since)) {
    const prev = merged.get(id)
    merged.set(id, {
      ...cycle,
      description: prev?.description ?? cycle.description,
      minutes: prev?.minutes ?? cycle.minutes,
    })
  }
  const measuredTasks = [...merged.values()].sort((a, b) => b.tokensTotal - a.tokensTotal)

  const eventWorkStarts = eventCount(projectId, 'memory.task_started', since)
  const eventStatusChanges = eventCount(projectId, 'memory.status.changed', since)
  const eventShips = eventCount(projectId, 'memory.feature_shipped', since)
  const syncRuns = eventCount(projectId, 'sync', since)
  const memoryEvents = count(
    projectId,
    'SELECT COUNT(*) AS value FROM events WHERE type >= ? AND type < ? AND timestamp >= ?',
    'memory.',
    'memory/',
    since
  )
  const postEditEvents = eventCount(projectId, 'memory.post_edit', since)
  // Agent sessions (hooks) + CLI sessions (daemon) both count as attribution.
  const agentSessions = count(
    projectId,
    'SELECT COUNT(*) AS value FROM agent_sessions WHERE started_at >= ?',
    since
  )
  const cliSessions = (() => {
    try {
      return count(
        projectId,
        'SELECT COUNT(*) AS value FROM cli_sessions WHERE created_at >= ?',
        since
      )
    } catch {
      return 0
    }
  })()
  const measuredSessions = agentSessions + cliSessions
  // Distinct memories (not raw surface rows) — row spam should not tank reuse.
  const surfacedContext = count(
    projectId,
    'SELECT COUNT(DISTINCT memory_id) AS value FROM memory_surface_log WHERE created_at >= ?',
    since
  )
  // Surface in-window + usefulness score > 0 (last_used may predate the window).
  const usefulContext = count(
    projectId,
    `SELECT COUNT(DISTINCT s.memory_id) AS value
     FROM memory_surface_log s
     INNER JOIN memory_usefulness u ON u.memory_id = s.memory_id
     WHERE s.created_at >= ?
       AND u.score > 0`,
    since
  )
  // Finished cycles with a linked agent session (task_id) — better than sessions/cycles.
  const cyclesWithSession = (() => {
    try {
      return count(
        projectId,
        `SELECT COUNT(DISTINCT t.id) AS value
         FROM tasks t
         INNER JOIN agent_sessions a ON a.task_id = t.id
         WHERE (t.completed_at IS NOT NULL OR t.shipped_at IS NOT NULL)
           AND COALESCE(t.completed_at, t.shipped_at, t.started_at) >= ?`,
        since
      )
    } catch {
      return 0
    }
  })()
  const contextZoneEvents = count(
    projectId,
    'SELECT COUNT(*) AS value FROM context_zone_events WHERE timestamp >= ?',
    since
  )
  const compactions = count(
    projectId,
    'SELECT COUNT(*) AS value FROM context_compactions WHERE timestamp >= ?',
    since
  )
  const command = aggregatePerf(projectId, 'command_duration', since)
  const startup = aggregatePerf(projectId, 'startup_time', since)
  const declared = declaredTokenMentions(projectId, since)
  const tokensIn = measuredTasks.reduce((sum, task) => sum + task.tokensIn, 0)
  const tokensOut = measuredTasks.reduce((sum, task) => sum + task.tokensOut, 0)
  // Work-cycle count for reporting: prefer task table, fall back to events.
  // Token coverage denominator: finished task rows only (open cycles rarely
  // have tokens yet; event inflation used to tank healthy projects).
  const inferredWorkCycles = Math.max(taskRows.length, eventWorkStarts, eventShips)
  const finishedTaskRows = taskRows.filter((r) => r.completed_at || r.shipped_at)
  const tokenUsageIds = new Set(measuredCyclesFromTokenUsage(projectId, since).keys())
  const sessionTaskIds = (() => {
    try {
      return new Set(
        prjctDb
          .query<{ task_id: string }>(
            projectId,
            `SELECT DISTINCT task_id AS task_id FROM agent_sessions
             WHERE task_id IS NOT NULL AND started_at >= ?`,
            since
          )
          .map((r) => r.task_id)
          .filter(Boolean)
      )
    } catch {
      return new Set<string>()
    }
  })()
  const finishedWithTokens = finishedTaskRows.filter((r) => {
    const tin = Number(r.tokens_in ?? 0)
    const tout = Number(r.tokens_out ?? 0)
    return tin + tout > 0 || tokenUsageIds.has(r.id)
  }).length
  // Eligible = finished cycles where an agent signal exists (tokens or session).
  // Purely manual closes without agent activity don't penalize coverage.
  const finishedEligible = finishedTaskRows.filter((r) => {
    const tin = Number(r.tokens_in ?? 0) + Number(r.tokens_out ?? 0)
    return tin > 0 || tokenUsageIds.has(r.id) || sessionTaskIds.has(r.id)
  }).length
  const tokenCoverageBase =
    finishedEligible > 0
      ? finishedEligible
      : finishedTaskRows.length > 0
        ? finishedTaskRows.length
        : taskRows.length > 0
          ? taskRows.length
          : inferredWorkCycles
  // knownTokenCycles = all measured cycles (task rows or token_usage-only).
  // Coverage % uses finished-with-tokens over agent-eligible finished base.
  const knownTokenCycles = Math.max(finishedWithTokens, measuredTasks.length)

  const gaps: string[] = []
  if (inferredWorkCycles === 0) {
    gaps.push('No work cycles were found in tasks or historical events for this window.')
  } else if (taskRows.length === 0) {
    gaps.push('Work history was rescued from events, but normalized task rows are missing.')
  }
  if (tokenCoverageBase > 0 && finishedWithTokens === 0 && knownTokenCycles === 0) {
    gaps.push(
      'Work cycles exist, but none have exact token totals. Capture exact or estimated usage at task close.'
    )
  }
  if (measuredSessions === 0) {
    gaps.push(
      'No agent sessions were recorded. Session-level model/runtime/cost cannot be attributed yet.'
    )
  }
  if (surfacedContext === 0) {
    gaps.push(
      'No surfaced context was logged in this window, so reuse and re-exploration waste cannot be proven.'
    )
  }

  // Per-model spend: the claude-transcript:<model> rows written per turn.
  // model_id IS NOT NULL keeps the un-attributed totals row out of the split.
  const byModel: WorkCostSnapshot['byModel'] = (() => {
    try {
      return prjctDb
        .query<{ model: string; t_in: number; t_out: number }>(
          projectId,
          `SELECT COALESCE(model_id, 'unknown') AS model,
                SUM(input_tokens) AS t_in, SUM(output_tokens) AS t_out
         FROM token_usage
         WHERE model_id IS NOT NULL AND measured_at >= ?
         GROUP BY COALESCE(model_id, 'unknown')
         ORDER BY t_in + t_out DESC`,
          Date.parse(since)
        )
        .map((r) => ({ model: r.model, tokensIn: r.t_in, tokensOut: r.t_out }))
    } catch {
      return []
    }
  })()

  return {
    id: `work-cost-${days}d`,
    windowDays: days,
    generatedAt: now,
    workCycles: taskRows.length > 0 ? taskRows.length : inferredWorkCycles,
    knownTokenCycles,
    tokensIn,
    tokensOut,
    tokensTotal: tokensIn + tokensOut,
    tokenCoveragePercent:
      tokenCoverageBase === 0
        ? 0
        : Math.min(
            100,
            Math.round(
              (Math.max(
                finishedWithTokens,
                measuredTasks.filter((t) => tokenUsageIds.has(t.id) || t.tokensTotal > 0).length
              ) /
                tokenCoverageBase) *
                100
            )
          ),
    measuredSessions: Math.max(measuredSessions, cyclesWithSession),
    surfacedContext,
    usefulContext,
    contextZoneEvents,
    compactions,
    commandSamples: command.samples,
    commandMs: Math.round(command.total ?? 0),
    avgStartupMs: startup.average === null ? null : Math.round(startup.average),
    mostExpensive: measuredTasks.slice(0, 8),
    byModel,
    historicalRescue: {
      inferredWorkCycles,
      taskTableCycles: taskRows.length,
      eventWorkStarts,
      eventStatusChanges,
      eventShips,
      syncRuns,
      memoryEvents,
      postEditEvents,
      declaredTokenMentions: declared.length,
      declaredTokensTotal: declared.reduce((sum, item) => sum + item.tokens, 0),
      topDeclaredTokenMentions: declared.slice(0, 5),
    },
    gaps,
  }
}

export async function publishWorkCostSnapshots(
  projectId: string,
  windows: number[] = [7, 30, 90]
): Promise<WorkCostSnapshot[]> {
  const snapshots = windows.map((days) => buildWorkCostSnapshot(projectId, days))
  for (const snapshot of snapshots) {
    await publishCRUD({
      projectId,
      entityType: 'work_cost_snapshots',
      entityId: snapshot.id,
      eventType: 'upsert',
      // AC8 (spec 4b5bc99e): never let free-text memory prose reach cloud egress.
      // `topDeclaredTokenMentions` is regex-scraped from `memory.remember.*`
      // content, so its `summary` can carry secrets/PII. Cloud telemetry must
      // carry only structured numeric fields — strip the prose before publish.
      // The local snapshot (returned below) keeps it for the local cost report.
      data: redactSnapshotForCloud(snapshot),
    })
  }
  return snapshots
}

/**
 * Drop free-text excerpts from the cloud payload, keeping structured fields.
 * AC8 (spec 4b5bc99e): cloud telemetry must carry only structured numeric
 * fields — this must catch EVERY free-text field in WorkCostSnapshot, not
 * just the regex-scraped memory prose. `mostExpensive[].description` is
 * user-authored (the work-cycle intent phrase, e.g. from `prjct work "..."`
 * or the Stop-hook transcript) and can contain the same class of secrets/PII
 * as memory content — it must be redacted too, not just topDeclaredTokenMentions.
 */
function redactSnapshotForCloud(snapshot: WorkCostSnapshot): WorkCostSnapshot {
  return {
    ...snapshot,
    mostExpensive: snapshot.mostExpensive.map((t) => ({
      ...t,
      description: '[redacted]',
    })),
    historicalRescue: {
      ...snapshot.historicalRescue,
      topDeclaredTokenMentions: snapshot.historicalRescue.topDeclaredTokenMentions.map((m) => ({
        tokens: m.tokens,
        sourceType: m.sourceType,
        occurredAt: m.occurredAt,
        summary: '[redacted]',
      })),
    },
  }
}

function toCostTask(row: CostTaskRow): WorkCostTask | null {
  const tokensIn = nullableNumber(row.tokens_in) ?? 0
  const tokensOut = nullableNumber(row.tokens_out) ?? 0
  const tokensTotal = tokensIn + tokensOut
  if (tokensTotal <= 0) return null
  return {
    id: row.id,
    description: row.description,
    status: row.status,
    tokensIn,
    tokensOut,
    tokensTotal,
    minutes: durationMinutes(row.started_at, row.completed_at ?? row.shipped_at),
  }
}

function declaredTokenMentions(projectId: string, since: string): DeclaredTokenMention[] {
  const rows = query<EventRow>(
    projectId,
    `SELECT type, data, timestamp
     FROM events
     WHERE timestamp >= ?
       AND type >= ?
       AND type < ?
       AND json_valid(data)
       AND json_extract(data, '$.content') LIKE '%token%'
     ORDER BY timestamp DESC
     LIMIT 200`,
    since,
    'memory.remember.',
    'memory.remember/'
  )
  const mentions: DeclaredTokenMention[] = []
  for (const row of rows) {
    const content = (() => {
      try {
        const parsed = JSON.parse(row.data) as { content?: unknown }
        return typeof parsed.content === 'string' ? parsed.content : ''
      } catch {
        return ''
      }
    })()
    if (!content) continue
    const tokens = extractTokenCounts(content)
    for (const tokenCount of tokens) {
      mentions.push({
        tokens: tokenCount,
        sourceType: row.type,
        occurredAt: row.timestamp,
        summary: summarize(content),
      })
    }
  }
  return mentions.sort((a, b) => b.tokens - a.tokens)
}

function extractTokenCounts(content: string): number[] {
  const counts: number[] = []
  const re = /\b(\d+(?:\.\d+)?)\s*([kKmM])?\s*(?:tokens?|tok)\b/g
  for (const match of content.matchAll(re)) {
    const value = Number.parseFloat(match[1] ?? '0')
    const suffix = match[2]?.toLowerCase()
    if (!Number.isFinite(value) || value <= 0) continue
    const multiplier = suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1
    counts.push(Math.round(value * multiplier))
  }
  return counts
}

function summarize(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 137)}...`
}

function eventCount(projectId: string, type: string, since: string): number {
  return count(
    projectId,
    'SELECT COUNT(*) AS value FROM events WHERE type = ? AND timestamp >= ?',
    type,
    since
  )
}

function aggregatePerf(projectId: string, metric: string, since: string): PerfAggregateRow {
  return (
    query<PerfAggregateRow>(
      projectId,
      `SELECT COUNT(*) AS samples, COALESCE(SUM(value), 0) AS total, AVG(value) AS average
       FROM perf_samples
       WHERE metric = ? AND timestamp >= ?`,
      metric,
      since
    )[0] ?? { samples: 0, total: 0, average: null }
  )
}

function count(projectId: string, sql: string, ...params: SqliteBindings[]): number {
  try {
    return Number(prjctDb.get<CountRow>(projectId, sql, ...params)?.value ?? 0)
  } catch {
    return 0
  }
}

function query<T>(projectId: string, sql: string, ...params: SqliteBindings[]): T[] {
  try {
    return prjctDb.query<T>(projectId, sql, ...params)
  } catch {
    return []
  }
}

function sinceIso(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date.toISOString()
}

function nullableNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function durationMinutes(
  start: string | null | undefined,
  end: string | null | undefined
): number | null {
  if (!start || !end) return null
  const started = Date.parse(start)
  const ended = Date.parse(end)
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null
  return Math.round((ended - started) / 60_000)
}
