/**
 * Product proof commands — concrete surfaces that show why prjct is worth
 * keeping around. These are intentionally read-mostly and provider-agnostic:
 * any coding agent can run them with `--md` and get the same project signal.
 */

import { detectAgentRuntimes } from '../infrastructure/agent-runtime-registry'
import { type LatencyReport, performanceTracker } from '../infrastructure/performance-tracker'
import type { MemoryEntry, MemoryType } from '../memory/entries'
import { deriveTitle, flatDetail, preventiveLabel } from '../memory/format'
import { projectMemory } from '../memory/project-memory'
import {
  computeSubstrateHealth,
  formatSubstrateHealthMd,
  type SubstrateHealth,
} from '../memory/substrate-health'
import { isJunkCaptureContent } from '../services/capture-junk'
import { resolveActiveTask } from '../services/task-service'
import {
  buildWorkCostSnapshot,
  type WorkCostSnapshot,
  type WorkCostTask,
} from '../services/work-cost-service'
import prjctDb from '../storage/database'
import type { SqliteBindings } from '../storage/database/sqlite-compat'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { runGit, throwProc } from '../utils/exec'
import { failHard } from '../utils/md-aware'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'
import { requireProject } from './guards'

interface ProductOptions extends MdOption {
  days?: number
}

interface CountRow {
  value: number
}

interface TypeCountRow {
  type: string | null
  value: number
}

interface MemoryRow {
  id: string
  title: string | null
  content: string
  type: string | null
  tags: string | null
  created_at: string
}

interface TaskRow {
  id: string
  description: string
  status: string
  started_at?: string | null
  completed_at: string | null
  shipped_at: string | null
  tokens_in?: number | null
  tokens_out?: number | null
}

interface ShipRow {
  name: string
  shipped_at: string
  description: string | null
}

interface ValueSnapshot {
  memories: {
    live: number
    preventive: number
    useful: number
    surfaced: number
    inbox: number
  }
  workflow: {
    tasks: number
    completed: number
    shippedTasks: number
    shippedFeatures: number
    specs: number
    shippedSpecs: number
  }
  sync: {
    syncs: number
    tokensSaved: number
  }
  agents: {
    detected: number
    full: number
    good: number
    baseline: number
    hosted: number
  }
  score: number
}

interface PerformanceRow {
  id: string
  description: string
  status: string
  started_at: string | null
  completed_at: string | null
  shipped_at: string | null
  tokens_in: number | null
  tokens_out: number | null
  linked_spec_id?: string | null
}

interface PerformanceCycle {
  id: string
  description: string
  status: string
  minutes: number | null
  tokensIn: number | null
  tokensOut: number | null
  tokensTotal: number | null
  model: string
  runtime: string
  /** Subagent spawns attributed to this cycle (fan-out cost). */
  subagents: number
  promptSynthesis: string
  outcome: string
}

interface ReliabilitySnapshot {
  score: number
  windowDays: number
  valueScore: number
  memoryScore: number
  workCycleCoveragePercent: number
  tokenCoveragePercent: number
  sessionCoveragePercent: number
  contextReusePercent: number
  commandTelemetry: {
    samples: number
    avgStartupMs: number | null
  }
  gaps: string[]
  nextActions: string[]
}

const PREVENTIVE_TYPES = ['gotcha', 'red-herring', 'anti-pattern', 'learning']
const NOISE_RE = /^(current work|wip|todo|misc|n\/a|none|latest|unreleased|changelog)$/i

export class ProductCommands extends PrjctCommandsBase {
  async insights(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: ProductOptions = {}
  ): Promise<CommandResult> {
    const [sub = 'overview', ...rest] = (input ?? '').trim().split(/\s+/).filter(Boolean)
    const forwarded = rest.join(' ') || null
    switch (sub) {
      case 'value':
      case 'overview':
        return this.value(null, projectPath, options)
      case 'quality':
      case 'memory':
      case 'memory-doctor':
        return this.memoryDoctor(forwarded, projectPath, options)
      case 'reliability':
      case 'trust':
      case 'proof':
        return this.reliability(forwarded, projectPath, options)
      case 'report':
      case 'retro':
        return this.report(forwarded, projectPath, options)
      case 'continue':
      case 'handoff':
      case 'brief':
        return this.handoff(forwarded, projectPath, options)
      case 'guardrails':
      case 'risk':
        return this.guardrails(null, projectPath, options)
      case 'cost':
      case 'spend':
      case 'tokens':
      case 'usage':
        return this.cost(forwarded, projectPath, options)
      case 'backfill':
        return this.backfill(projectPath, options)
      default:
        return failHard(
          `Unknown insights view '${sub}'. Use value, quality, reliability, cost, report, continue, or guardrails.`,
          options
        )
    }
  }

  async value(
    _input: string | null = null,
    projectPath: string = process.cwd(),
    options: ProductOptions = {}
  ): Promise<CommandResult> {
    try {
      const guard = await requireProject(projectPath, options)
      if (!guard.ok) return guard.result

      const snapshot = await buildValueSnapshot(guard.value, projectPath)
      console.log(options.md ? formatValueMd(snapshot) : formatValueText(snapshot))
      return { success: true, ...snapshot }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  async memoryDoctor(
    _input: string | null = null,
    projectPath: string = process.cwd(),
    options: ProductOptions = {}
  ): Promise<CommandResult> {
    try {
      const guard = await requireProject(projectPath, options)
      if (!guard.ok) return guard.result

      const report = buildMemoryDoctor(guard.value)
      const includeFixPlan = wantsFixPlan(_input)
      console.log(
        options.md
          ? formatMemoryDoctorMd(report, includeFixPlan)
          : formatMemoryDoctorText(report, includeFixPlan)
      )
      return { success: true, score: report.score, issues: report.issues.length }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  async report(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: ProductOptions = {}
  ): Promise<CommandResult> {
    try {
      const guard = await requireProject(projectPath, options)
      if (!guard.ok) return guard.result

      const days = pickDays(input, options.days, 7)
      const report = await buildHumanReport(guard.value, projectPath, days)
      console.log(options.md ? formatReportMd(report) : formatReportText(report))
      return { success: true, days, ships: report.ships.length, completed: report.completed.length }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  async handoff(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: ProductOptions = {}
  ): Promise<CommandResult> {
    try {
      const guard = await requireProject(projectPath, options)
      if (!guard.ok) return guard.result

      const target = (input ?? '').trim().split(/\s+/).filter(Boolean)[0] ?? 'next agent'
      const handoff = await buildHandoff(guard.value, projectPath, target)
      console.log(options.md ? formatHandoffMd(handoff) : formatHandoffText(handoff))
      return { success: true, target, memories: handoff.memories.length }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  async guardrails(
    _input: string | null = null,
    projectPath: string = process.cwd(),
    options: ProductOptions = {}
  ): Promise<CommandResult> {
    try {
      const guard = await requireProject(projectPath, options)
      if (!guard.ok) return guard.result

      const report = await buildGuardrails(guard.value, projectPath)
      console.log(options.md ? formatGuardrailsMd(report) : formatGuardrailsText(report))
      return { success: true, files: report.files.length, hits: report.hits.length }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  async performance(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: ProductOptions = {}
  ): Promise<CommandResult> {
    try {
      const guard = await requireProject(projectPath, options)
      if (!guard.ok) return guard.result

      const days = pickDays(input, options.days, 14)
      const cycles = buildPerformanceCycles(guard.value, days)
      console.log(
        options.md ? formatPerformanceMd(days, cycles) : formatPerformanceText(days, cycles)
      )
      return { success: true, days, cycles: cycles.length }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  async perf(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: ProductOptions = {}
  ): Promise<CommandResult> {
    try {
      const guard = await requireProject(projectPath, options)
      if (!guard.ok) return guard.result
      const days = pickDays(input, options.days, 7)
      const report = performanceTracker.getLatencyReport(guard.value, days)
      console.log(options.md ? formatLatencyMd(report) : formatLatencyText(report))
      return { success: true, days, commands: Object.keys(report.commands).length }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  async cost(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: ProductOptions = {}
  ): Promise<CommandResult> {
    try {
      const guard = await requireProject(projectPath, options)
      if (!guard.ok) return guard.result

      const days = pickDays(input, options.days, 30)
      const snapshot = buildWorkCostSnapshot(guard.value, days)
      console.log(options.md ? formatCostMd(snapshot) : formatCostText(snapshot))
      return { success: true, ...snapshot }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  /**
   * `prjct insights backfill` — recover historical per-task token usage from
   * the Claude Code transcripts on disk (windowed by each completed task's
   * start/completion). Idempotent; only touches tasks with zero tokens.
   */
  async backfill(projectPath: string = process.cwd(), options: ProductOptions = {}) {
    try {
      const guard = await requireProject(projectPath, options)
      if (!guard.ok) return guard.result
      const { backfillTaskTokens } = await import('../services/token-backfill')
      const r = await backfillTaskTokens(guard.value, projectPath)
      const msg = `backfilled ${r.tasksBackfilled} task(s) with ${r.tokensRecovered.toLocaleString()} tokens from ${r.transcriptsScanned} transcript(s) (${r.tasksSkipped} had no usage in window)`
      if (options.md) console.log(`✓ ${msg}`)
      else out.done(msg)
      return { success: true, ...r }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  async reliability(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: ProductOptions = {}
  ): Promise<CommandResult> {
    try {
      const guard = await requireProject(projectPath, options)
      if (!guard.ok) return guard.result

      const days = pickDays(input, options.days, 30)
      const snapshot = await buildReliabilitySnapshot(guard.value, projectPath, days)
      console.log(options.md ? formatReliabilityMd(snapshot) : formatReliabilityText(snapshot))
      return { success: true, ...snapshot }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }
}

async function buildValueSnapshot(projectId: string, projectPath: string): Promise<ValueSnapshot> {
  const statuses = await detectAgentRuntimes(projectPath)
  const levels = {
    detected: statuses.filter((s) => s.detected).length,
    full: statuses.filter((s) => s.supportLevel === 'full').length,
    good: statuses.filter((s) => s.supportLevel === 'good').length,
    baseline: statuses.filter((s) => s.supportLevel === 'baseline').length,
    hosted: statuses.filter((s) => s.supportLevel === 'hosted').length,
  }

  const memories = {
    live: count(projectId, 'SELECT COUNT(*) AS value FROM memory_entries WHERE deleted_at IS NULL'),
    preventive: count(
      projectId,
      `SELECT COUNT(*) AS value FROM memory_entries
       WHERE deleted_at IS NULL AND type IN ('gotcha', 'anti-pattern', 'learning')`
    ),
    useful: count(projectId, 'SELECT COUNT(*) AS value FROM memory_usefulness WHERE score > 0'),
    surfaced: count(projectId, 'SELECT COUNT(*) AS value FROM memory_surface_log'),
    inbox: count(
      projectId,
      `SELECT COUNT(*) AS value FROM memory_entries WHERE deleted_at IS NULL AND type = 'inbox'`
    ),
  }

  const workflow = {
    tasks: count(projectId, 'SELECT COUNT(*) AS value FROM tasks'),
    completed: count(
      projectId,
      `SELECT COUNT(*) AS value FROM tasks WHERE status IN ('done', 'completed')`
    ),
    shippedTasks: count(
      projectId,
      'SELECT COUNT(*) AS value FROM tasks WHERE shipped_at IS NOT NULL'
    ),
    shippedFeatures: count(projectId, 'SELECT COUNT(*) AS value FROM shipped_features'),
    specs: count(projectId, 'SELECT COUNT(*) AS value FROM specs'),
    shippedSpecs: count(projectId, `SELECT COUNT(*) AS value FROM specs WHERE status = 'shipped'`),
  }

  const sync = {
    syncs: count(projectId, 'SELECT COALESCE(SUM(syncs), 0) AS value FROM metrics_daily'),
    tokensSaved: count(
      projectId,
      'SELECT COALESCE(SUM(tokens_saved), 0) AS value FROM metrics_daily'
    ),
  }

  return {
    memories,
    workflow,
    sync,
    agents: levels,
    score: valueScore(memories, workflow, sync, levels),
  }
}

function buildMemoryDoctor(projectId: string): {
  score: number
  byType: TypeCountRow[]
  issues: string[]
  duplicateGroups: number
  staleInbox: MemoryRow[]
  noise: MemoryRow[]
  missingType: number
  provenUseful: number
  substrate: SubstrateHealth | null
} {
  const byType = query<TypeCountRow>(
    projectId,
    `SELECT COALESCE(type, 'unknown') AS type, COUNT(*) AS value
     FROM memory_entries
     WHERE deleted_at IS NULL
     GROUP BY COALESCE(type, 'unknown')
     ORDER BY value DESC, type ASC`
  )
  const duplicateGroups = count(
    projectId,
    `SELECT COUNT(*) AS value FROM (
       SELECT type, content_hash
       FROM memory_entries
       WHERE deleted_at IS NULL AND content_hash IS NOT NULL
       GROUP BY type, content_hash
       HAVING COUNT(*) > 1
     )`
  )
  const staleInbox = query<MemoryRow>(
    projectId,
    `SELECT id, title, content, type, '{}' AS tags, created_at
     FROM memory_entries
     WHERE deleted_at IS NULL
       AND type = 'inbox'
       AND created_at < (CAST(strftime('%s','now','-14 days') AS INTEGER) * 1000)
     ORDER BY created_at ASC
     LIMIT 8`
  )
  const rows = query<MemoryRow>(
    projectId,
    `SELECT id, title, content, type, '{}' AS tags, created_at
     FROM memory_entries
     WHERE deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 500`
  )
  const noise = rows.filter((row) => isNoise(row.content)).slice(0, 8)
  const missingType = count(
    projectId,
    `SELECT COUNT(*) AS value FROM memory_entries
     WHERE deleted_at IS NULL AND (type IS NULL OR type = '')`
  )
  const provenUseful = count(
    projectId,
    'SELECT COUNT(*) AS value FROM memory_usefulness WHERE score > 0'
  )

  // Precision + density substrate (signal-quality plan): pure over live index.
  const substrate = (() => {
    try {
      return computeSubstrateHealth(projectMemory.allEntriesForIndex(projectId))
    } catch {
      return null
    }
  })()

  const issues: string[] = []
  if (duplicateGroups > 0) issues.push(`${duplicateGroups} duplicate memory group(s) need review.`)
  if (staleInbox.length > 0) issues.push(`${staleInbox.length} old inbox item(s) need promotion.`)
  if (noise.length > 0)
    issues.push(`${noise.length} low-signal item(s) should be forgotten or rewritten.`)
  if (missingType > 0) issues.push(`${missingType} memory row(s) are missing a type.`)
  if (provenUseful === 0 && rows.length > 10) {
    issues.push('No memory has usefulness credit yet; run guard/context during real tasks.')
  }
  if (substrate) {
    for (const issue of substrate.issues.slice(0, 8)) issues.push(issue)
  }

  const penalty =
    duplicateGroups * 8 +
    staleInbox.length * 4 +
    noise.length * 6 +
    missingType * 5 +
    (substrate ? Math.round((1 - substrate.signalRatio) * 25) : 0)
  const base = Math.max(0, Math.min(100, 100 - penalty))
  // Blend classic doctor score with substrate precision score when available.
  const score = substrate ? Math.round(base * 0.55 + substrate.score * 0.45) : base
  return {
    score,
    byType,
    issues,
    duplicateGroups,
    staleInbox,
    noise,
    missingType,
    provenUseful,
    substrate,
  }
}

async function buildReliabilitySnapshot(
  projectId: string,
  projectPath: string,
  days: number
): Promise<ReliabilitySnapshot> {
  // Repair under-recorded signals before scoring (mirror tokens, credit surfaces).
  try {
    const { repairReliabilitySignals } = await import('../services/reliability-repair')
    repairReliabilitySignals(projectId, days)
  } catch {
    /* best-effort */
  }

  const cost = buildWorkCostSnapshot(projectId, days)
  const value = await buildValueSnapshot(projectId, projectPath)
  const memory = buildMemoryDoctor(projectId)

  const workCycleCoveragePercent =
    cost.workCycles === 0
      ? 0
      : Math.min(100, Math.round((cost.historicalRescue.taskTableCycles / cost.workCycles) * 100))
  // Prefer sessions per measured cycle (tokens known); fall back to workCycles.
  const sessionBase = Math.max(cost.knownTokenCycles, 1)
  const sessionCoveragePercent =
    cost.workCycles === 0
      ? 0
      : Math.min(
          100,
          Math.round(
            (cost.measuredSessions / Math.min(sessionBase, cost.workCycles || sessionBase)) * 100
          )
        )
  const contextReusePercent =
    cost.surfacedContext === 0
      ? 0
      : Math.min(100, Math.round((cost.usefulContext / cost.surfacedContext) * 100))

  const gaps = [...cost.gaps]
  if (workCycleCoveragePercent < 80) {
    gaps.push('Work-cycle normalization is below 80%; performance reports depend on event rescue.')
  }
  if (memory.score < 80) {
    gaps.push(
      'Memory quality is below 80%; run the quality fix-plan before trusting recall metrics.'
    )
  }
  if (cost.commandSamples === 0) {
    gaps.push('No command timing samples were recorded in this window.')
  }

  const nextActions: string[] = []
  if (workCycleCoveragePercent < 80) {
    nextActions.push(
      'Normalize active work cycles into task rows at work start/status transitions.'
    )
  }
  if (cost.tokenCoveragePercent < 80) {
    nextActions.push('Record exact or explicitly estimated token totals when a work cycle closes.')
  }
  if (sessionCoveragePercent < 80) {
    nextActions.push('Capture agent session start/stop rows with runtime, task id, and summary.')
  }
  if (memory.score < 80) {
    nextActions.push(
      'Run `prjct insights quality fix-plan --md` and promote/forget low-signal memory.'
    )
  }
  if (contextReusePercent < 30 && cost.surfacedContext > 0) {
    nextActions.push('Mark useful surfaced memories so reuse can be proven, not just assumed.')
  }
  if (nextActions.length === 0) {
    nextActions.push('Keep measuring; current reliability signals are healthy enough for planning.')
  }

  const score = Math.round(
    Math.min(
      100,
      Math.max(
        0,
        cost.tokenCoveragePercent * 0.25 +
          workCycleCoveragePercent * 0.2 +
          sessionCoveragePercent * 0.2 +
          Math.min(100, contextReusePercent) * 0.15 +
          memory.score * 0.1 +
          value.score * 0.1
      )
    )
  )

  return {
    score,
    windowDays: days,
    valueScore: value.score,
    memoryScore: memory.score,
    workCycleCoveragePercent,
    tokenCoveragePercent: cost.tokenCoveragePercent,
    sessionCoveragePercent,
    contextReusePercent,
    commandTelemetry: {
      samples: cost.commandSamples,
      avgStartupMs: cost.avgStartupMs,
    },
    gaps: unique(gaps),
    nextActions,
  }
}

/** Subagent spawns per task id (from the subagent.spawned telemetry trail). */
function subagentCounts(projectId: string, sinceIsoTs: string): Map<string, number> {
  try {
    const rows = prjctDb.query<{ task_id: string; c: number }>(
      projectId,
      `SELECT json_extract(data, '$.taskId') AS task_id, COUNT(*) AS c
       FROM events
       WHERE type = 'subagent.spawned' AND timestamp >= ? AND json_extract(data, '$.taskId') IS NOT NULL
       GROUP BY task_id`,
      sinceIsoTs
    )
    return new Map(rows.map((r) => [r.task_id, r.c]))
  } catch {
    return new Map()
  }
}

function runtimeFromSource(source: string | null | undefined): string {
  if (!source || source === 'unknown') return 'unknown'
  if (source.startsWith('claude-transcript')) return 'claude'
  if (source.includes('gemini')) return 'gemini'
  if (source.includes('codex') || source.includes('openai')) return 'codex'
  if (source.includes('grok') || source.includes('xai')) return 'grok'
  return source.split(':')[0] || 'unknown'
}

/** Prefer rows with model_id; first hit wins (ordered by measured_at DESC). */
function modelRuntimeByCycle(
  projectId: string,
  sinceIsoTs: string
): Map<string, { model: string; runtime: string }> {
  const out = new Map<string, { model: string; runtime: string }>()
  try {
    const rows = prjctDb.query<{
      work_cycle_id: string
      model_id: string | null
      source: string | null
    }>(
      projectId,
      `SELECT work_cycle_id, model_id, source
       FROM token_usage
       WHERE measured_at >= ? AND work_cycle_id IS NOT NULL
       ORDER BY (model_id IS NOT NULL) DESC, measured_at DESC`,
      sinceIsoTs
    )
    for (const r of rows) {
      if (!r.work_cycle_id || out.has(r.work_cycle_id)) continue
      out.set(r.work_cycle_id, {
        model: r.model_id?.length ? r.model_id : 'unknown',
        runtime: runtimeFromSource(r.source),
      })
    }
  } catch {
    // fresh DBs may lack rows
  }
  return out
}

function buildPerformanceCycles(projectId: string, days: number): PerformanceCycle[] {
  const since = sinceIso(days)
  const rows = query<PerformanceRow>(
    projectId,
    `SELECT id, description, status, started_at, completed_at, shipped_at,
            tokens_in, tokens_out, linked_spec_id
     FROM tasks
     WHERE COALESCE(completed_at, shipped_at, started_at) >= ?
     ORDER BY COALESCE(completed_at, shipped_at, started_at) DESC
     LIMIT 20`,
    since
  )

  const attribution = modelRuntimeByCycle(projectId, since)
  const cycles = rows.map((row) => {
    const tokensIn = nullableNumber(row.tokens_in)
    const tokensOut = nullableNumber(row.tokens_out)
    const attr = attribution.get(row.id)
    return {
      id: row.id,
      description: row.description,
      status: row.status,
      minutes: durationMinutes(row.started_at, row.completed_at ?? row.shipped_at),
      tokensIn,
      tokensOut,
      tokensTotal:
        tokensIn === null && tokensOut === null ? null : (tokensIn ?? 0) + (tokensOut ?? 0),
      model: attr?.model ?? 'unknown',
      runtime: attr?.runtime ?? 'unknown',
      subagents: 0,
      promptSynthesis: synthesizePrompt(row.description),
      outcome: row.shipped_at ? 'shipped' : row.completed_at ? 'completed' : row.status,
    }
  })

  const seen = new Set(cycles.map((cycle) => cycle.id))
  const measuredEventCycles = buildWorkCostSnapshot(projectId, days)
    .mostExpensive.filter((task) => !seen.has(task.id))
    .map((task) => costTaskToPerformanceCycle(task, attribution.get(task.id)))
  const merged = [...cycles, ...measuredEventCycles].slice(0, 12)
  const spawns = subagentCounts(projectId, sinceIso(days))
  for (const c of merged) c.subagents = spawns.get(c.id) ?? c.subagents ?? 0
  return merged
}

function costTaskToPerformanceCycle(
  task: WorkCostTask,
  attr?: { model: string; runtime: string }
): PerformanceCycle {
  return {
    id: task.id,
    description: task.description,
    status: task.status,
    minutes: task.minutes,
    tokensIn: task.tokensIn,
    tokensOut: task.tokensOut,
    tokensTotal: task.tokensTotal,
    model: attr?.model ?? 'unknown',
    runtime: attr?.runtime ?? 'unknown',
    subagents: 0,
    promptSynthesis: synthesizePrompt(task.description),
    outcome: task.status,
  }
}

async function buildHumanReport(projectId: string, projectPath: string, days: number) {
  const since = sinceIso(days)
  const active = await resolveActiveTask(projectId, projectPath).catch(() => null)
  const ships = query<ShipRow>(
    projectId,
    `SELECT name, shipped_at, description
     FROM shipped_features
     WHERE shipped_at >= ?
     ORDER BY shipped_at DESC
     LIMIT 8`,
    since
  )
  const completed = query<TaskRow>(
    projectId,
    `SELECT id, description, status, completed_at, shipped_at
     FROM tasks
     WHERE COALESCE(completed_at, shipped_at, started_at) >= ?
       AND status IN ('done', 'completed')
     ORDER BY COALESCE(completed_at, shipped_at, started_at) DESC
     LIMIT 10`,
    since
  )
  const decisions = projectMemory.recall(projectId, {
    types: ['decision', 'learning', 'gotcha'],
    limit: 8,
  })

  return {
    days,
    active,
    ships,
    completed,
    decisions,
    value: await buildValueSnapshot(projectId, projectPath),
  }
}

async function buildHandoff(projectId: string, projectPath: string, target: string) {
  const active = await resolveActiveTask(projectId, projectPath).catch(() => null)
  const memories = projectMemory.recall(projectId, {
    types: ['decision', 'gotcha', 'anti-pattern', 'pattern', 'learning'],
    limit: 10,
  })
  const statuses = await detectAgentRuntimes(projectPath)
  const detected = statuses.filter((status) => status.detected)
  return { target, active, memories, detected }
}

async function buildGuardrails(projectId: string, projectPath: string) {
  const files = await changedFiles(projectPath)
  const hits: Array<{ file: string; entry: MemoryEntry }> = []
  for (const file of files.slice(0, 40)) {
    const entries = projectMemory.recallForFile(projectId, file, 3)
    for (const entry of entries) hits.push({ file, entry })
  }

  const fallback =
    hits.length === 0
      ? projectMemory.recall(projectId, {
          types: PREVENTIVE_TYPES as MemoryType[],
          limit: 8,
        })
      : []
  return { files, hits, fallback }
}

async function changedFiles(projectPath: string): Promise<string[]> {
  const names = new Set<string>()
  const diff = await runGit(['diff', '--name-only', 'HEAD'], { cwd: projectPath })
  if (diff.ok) {
    for (const line of diff.stdout.split('\n')) {
      const value = line.trim()
      if (value) names.add(value)
    }
  } else if (diff.kind !== 'exit') {
    // Typed exit → no diff answer; still collect untracked below.
    throwProc(diff)
  }
  const untracked = await runGit(['ls-files', '--others', '--exclude-standard'], {
    cwd: projectPath,
  })
  if (untracked.ok) {
    for (const line2 of untracked.stdout.split('\n')) {
      const value = line2.trim()
      if (value) names.add(value)
    }
  } else if (untracked.kind !== 'exit') {
    throwProc(untracked)
  }
  return [...names].sort()
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

function valueScore(
  memories: ValueSnapshot['memories'],
  workflow: ValueSnapshot['workflow'],
  sync: ValueSnapshot['sync'],
  agents: ValueSnapshot['agents']
): number {
  const memory = Math.min(35, memories.live + memories.preventive * 2 + memories.useful * 3)
  const work = Math.min(
    30,
    workflow.completed * 2 + workflow.shippedFeatures * 4 + workflow.shippedSpecs * 3
  )
  const setup = Math.min(20, agents.detected * 3 + agents.full * 4 + agents.good * 2)
  const context = Math.min(15, sync.syncs + Math.floor(sync.tokensSaved / 25_000))
  return Math.min(100, memory + work + setup + context)
}

function pickDays(input: string | null, optionDays: number | undefined, fallback: number): number {
  if (typeof optionDays === 'number' && optionDays > 0) return Math.floor(optionDays)
  const match = (input ?? '').match(/\b(\d{1,3})\b/)
  if (!match) return fallback
  return Math.max(1, Math.min(90, Number.parseInt(match[1]!, 10)))
}

function wantsFixPlan(input: string | null): boolean {
  return /\b(fix-?plan|plan|actions?)\b/i.test(input ?? '')
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
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

function synthesizePrompt(description: string): string {
  const trimmed = description.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= 140) return trimmed
  return `${trimmed.slice(0, 137)}...`
}

function isNoise(content: string): boolean {
  // Shared SoT with captureGate (anti-basura).
  if (isJunkCaptureContent(content).junk) return true
  const normalized = content.trim()
  return NOISE_RE.test(normalized)
}

function formatValueMd(snapshot: ValueSnapshot): string {
  return [
    '# prjct Value',
    '',
    `**Value score:** ${snapshot.score}/100`,
    '',
    '| Area | Signal |',
    '|---|---:|',
    `| Live memories | ${snapshot.memories.live} |`,
    `| Preventive guardrails | ${snapshot.memories.preventive} |`,
    `| Proven-useful memories | ${snapshot.memories.useful} |`,
    `| Surfaced during active work | ${snapshot.memories.surfaced} |`,
    `| Completed tasks | ${snapshot.workflow.completed} / ${snapshot.workflow.tasks} |`,
    `| Shipped features | ${snapshot.workflow.shippedFeatures} |`,
    `| Specs shipped | ${snapshot.workflow.shippedSpecs} / ${snapshot.workflow.specs} |`,
    `| Sync runs | ${snapshot.sync.syncs} |`,
    `| Tokens saved by sync metrics | ${snapshot.sync.tokensSaved.toLocaleString()} |`,
    `| Detected agent runtimes | ${snapshot.agents.detected} |`,
    '',
    'Use this as the paid-tier proof screen: it measures continuity, prevention, reuse, and multi-agent setup from real project data.',
  ].join('\n')
}

function formatValueText(snapshot: ValueSnapshot): string {
  return [
    `prjct value: ${snapshot.score}/100`,
    `memory: ${snapshot.memories.live} live, ${snapshot.memories.preventive} preventive, ${snapshot.memories.useful} useful`,
    `workflow: ${snapshot.workflow.completed}/${snapshot.workflow.tasks} completed tasks, ${snapshot.workflow.shippedFeatures} ships`,
    `sync: ${snapshot.sync.syncs} runs, ${snapshot.sync.tokensSaved.toLocaleString()} tokens saved`,
    `agents: ${snapshot.agents.detected} detected runtimes`,
  ].join('\n')
}

function formatMemoryDoctorMd(
  report: ReturnType<typeof buildMemoryDoctor>,
  includeFixPlan = false
): string {
  const lines = ['# Memory Doctor', '', `**Quality score:** ${report.score}/100`, '']
  lines.push('## Distribution', '', '| Type | Entries |', '|---|---:|')
  for (const row of report.byType) lines.push(`| ${row.type ?? 'unknown'} | ${row.value} |`)
  if (report.substrate) {
    lines.push('', formatSubstrateHealthMd(report.substrate))
  }
  lines.push('', '## Issues')
  if (report.issues.length === 0) lines.push('', '- No obvious memory quality issues found.')
  else for (const issue of report.issues) lines.push(`- ${issue}`)
  lines.push('', '## Cleanup candidates')
  appendMemoryRows(lines, 'Old inbox', report.staleInbox)
  appendMemoryRows(lines, 'Low signal', report.noise)
  lines.push(
    '',
    'Recommended actions: promote old inbox entries into `decision`, `learning`, `gotcha`, `red-herring`, or `todo`; forget noise by id; keep useful memories explicit and file-linked when possible.',
    'Absence of a risk in memory is not proof it does not exist — trust density + blind spots above.'
  )
  if (includeFixPlan) appendMemoryFixPlan(lines, report)
  return lines.join('\n')
}

function formatMemoryDoctorText(
  report: ReturnType<typeof buildMemoryDoctor>,
  includeFixPlan = false
): string {
  const lines = [`Memory doctor: ${report.score}/100`]
  if (report.substrate) {
    lines.push(
      `substrate: signal=${Math.round(report.substrate.signalRatio * 100)}% unshaped_gotcha=${Math.round(report.substrate.unshapedGotchaRate * 100)}% empty_spec=${Math.round(report.substrate.emptySpecRate * 100)}% cluster≈${report.substrate.clusterCollapsedEstimate}`
    )
  }
  if (report.issues.length === 0) lines.push('No obvious memory quality issues found.')
  else lines.push(...report.issues.map((issue) => `- ${issue}`))
  if (includeFixPlan) lines.push(`Fix-plan actions: ${memoryFixPlan(report).length}`)
  return lines.join('\n')
}

function memoryFixPlan(report: ReturnType<typeof buildMemoryDoctor>): string[] {
  const actions: string[] = []
  for (const row of report.staleInbox) {
    actions.push(
      `Review ${row.id}: promote old inbox to decision/learning/gotcha/todo, or forget it if obsolete.`
    )
  }
  for (const row2 of report.noise) {
    actions.push(`Forget or rewrite ${row2.id}: low-signal content "${summarizeMemory(row2)}".`)
  }
  if (report.duplicateGroups > 0) {
    actions.push(
      `Review ${report.duplicateGroups} duplicate memory group(s) and keep the clearest entry.`
    )
  }
  if (report.missingType > 0) {
    actions.push(`Backfill ${report.missingType} memory row(s) with explicit memory types.`)
  }
  if (report.provenUseful === 0) {
    actions.push(
      'Use `prjct guard` / `prjct context memory` during real work so useful memory earns credit.'
    )
  }
  return actions
}

function appendMemoryFixPlan(lines: string[], report: ReturnType<typeof buildMemoryDoctor>): void {
  const actions = memoryFixPlan(report)
  lines.push('', '## Fix Plan')
  if (actions.length === 0) {
    lines.push('- No cleanup actions needed.')
    return
  }
  for (const action of actions) lines.push(`- ${action}`)
  lines.push(
    '',
    'This is a plan, not an auto-fix: review each item before deleting or rewriting project memory.'
  )
}

function formatReportMd(report: Awaited<ReturnType<typeof buildHumanReport>>): string {
  const lines = [`# Weekly Report (${report.days} days)`, '']
  lines.push(`**Value score:** ${report.value.score}/100`)
  lines.push(`**Active work cycle:** ${report.active?.description ?? 'None'}`, '')
  lines.push('## Shipped')
  if (report.ships.length === 0) lines.push('- No shipped features recorded in this window.')
  else {
    for (const ship of report.ships) {
      lines.push(
        `- **${ship.name}** — ${ship.description ?? 'No description'} (${ship.shipped_at})`
      )
    }
  }
  lines.push('', '## Completed Work')
  if (report.completed.length === 0)
    lines.push('- No completed work cycles recorded in this window.')
  else for (const task of report.completed) lines.push(`- ${task.description}`)
  lines.push('', '## Decisions / Lessons To Carry Forward')
  appendEntries(lines, report.decisions)
  return lines.join('\n')
}

function formatReportText(report: Awaited<ReturnType<typeof buildHumanReport>>): string {
  return [
    `Weekly report (${report.days} days)`,
    `Value: ${report.value.score}/100`,
    `Active: ${report.active?.description ?? 'None'}`,
    `Shipped: ${report.ships.length}`,
    `Completed: ${report.completed.length}`,
    `Carry-forward memories: ${report.decisions.length}`,
  ].join('\n')
}

function formatHandoffMd(handoff: Awaited<ReturnType<typeof buildHandoff>>): string {
  const lines = [
    `# Handoff for ${handoff.target}`,
    '',
    'Paste this into the next coding agent, then ask it to run the listed commands before editing.',
    '',
    '```text',
    `You are taking over this project with prjct available.`,
    `Active work cycle: ${handoff.active?.description ?? 'none'}.`,
    'First run:',
    '1. prjct work --md',
    '2. prjct insights value --md',
    '3. prjct insights quality --md',
    '4. prjct insights guardrails --md',
    '5. prjct performance --md',
    'Before editing any risky file, run prjct guard <file> --md.',
    '```',
    '',
    '## Detected runtimes',
    handoff.detected.length > 0
      ? handoff.detected.map((s) => `- ${s.runtime.displayName}: ${s.supportLevel}`).join('\n')
      : '- No runtime-specific signals detected; AGENTS.md remains the baseline.',
    '',
    '## Context to preserve',
  ]
  appendEntries(lines, handoff.memories)
  return lines.join('\n')
}

function formatHandoffText(handoff: Awaited<ReturnType<typeof buildHandoff>>): string {
  return [
    `Handoff for ${handoff.target}`,
    `Active: ${handoff.active?.description ?? 'none'}`,
    'Run: prjct work --md; prjct insights value --md; prjct insights guardrails --md; prjct performance --md',
    `Context entries: ${handoff.memories.length}`,
  ].join('\n')
}

function formatGuardrailsMd(report: Awaited<ReturnType<typeof buildGuardrails>>): string {
  const lines = ['# Risk Guardrails', '']
  lines.push(`Changed files checked: ${report.files.length}`)
  if (report.hits.length > 0) {
    lines.push('', '## File-specific warnings')
    for (const hit of report.hits) {
      lines.push(
        `- \`${hit.file}\`: **[${preventiveLabel(hit.entry)}] ${deriveTitle(hit.entry)}** — ${flatDetail(hit.entry.content)}  \`${hit.entry.id}\``
      )
    }
  } else {
    lines.push('', 'No file-specific preventive memory matched the current changeset.')
    if (report.fallback.length > 0) {
      lines.push('', '## General project traps')
      appendEntries(lines, report.fallback)
    }
  }
  lines.push('', '_Advisory only. This command does not block or mutate anything._')
  return lines.join('\n')
}

function formatGuardrailsText(report: Awaited<ReturnType<typeof buildGuardrails>>): string {
  if (report.hits.length === 0)
    return `Risk guardrails: ${report.files.length} files checked, no file-specific hits.`
  return `Risk guardrails: ${report.hits.length} warning(s) across ${report.files.length} changed file(s).`
}

function formatPerformanceMd(days: number, cycles: PerformanceCycle[]): string {
  const lines = ['# AI Work Performance', '', `Window: last ${days} day(s)`, '']
  if (cycles.length === 0) {
    lines.push(
      'No work cycles recorded in this window.',
      '',
      'Run `prjct insights cost --md` to see the capture gaps that currently prevent token and session attribution.'
    )
    return lines.join('\n')
  }
  lines.push(
    '| Work cycle | Outcome | Time | Tokens | Subagents | Model | Runtime | Prompt synthesis |'
  )
  lines.push('|---|---|---:|---:|---:|---|---|---|')
  for (const cycle of cycles) {
    lines.push(
      `| ${escapeCell(cycle.description)} | ${cycle.outcome} | ${cycle.minutes ?? 'unknown'} | ${cycle.tokensTotal ?? 'unknown'} | ${cycle.subagents} | ${cycle.model} | ${cycle.runtime} | ${escapeCell(cycle.promptSynthesis)} |`
    )
  }
  lines.push(
    '',
    'Model/runtime/tokens are `unknown` when the active editor does not expose them yet. Keep unknown explicit; do not infer.'
  )
  return lines.join('\n')
}

function formatPerformanceText(days: number, cycles: PerformanceCycle[]): string {
  if (cycles.length === 0) return `AI work performance (${days}d): no work cycles recorded.`
  const knownTime = cycles.filter((cycle) => cycle.minutes !== null)
  const minutes = knownTime.reduce((sum, cycle) => sum + (cycle.minutes ?? 0), 0)
  return `AI work performance (${days}d): ${cycles.length} cycle(s), ${knownTime.length} with duration, ${minutes} known minute(s).`
}

function formatLatencyMd(report: LatencyReport): string {
  const lines = ['# prjct performance', '', `Window: ${report.period}`, '']
  const rows = Object.entries(report.commands).sort(([a], [b]) => a.localeCompare(b))
  if (rows.length === 0) {
    lines.push('No command or hook latency samples recorded in this window.')
    return lines.join('\n')
  }
  lines.push('| Command / hook | Samples | p50 | p95 | Avg | Min | Max |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|')
  for (const [command, stats] of rows) {
    lines.push(
      `| ${escapeCell(command)} | ${stats.count} | ${stats.p50.toFixed(1)}ms | ${stats.p95.toFixed(1)}ms | ${stats.avg.toFixed(1)}ms | ${stats.min.toFixed(1)}ms | ${stats.max.toFixed(1)}ms |`
    )
  }
  lines.push(
    '',
    'Hook samples are recorded after the host-visible response; telemetry never blocks the hook.'
  )
  return lines.join('\n')
}

function formatLatencyText(report: LatencyReport): string {
  const rows = Object.entries(report.commands)
  if (rows.length === 0) return `prjct performance (${report.period}): no latency samples.`
  return rows
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([command, stats]) =>
        `${command}: p50 ${stats.p50.toFixed(1)}ms · p95 ${stats.p95.toFixed(1)}ms · n=${stats.count}`
    )
    .join('\n')
}

/**
 * Net-savings view: measured tokens/cycle now vs. the declared historical
 * baseline (e.g. a captured "90k tokens" mention from before this optimization).
 * This is the line that answers prjct's north star — "does using prjct cost
 * fewer tokens than not?" Renders an honest "insufficient data" note until both
 * sides have signal, rather than a fake number.
 */
function formatNetSavingsMd(snapshot: WorkCostSnapshot): string[] {
  const lines = ['## Net Savings vs. Baseline', '']
  const avgMeasured =
    snapshot.knownTokenCycles > 0 ? snapshot.tokensTotal / snapshot.knownTokenCycles : null
  const mentions = snapshot.historicalRescue.declaredTokenMentions
  const avgDeclared = mentions > 0 ? snapshot.historicalRescue.declaredTokensTotal / mentions : null

  if (avgMeasured === null || avgDeclared === null || avgDeclared === 0) {
    lines.push(
      '- Insufficient data yet: need at least one token-measured cycle and one declared baseline mention.',
      ''
    )
    return lines
  }

  const deltaPct = Math.round(((avgDeclared - avgMeasured) / avgDeclared) * 100)
  const verdict = deltaPct > 0 ? `${deltaPct}% fewer` : `${Math.abs(deltaPct)}% more`
  lines.push('| Metric | Value |', '|---|---:|')
  lines.push(`| Avg measured tokens/cycle | ${Math.round(avgMeasured).toLocaleString()} |`)
  lines.push(`| Avg declared baseline tokens | ${Math.round(avgDeclared).toLocaleString()} |`)
  lines.push(`| Net | **${verdict} tokens/cycle** |`)
  lines.push('')
  return lines
}

function formatCostMd(snapshot: WorkCostSnapshot): string {
  const lines = ['# AI Work Cost', '', `Window: last ${snapshot.windowDays} day(s)`, '']
  lines.push('## Subscription Burn', '', '| Metric | Value |', '|---|---:|')
  lines.push(`| Work cycles | ${snapshot.workCycles} |`)
  lines.push(`| Token-measured cycles | ${snapshot.knownTokenCycles} |`)
  lines.push(`| Token coverage | ${snapshot.tokenCoveragePercent}% |`)
  lines.push(`| Input tokens | ${snapshot.tokensIn.toLocaleString()} |`)
  lines.push(`| Output tokens | ${snapshot.tokensOut.toLocaleString()} |`)
  lines.push(`| Total tokens | ${snapshot.tokensTotal.toLocaleString()} |`)
  lines.push(`| Agent sessions | ${snapshot.measuredSessions} |`)
  lines.push('')
  if (snapshot.byModel.length > 0) {
    lines.push('## By Model', '', '| Model | Input | Output | Total |', '|---|---:|---:|---:|')
    for (const m of snapshot.byModel) {
      lines.push(
        `| ${m.model} | ${m.tokensIn.toLocaleString()} | ${m.tokensOut.toLocaleString()} | ${(m.tokensIn + m.tokensOut).toLocaleString()} |`
      )
    }
    lines.push('')
  }
  lines.push(...formatNetSavingsMd(snapshot))
  lines.push('## Historical Rescue', '', '| Signal | Value |', '|---|---:|')
  lines.push(`| Inferred work cycles | ${snapshot.historicalRescue.inferredWorkCycles} |`)
  lines.push(`| Normalized task rows | ${snapshot.historicalRescue.taskTableCycles} |`)
  lines.push(`| Historical work-start events | ${snapshot.historicalRescue.eventWorkStarts} |`)
  lines.push(`| Historical shipped events | ${snapshot.historicalRescue.eventShips} |`)
  lines.push(`| Sync runs | ${snapshot.historicalRescue.syncRuns} |`)
  lines.push(`| Memory events | ${snapshot.historicalRescue.memoryEvents} |`)
  lines.push(`| Post-edit events | ${snapshot.historicalRescue.postEditEvents} |`)
  lines.push(`| Declared token mentions | ${snapshot.historicalRescue.declaredTokenMentions} |`)
  lines.push(
    `| Declared tokens total | ${snapshot.historicalRescue.declaredTokensTotal.toLocaleString()} |`
  )
  lines.push('')
  lines.push('## Context Efficiency', '', '| Signal | Value |', '|---|---:|')
  lines.push(`| Context surfaced during work | ${snapshot.surfacedContext} |`)
  lines.push(`| Proven useful context used | ${snapshot.usefulContext} |`)
  lines.push(`| Context zone events | ${snapshot.contextZoneEvents} |`)
  lines.push(`| Compactions | ${snapshot.compactions} |`)
  lines.push(`| CLI command samples | ${snapshot.commandSamples} |`)
  lines.push(`| CLI command time | ${formatMs(snapshot.commandMs)} |`)
  lines.push(
    `| Avg startup | ${snapshot.avgStartupMs === null ? 'unknown' : formatMs(snapshot.avgStartupMs)} |`
  )
  lines.push('', '## Most Expensive Work')
  if (snapshot.mostExpensive.length === 0) {
    lines.push('- No token-measured work cycles yet.')
  } else {
    lines.push('', '| Work cycle | Tokens | In | Out | Time | Outcome |')
    lines.push('|---|---:|---:|---:|---:|---|')
    for (const task of snapshot.mostExpensive) {
      lines.push(
        `| ${escapeCell(task.description)} | ${task.tokensTotal.toLocaleString()} | ${task.tokensIn.toLocaleString()} | ${task.tokensOut.toLocaleString()} | ${task.minutes ?? 'unknown'} | ${task.status} |`
      )
    }
  }
  if (snapshot.historicalRescue.topDeclaredTokenMentions.length > 0) {
    lines.push('', '## Declared Token Mentions')
    lines.push('', '| Tokens | Source | When | Summary |')
    lines.push('|---:|---|---|---|')
    for (const mention of snapshot.historicalRescue.topDeclaredTokenMentions) {
      lines.push(
        `| ${mention.tokens.toLocaleString()} | ${mention.sourceType} | ${mention.occurredAt} | ${escapeCell(mention.summary)} |`
      )
    }
  }
  lines.push('', '## No-Go Gaps')
  if (snapshot.gaps.length === 0) {
    lines.push('- Cost attribution has enough local data to explain recent AI work.')
  } else {
    for (const gap of snapshot.gaps) lines.push(`- ${gap}`)
  }
  lines.push(
    '',
    'Exact tokens stay exact only when the agent/runtime exposes them. Estimated usage must be labeled as estimated; missing usage must stay visible.'
  )
  return lines.join('\n')
}

function formatCostText(snapshot: WorkCostSnapshot): string {
  return [
    `AI work cost (${snapshot.windowDays}d)`,
    `tokens: ${snapshot.tokensTotal.toLocaleString()} total across ${snapshot.knownTokenCycles}/${snapshot.workCycles} measured cycle(s)`,
    `declared historical tokens: ${snapshot.historicalRescue.declaredTokensTotal.toLocaleString()} across ${snapshot.historicalRescue.declaredTokenMentions} mention(s)`,
    `context: ${snapshot.surfacedContext} surfaced, ${snapshot.usefulContext} proven useful`,
    ...snapshot.byModel.map(
      (m) => `  ${m.model}: ${(m.tokensIn + m.tokensOut).toLocaleString()} tokens`
    ),
    snapshot.gaps.length === 0 ? 'gaps: none' : `gaps: ${snapshot.gaps.length}`,
  ].join('\n')
}

function formatReliabilityMd(snapshot: ReliabilitySnapshot): string {
  const lines = ['# prjct Reliability', '', `Window: last ${snapshot.windowDays} day(s)`, '']
  lines.push(`**Reliability score:** ${snapshot.score}/100`, '')
  lines.push('| Signal | Coverage |', '|---|---:|')
  lines.push(`| Work-cycle normalization | ${snapshot.workCycleCoveragePercent}% |`)
  lines.push(`| Token attribution | ${snapshot.tokenCoveragePercent}% |`)
  lines.push(`| Agent session attribution | ${snapshot.sessionCoveragePercent}% |`)
  lines.push(`| Context reuse proof | ${snapshot.contextReusePercent}% |`)
  lines.push(`| Memory quality | ${snapshot.memoryScore}/100 |`)
  lines.push(`| Value score | ${snapshot.valueScore}/100 |`)
  lines.push(`| Command telemetry samples | ${snapshot.commandTelemetry.samples} |`)
  lines.push(
    `| Average startup | ${
      snapshot.commandTelemetry.avgStartupMs === null
        ? 'unknown'
        : formatMs(snapshot.commandTelemetry.avgStartupMs)
    } |`
  )
  lines.push('', '## Gaps')
  if (snapshot.gaps.length === 0) lines.push('- No reliability gaps detected in this window.')
  else for (const gap of snapshot.gaps) lines.push(`- ${gap}`)
  lines.push('', '## Next Actions')
  for (const action of snapshot.nextActions) lines.push(`- ${action}`)
  lines.push(
    '',
    'Reliability is a measurement-readiness score: it says whether value/cost/performance numbers are safe to use for decisions.'
  )
  return lines.join('\n')
}

function formatReliabilityText(snapshot: ReliabilitySnapshot): string {
  return [
    `prjct reliability: ${snapshot.score}/100`,
    `coverage: work ${snapshot.workCycleCoveragePercent}%, tokens ${snapshot.tokenCoveragePercent}%, sessions ${snapshot.sessionCoveragePercent}%`,
    `memory: ${snapshot.memoryScore}/100, value: ${snapshot.valueScore}/100`,
    `next: ${snapshot.nextActions[0] ?? 'keep measuring'}`,
  ].join('\n')
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function appendEntries(lines: string[], entries: MemoryEntry[]): void {
  if (entries.length === 0) {
    lines.push('- None recorded yet.')
    return
  }
  for (const entry of entries) {
    lines.push(
      `- **[${entry.type}] ${deriveTitle(entry)}** — ${flatDetail(entry.content)}  \`${entry.id}\``
    )
  }
}

function appendMemoryRows(lines: string[], title: string, rows: MemoryRow[]): void {
  lines.push('', `### ${title}`)
  if (rows.length === 0) {
    lines.push('- None.')
    return
  }
  for (const row of rows) {
    lines.push(
      `- **${row.type ?? 'unknown'}** ${row.title ?? row.content.slice(0, 80)}  \`${row.id}\``
    )
  }
}

function summarizeMemory(row: MemoryRow): string {
  const raw = row.title || row.content
  const normalized = raw.replace(/\s+/g, ' ').trim()
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57)}...`
}
