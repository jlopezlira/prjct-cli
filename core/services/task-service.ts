/**
 * Task service — compatibility backend for `prjct work` and MCP work state.
 *
 * Extracted so the MCP write-path (`prjct_task_start` / `prjct_task_set_status`)
 * fires the SAME gates, memory logs, spec linkage, and state-machine
 * transitions as the CLI — without the CLI's stdout writes, which would
 * corrupt the MCP stdio JSON-RPC stream. The command layer (workflow.now /
 * primitives.status) calls these and owns presentation; the MCP tools call
 * these and format their own text. One behavior, two front-ends, zero drift.
 *
 * Side-effect notes (must match the CLI byte-for-byte):
 *  - `startTask` logs `task_started` WITH author (CLI used `logToMemory`).
 *  - `setTaskStatus` logs `STATUS_CHANGE_ACTION` WITHOUT author (CLI called
 *    `memoryService.log` directly).
 *  - `memoryService.log` only ever writes to stderr on failure, never stdout,
 *    so it is safe under MCP stdio.
 */

import { REGISTERED_VERBS_SET } from '../commands/verb-names'
import configManager from '../infrastructure/config-manager'
import { STATUS_CHANGE_ACTION } from '../memory/events'
import { deriveTitle as deriveMemTitle, flatDetail, preventiveLabel } from '../memory/format'
import { projectMemory } from '../memory/project-memory'
import { generateUUID } from '../schemas/schemas'
import type { CurrentTask, TaskFeedback, TaskHarness } from '../schemas/state'
import { getGitBranch } from '../session/git-helpers'
import { stateStorage } from '../storage/state-storage'
import { upsertTaskPipelineState } from '../storage/task-pipeline-storage'
import * as dateHelper from '../utils/date-helper'
import { GitInfraError } from '../utils/exec'
import { executeWorkflowRules } from '../workflow-engine/workflow-engine'
import { type LikelyFileHit, rankLikelyFiles } from './file-cue'
import { buildLivingContextPrompt, parseLivingContextFields } from './living-context-contract'
import { memoryService } from './memory-service'
import {
  type OutputProfile,
  outputProfileFor,
  type PrivateSkillRoute,
  routePrivateSkills,
  tddRoutingMode,
} from './private-skill-router'
import projectService from './project-service'
import { detectRepositoryWorkflowState } from './repository-workflow-state'
import { buildTaskHarness, evaluateHarnessCompletion } from './task-harness'
import { type OrchestrationPlan, orchestrationFor } from './task-orchestration'
import {
  decideTaskPipeline,
  formatTaskPipelineNextAction,
  type TaskPipelineClassification,
  type TaskPipelineStation,
} from './task-pipeline'
import { deriveWorkspace, MAIN_WORKSPACE_ID } from './workspace-id'

/** Status values that mean "make this task the active one again". */
const RESUME_VALUES = ['active', 'resume', 'in_progress', 'working']

/** QA phase at work start — plan state + the AUTHORITATIVE directive. */
export interface QaWorkOutcome {
  mode: 'off' | 'advisory' | 'strict'
  planExists: boolean
  seeded: boolean
  criteriaCount: number
  flowsCount: number
  section: string | null
  directive: string | null
}

export interface StartTaskOutcome {
  ok: boolean
  /** Set when a `before_task` gate or hook blocked the start. */
  blocked?: string
  taskId?: string
  description?: string
  branch?: string
  linearId?: string
  linkedSpecId?: string
  harness?: TaskHarness
  /** Triage → orchestration plan: model/effort + spec/tests + fan-out directive. */
  orchestration?: OrchestrationPlan
  /** Private package-owned engineering pointers selected for this intent. */
  privateSkills?: PrivateSkillRoute
  /** Adaptive model response discipline selected for this intent. */
  outputProfile?: OutputProfile
  pipeline?: {
    classification: TaskPipelineClassification
    station: TaskPipelineStation
    nextAction: string
    requiresSpec: boolean
    requiresTestsFirst: boolean
  }
  /** Agent instructions emitted by `before_task` rules. */
  instructions?: string[]
  /**
   * Context recalled from the project's RAG that relates to THIS task's
   * description — past contexts, decisions, traps. The "second brain" answer to
   * "has this happened before? who touched it? what was decided?", surfaced
   * on-demand at task start (PULL, not a session-start dump).
   */
  relatedContext?: RelatedContextHit[]
  /**
   * File targets ranked from the sync-built code indexes for THIS work
   * description. This is the cheap repo map that prevents agents from
   * spending the first minutes rediscovering where existing code lives.
   */
  likelyFiles?: LikelyFileHit[]
  /**
   * PREDICTIVE risk for THIS cycle: preventive memory (gotchas, anti-patterns,
   * recurring-bugs) recorded against the likely files, surfaced at planning so
   * the trap is seen BEFORE the edit instead of stepped in. Reactive guard made
   * proactive — scoped to the area the work will actually touch.
   */
  risks?: RiskHit[]
  /** Dynasty D5: one-shot cycle budget line printed at work start. */
  cycleBudget?: string | null
  /** QA phase: present when the phase applies to this cycle (H1+, mode ≠ off). */
  qa?: QaWorkOutcome
  /** Multi-agent owner stamped at start. */
  ownerAgent?: string
  ownerIdentity?: string
  /**
   * When auto-worktree isolation fired: path + branch of the new worktree.
   * Caller should print `cd <path>` so the agent continues there.
   */
  isolation?: {
    reason: string
    worktreePath: string
    branch: string
    slug: string
    occupantSummary: string
  }
}

/** One predictive-risk hit — a preventive memory tied to a likely file. */
export interface RiskHit {
  id: string
  label: string
  title: string
  file: string
}

export interface RelatedContextHit {
  id: string
  type: string
  title: string
  detail: string
  /** ISO timestamp the entry was captured. */
  when: string
  author?: string
  keyData?: string
  feature?: string
  files?: string[]
  why?: string
  pattern?: string
  antiPattern?: string
  decisionTrap?: string
  outcome?: string
  nextImplication?: string
}

const RELATED_SALIENT_MAX = 120

/**
 * Compact but self-sufficient one-liner for the passive `work` surface:
 * `[type] title (date) \`id\` — <single most salient field>`.
 *
 * The full body stays one `prjct search <id>` away. We surface only the field
 * most likely to change what the agent does — a trap/decision/anti-pattern
 * outranks generic "why/outcome/key data" — instead of joining every field
 * (which ran ~500 chars/entry). Drops the passive surface to ~100 chars/entry
 * while still carrying the actionable signal.
 */
export function formatRelatedContextForAgent(hit: RelatedContextHit): string {
  // Living apply: SoT (binding) vs SUGGEST (live mod) vs plain context.
  const role =
    hit.type === 'decision' || hit.type === 'gotcha' || hit.type === 'fact' || hit.type === 'spec'
      ? 'SoT'
      : hit.type === 'anti-pattern' || hit.type === 'pattern' || hit.type === 'learning'
        ? 'SUGGEST'
        : 'ctx'
  const when = hit.when ? hit.when.slice(0, 10) : ''
  const who = hit.author ? ` by ${hit.author}` : ''
  const meta = [when, who].filter(Boolean).join('')
  const head = `[${role}·${hit.type}] ${hit.title}${meta ? ` (${meta.trim()})` : ''}  \`${hit.id}\``

  const salient =
    hit.decisionTrap ??
    hit.antiPattern ??
    hit.nextImplication ??
    hit.why ??
    hit.outcome ??
    hit.keyData ??
    hit.detail
  if (!salient) {
    return role === 'SoT' ? `${head} — BINDING; supersede via prjct remember if wrong` : head
  }
  const trimmed =
    salient.length > RELATED_SALIENT_MAX ? `${salient.slice(0, RELATED_SALIENT_MAX - 1)}…` : salient
  // Agent surfaces these as terminal tips to the user (no web UI).
  if (role === 'SoT') return `${head} — tip→user · SoT: ${trimmed}`
  if (role === 'SUGGEST') {
    const files =
      hit.files && hit.files.length > 0 ? ` in \`${hit.files.slice(0, 2).join('`, `')}\`` : ''
    return `${head} — tip→user · suggest${files}: ${trimmed}`
  }
  return `${head} — ${trimmed}`
}

/**
 * Compact predictive-risk line for work start (CLI + MCP parity).
 * Same shape agents already see from `prjct work`: label, title, file, id.
 */
export function formatRiskForAgent(risk: RiskHit): string {
  return `[${risk.label}] ${risk.title} — \`${risk.file}\`  \`${risk.id}\``
}

/**
 * Start a work cycle: run before/after workflow rules, persist state, link a spec
 * if requested, and log the `task_started` event. Returns structured data;
 * the caller prints. Mirrors the side-effects of `workflow.now`.
 */
export async function startTask(
  projectId: string,
  projectPath: string,
  description: string,
  options: {
    skipHooks?: boolean
    spec?: string
    /** Explicit delivery geometry when the working tree is large (strict gate). */
    geometry?: 'direct' | 'single' | 'split'
  } = {}
): Promise<StartTaskOutcome> {
  // Verb-collision guard. Agents on non-Claude harnesses (e.g. Codex) that
  // don't have the verb-intent map memorized tend to wrap a bare CLI verb as
  // a work description — `prjct work "sync"` instead of `prjct sync`. A lone
  // registered verb is never a real work intent, so reject it and point at the
  // command they meant. Multi-word descriptions ("ship the onboarding flow")
  // pass untouched.
  const lone = description.trim().toLowerCase()
  if (REGISTERED_VERBS_SET.has(lone)) {
    return {
      ok: false,
      blocked: `'${lone}' is a prjct command, not a work intent. Did you mean \`prjct ${lone}\`? To start a work cycle, describe the task (e.g. \`prjct work "fix the ${lone} flow"\`).`,
    }
  }

  // before_task workflow rules (gates may block, hooks may nudge).
  const beforeResult = await executeWorkflowRules(projectId, 'task', 'before', {
    projectPath,
    skipRules: options.skipHooks,
  })
  if (!beforeResult.success) {
    const blocked =
      beforeResult.gatesFailed.length > 0
        ? `Blocked: ${beforeResult.gatesFailed.join(', ')}`
        : `Hook failed: ${beforeResult.hooksFailed.join(', ')}`
    return { ok: false, blocked }
  }

  const cfg = await configManager.readConfig(projectPath).catch(() => null)

  // Product default: coding repos heal onto pack `code` (conflictMode advisory)
  // so MCP/CLI agents get predictive risk + pre-edit anticipation without a
  // second `prjct pack add`. Best-effort; never blocks work start.
  try {
    const { ensureCodingAnticipationDefaults } = await import('../packs/pack-manager')
    const heal = await ensureCodingAnticipationDefaults(projectPath)
    if (heal.healed && heal.reason === 'activated-code') {
      console.log(
        'ℹ Anticipation ON: activated pack `code` (conflictMode advisory) — traps surface before edit'
      )
    } else if (heal.healed && heal.reason === 'conflictMode-healed') {
      console.log('ℹ Anticipation ON: conflictMode → advisory for pack code')
    }
  } catch {
    /* pack heal never blocks a start */
  }

  // Discuss-lock + SDD gate (dominance vs GSD discuss-before-plan):
  //   - strict: every work cycle needs a REVIEWED intent/spec
  //   - advisory: H2/H3 only (product lock without full ceremony on chores)
  //   - off: never blocks
  // Built from harness level so CLI + MCP share one path.
  {
    const { effectiveSddMode } = await import('../commands/sdd')
    const { discussLockVerdict } = await import('./discuss-lock')
    const harnessPreview = buildTaskHarness(description)
    const specStatus = options.spec
      ? await import('./spec-service')
          .then(({ specService }) => specService.get(projectPath, options.spec!))
          .then((spec) => spec?.status ?? null)
          .catch(() => null)
      : null
    if (options.spec && specStatus === null) {
      const { specService } = await import('./spec-service')
      const confirmedMissing = await specService
        .get(projectPath, options.spec)
        .then((spec) => !spec)
        .catch(() => false)
      if (confirmedMissing) return { ok: false, blocked: `Spec ${options.spec} not found.` }
    }
    const lock = discussLockVerdict({
      sddMode: effectiveSddMode(cfg),
      harnessLevel: harnessPreview.level,
      hasSpecId: Boolean(options.spec),
      specStatus,
    })
    if (lock.blocked) {
      return { ok: false, blocked: lock.message }
    }
  }

  // Nyquist-lite on H2+ work with linked spec — vague ACs block (strict) or warn.
  if (options.spec) {
    try {
      const { effectiveSddMode } = await import('../commands/sdd')
      const { effectiveTddMode } = await import('../commands/tdd')
      const { effectiveNyquistWorkMode, nyquistWorkVerdict } = await import('./nyquist-lite')
      const { specService } = await import('./spec-service')
      const harnessPreview = buildTaskHarness(description)
      const spec = await specService.get(projectPath, options.spec)
      const criteria = spec?.content?.acceptance_criteria ?? []
      const nv = nyquistWorkVerdict({
        harnessLevel: harnessPreview.level,
        criteria,
        mode: effectiveNyquistWorkMode(effectiveSddMode(cfg), effectiveTddMode(cfg)),
      })
      if (nv.blocked) {
        return { ok: false, blocked: nv.message ?? 'Nyquist-lite blocked work start.' }
      }
      if (nv.message) {
        console.log(nv.message)
      }
    } catch {
      /* nyquist best-effort */
    }
  }

  // Delivery-geometry gate: large working tree OR large H2+ intent (Dynasty D4).
  {
    const mode = cfg?.deliveryGeometry?.mode ?? 'off'
    try {
      const { existsSync } = await import('node:fs')
      const path = await import('node:path')
      const {
        computeWorkingTreeChangeset,
        geometryOf,
        tierOf,
        geometryBlockMessage,
        intentGeometryVerdict,
        NORMAL_MAX_LOC,
      } = await import('./delivery-geometry')
      const harnessPreview = buildTaskHarness(description)
      const cs = existsSync(path.join(projectPath, '.git'))
        ? await computeWorkingTreeChangeset(projectPath)
        : null
      const threshold = cfg?.deliveryGeometry?.locThreshold ?? NORMAL_MAX_LOC
      const treeLarge = Boolean(cs && cs.loc >= threshold)
      // Legacy path: strict + fat tree without --geometry still hard-blocks.
      if (mode === 'strict' && treeLarge && cs && !options.geometry) {
        const geometry = geometryOf(tierOf(cs))
        return { ok: false, blocked: geometryBlockMessage(cs, geometry) }
      }
      // Geometry-at-intent: H2+/H3 plan delivery shape before code.
      const ig = intentGeometryVerdict({
        harnessLevel: harnessPreview.level,
        harnessRisk: harnessPreview.risk,
        mode,
        explicitGeometry: options.geometry ?? null,
        treeLarge,
      })
      if (ig.blocked) {
        return { ok: false, blocked: ig.message ?? 'Delivery geometry required at intent.' }
      }
      if (ig.message) console.log(ig.message)
    } catch (err) {
      /* geometry is best-effort — never block on git errors …
         …EXCEPT in strict mode: there the gate is a hard contract, and a
         git infra failure makes it unevaluable — block with the cause
         instead of failing open. */
      if (err instanceof GitInfraError && mode === 'strict') {
        return {
          ok: false,
          blocked: `Delivery geometry gate unevaluable: ${err.message}. Re-run when git is healthy, or pass \`--geometry\` explicitly.`,
        }
      }
    }
  }

  // Optional Linear issue linkage — matches e.g. `PRJ-42`. Pure tag.
  const linearId = /^[A-Z]+-\d+$/.test(description) ? description : undefined

  const taskId = generateUUID()
  const linkedSpecId = options.spec
  const harness = buildTaskHarness(description)
  const routingInput = {
    intent: description,
    harness,
    tddMode: tddRoutingMode(cfg?.tdd?.mode),
    ...detectRepositoryWorkflowState(projectPath),
  } as const
  const privateSkills = routePrivateSkills(routingInput)
  const outputProfile = outputProfileFor(routingInput)

  // Triage → orchestration: turn the harness + the project's SDD/TDD modes
  // into a concrete plan (model tier, effort, spec/tests ceremony, fan-out) so
  // a trivial task runs cheap and DIRECT while a complex one gets spec + TDD +
  // a subagent crew — and the agent is told to set each subagent's model (they
  // inherit the parent's expensive model otherwise). This is what makes the
  // classification actually SAVE tokens instead of only gating evidence.
  const orchestration = await (async () => {
    try {
      const cfg = await configManager.readConfig(projectPath).catch(() => null)
      const [{ effectiveSddMode }, { effectiveTddMode }] = await Promise.all([
        import('../commands/sdd'),
        import('../commands/tdd'),
      ])
      const { effectiveWeakModelMode } = await import('./weak-model-mode')
      return orchestrationFor(
        harness,
        effectiveSddMode(cfg),
        effectiveTddMode(cfg),
        effectiveWeakModelMode(cfg),
        // Durable cast seed: same description → same adorable subagent names.
        `${description}::${taskId}`
      )
    } catch {
      return orchestrationFor(harness, 'off', 'off', 'off', `${description}::${taskId}`)
    }
  })()

  // Multi-agent: a task in a child worktree lands in activeTasks[] keyed by
  // its workspaceId, so parallel agents don't clobber a shared currentTask.
  // The main worktree keeps the singular currentTask path (transparent for
  // single-agent use, and the backward-compatible mirror for read paths).
  //
  // Attribution: stamp who started so switch/accept can show "who + why".
  const { resolveCallerIdentity } = await import('./agent-identity')
  const owner = resolveCallerIdentity(description)

  // Auto-worktree isolation: foreign occupant on this workspace → sibling tree.
  const isolationOutcome = await (async (): Promise<
    { effectivePath: string; isolation: StartTaskOutcome['isolation'] } | { blocked: string }
  > => {
    const mode = cfg?.multiAgent?.autoWorktree ?? 'auto'
    try {
      const { getOccupancy, shouldIsolate, worktreeSlugFromIntent } = await import(
        './workspace-occupancy'
      )
      const occupancy = await getOccupancy(projectId, projectPath, owner)
      const decision = shouldIsolate(occupancy, mode, description)
      if (decision.block) {
        return { blocked: decision.reason }
      }
      if (decision.isolate && occupancy.isMain) {
        const { worktreeService } = await import('./worktree-service')
        const slug = worktreeSlugFromIntent(description)
        const created = await worktreeService.create(projectPath, slug)
        try {
          await worktreeService.setup(
            created.path,
            await worktreeService.getMainWorktree(projectPath)
          )
        } catch (error) {
          await worktreeService.remove(created.path, true)
          throw error
        }
        const occ = decision.occupant
        return {
          effectivePath: created.path,
          isolation: {
            reason: decision.reason,
            worktreePath: created.path,
            branch: created.branch,
            slug: created.slug,
            occupantSummary: occ
              ? `${[occ.ownerAgent, occ.ownerIdentity].filter(Boolean).join('/') || 'other'} · ${occ.taskId.slice(0, 8)} · "${occ.description.slice(0, 60)}"`
              : 'foreign cycle',
          },
        }
      }
    } catch (err) {
      // Isolation is best-effort when git fails; fall through to normal start
      // unless we were in ask/block mode (already returned). Log-free by design.
      if (err instanceof Error && err.message.includes('already active')) {
        return { blocked: err.message }
      }
    }
    return { effectivePath: projectPath, isolation: undefined }
  })()
  if ('blocked' in isolationOutcome) return { ok: false, blocked: isolationOutcome.blocked }
  const { effectivePath, isolation } = isolationOutcome

  const ws = await deriveWorkspace(effectivePath)
  if (ws.gitError) {
    if (isolation?.worktreePath) {
      const { worktreeService } = await import('./worktree-service')
      try {
        await worktreeService.remove(isolation.worktreePath, true)
      } catch (cleanupError) {
        const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        return {
          ok: false,
          blocked: `git ${ws.gitError}: workspace identity failed and rollback could not remove ${isolation.worktreePath}: ${detail}`,
        }
      }
    }
    // Degraded identity (git timeout/spawn): keying a new task on the main
    // sentinel could bleed a linked worktree's state into main — refuse.
    return {
      ok: false,
      blocked: `git ${ws.gitError}: workspace identity unknown — refusing to start work on the main fallback. Re-run when git is healthy.`,
    }
  }
  const workspaceId = ws.isMain ? MAIN_WORKSPACE_ID : ws.workspaceId
  const taskFields = {
    id: taskId,
    description,
    sessionId: generateUUID(),
    linearId,
    linkedSpecId,
    harness,
    ownerAgent: owner.agent,
    ownerIdentity: owner.identity,
    ownerSessionId: owner.sessionId,
    yieldStatus: 'active' as const,
  }
  if (ws.isMain) {
    await stateStorage.startTask(
      projectId,
      taskFields as Parameters<typeof stateStorage.startTask>[1]
    )
  } else {
    try {
      await stateStorage.startTaskInWorkspace(
        projectId,
        {
          ...taskFields,
          branch: ws.branch ?? isolation?.branch,
          workspaceId: ws.workspaceId,
          worktreePath: ws.worktreePath,
        } as Parameters<typeof stateStorage.startTaskInWorkspace>[1],
        ws.workspaceId
      )
    } catch (error) {
      if (isolation?.worktreePath) {
        const { worktreeService } = await import('./worktree-service')
        try {
          await worktreeService.remove(isolation.worktreePath, true)
        } catch {
          /* rollback is best-effort — surface the registration failure, not the cleanup one */
        }
      }
      throw error
    }
    if (isolation?.worktreePath) {
      const { worktreeService } = await import('./worktree-service')
      try {
        await worktreeService.unlock(isolation.worktreePath)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        isolation.reason += ` Task registration succeeded, but the temporary Git lock is still pending: ${detail}`
      }
    }
  }

  // Quality orchestrator: auto-open judgment ledger when required (never ship).
  try {
    const { ensureJudgmentLedger, intensityFromQuality } = await import('./judgment-orchestrator')
    if (orchestration.quality !== 'none') {
      await ensureJudgmentLedger({
        projectId,
        projectPath,
        signals: {
          harnessLevel: harness.level,
          harnessKind: harness.kind,
        },
        forceIntensity: intensityFromQuality(orchestration.quality),
      })
    }
  } catch {
    /* quality ensure is best-effort — never block work start */
  }

  // Estimation loop (write side): store the triage's size estimate on the
  // typed row; completion compares it against the ACTUAL diff so velocity can
  // learn the dev's estimation bias per classification. Best-effort.
  try {
    const { prjctDb } = await import('../storage/database')
    prjctDb.run(
      projectId,
      'UPDATE tasks SET expected_value = ? WHERE id = ?',
      String(orchestration.expectedPoints),
      taskId
    )
    // Decomposition record (Task Master's complexity report, written by the
    // triage prjct already runs): score + recommended breakdown, consumed by
    // `prjct expand` and later calibrated against real token telemetry.
    const { workGraph } = await import('./work-graph')
    workGraph.recordComplexity(projectId, taskId, {
      score: orchestration.expectedPoints,
      recommendedSubtasks:
        orchestration.expectedPoints >= 5 ? Math.min(orchestration.expectedPoints, 6) : 0,
      reasoning: `Triage: ${harness.level} · ${orchestration.model}/${orchestration.effort} · fan-out ${orchestration.fanout}`,
    })
  } catch {
    /* estimate is advisory telemetry */
  }

  const pipelineDecision = decideTaskPipeline(description, linkedSpecId)
  const pipelineState = upsertTaskPipelineState(projectId, {
    taskId,
    workspaceId,
    classification: pipelineDecision.kind,
    station: pipelineDecision.station,
    requiresSpec: pipelineDecision.requiresSpec,
    requiresTestsFirst: pipelineDecision.requiresTestsFirst,
    reason: pipelineDecision.reason,
    linkedSpecId: linkedSpecId ?? null,
  })

  // Mirror the linkage on the spec side so `prjct spec show <id>` lists the
  // linked task. Best-effort — a missing spec just no-ops.
  if (linkedSpecId) {
    try {
      const { specService } = await import('./spec-service')
      await specService.linkTask(projectPath, linkedSpecId, taskId)
    } catch {
      // ignore — task creation already succeeded
    }
  }

  // QA phase: seed the plan from the linked spec and compute the work-start
  // directive. Best-effort — never blocks a start.
  const qa = await qaWorkOutcome(projectId, projectPath, cfg, {
    taskId,
    workspaceId,
    linkedSpecId: linkedSpecId ?? null,
    harnessLevel: harness.level,
  })

  const author = await projectService.ensureAuthor()
  await memoryService.log(
    projectPath,
    'task_started',
    { task: description, taskId, harness, timestamp: dateHelper.getTimestamp() },
    author.name
  )

  await executeWorkflowRules(projectId, 'task', 'after', {
    projectPath,
    skipRules: options.skipHooks,
  })

  const branch = isolation?.branch ?? (await getGitBranch(effectivePath).catch(() => ''))

  // The superpower: recall what the project already knows about THIS task —
  // past contexts/decisions/traps related to the description — so the agent
  // gets "has this happened before? who? what was decided?" up front, pulled
  // on demand. Reuses the one RAG pipeline (enrichedRecall) so it works over
  // the user's EXISTING memory from day one. Best-effort; never blocks a start.
  // Prefer main projectPath for indexes (worktree shares vault via .prjct).
  const relatedContext = await recallRelatedContext(projectPath, projectId, description)
  // Work scope: memory (vectorial/FTS) + BM25 + import/co-change graph — constrained
  // list BEFORE the agent greps. Full async path includes semantic blend when enabled.
  const likelyFiles = await recallLikelyFiles(projectPath, projectId, description)
  // Predictive risk: concentrate the preventive memory for the area this cycle
  // will touch, so the trap is surfaced at planning, not after it bites.
  const risks = recallRisksForFiles(projectId, likelyFiles)

  // Dynasty D5: cycle budget card ONCE at work start (not every turn).
  const cycleBudget: string | null = await (async () => {
    try {
      const { buildCycleBudgetCard } = await import('./cycle-budget-card')
      const { contextPressureVerdict } = await import('./context-pressure')
      const pressure = contextPressureVerdict(cfg, { turnCount: 0, tokensIn: 0, tokensOut: 0 })
      const card = buildCycleBudgetCard({
        turns: 0,
        turnLimit: cfg?.maxTurnsPerCycle ?? pressure.limit,
        tokensSpent: 0,
        tokenBudget: cfg?.maxTokensPerCycle ?? null,
        pressureLevel: pressure.level,
      })
      console.log(card.line)
      return card.line
    } catch {
      return null
    }
  })()

  return {
    ok: true,
    taskId,
    description,
    branch,
    linearId,
    linkedSpecId,
    harness,
    orchestration,
    privateSkills,
    outputProfile,
    ownerAgent: owner.agent,
    ownerIdentity: owner.identity,
    isolation,
    pipeline: {
      classification: pipelineState.classification,
      station: pipelineState.station,
      nextAction: formatTaskPipelineNextAction(pipelineDecision),
      requiresSpec: pipelineState.requiresSpec,
      requiresTestsFirst: pipelineState.requiresTestsFirst,
    },
    instructions: beforeResult.instructions,
    relatedContext,
    likelyFiles,
    risks,
    cycleBudget,
    qa,
  }
}

async function qaWorkOutcome(
  projectId: string,
  projectPath: string,
  cfg: Awaited<ReturnType<typeof configManager.readConfig>> | null,
  input: {
    taskId: string
    workspaceId: string
    linkedSpecId: string | null
    harnessLevel: TaskHarness['level']
  }
): Promise<QaWorkOutcome | undefined> {
  try {
    const { effectiveQaMode, qaAppliesTo, qaWorkCue } = await import('./qa-gate')
    const mode = effectiveQaMode(cfg)
    if (!qaAppliesTo(input.harnessLevel, mode)) return undefined
    const { getQaPlan, saveSeededPlan, seedQaPlanFromSpec } = await import('./qa-plan')
    const existing = getQaPlan(projectId, input.taskId)
    const seeded = await (async () => {
      if (existing || !input.linkedSpecId) return null
      const { specService } = await import('./spec-service')
      const spec = await specService.get(projectPath, input.linkedSpecId)
      if (!spec) return null
      const plan = seedQaPlanFromSpec(spec, input.taskId, input.workspaceId)
      if (plan.criteria.length === 0 && plan.flows.length === 0) return null
      return saveSeededPlan(projectId, plan)
    })().catch(() => null)
    const plan = existing ?? seeded
    const cue = qaWorkCue({ mode, harnessLevel: input.harnessLevel, plan, seeded: Boolean(seeded) })
    return {
      mode,
      planExists: Boolean(plan),
      seeded: Boolean(seeded),
      criteriaCount: plan?.criteria.length ?? 0,
      flowsCount: plan?.flows.length ?? 0,
      section: cue.section,
      directive: cue.directive,
    }
  } catch {
    return undefined
  }
}

/**
 * `done` gate for the QA phase: strict blocks with the exact unblock, advisory
 * warns through the existing harness-warnings channel. Best-effort.
 */
async function qaDoneGate(
  projectId: string,
  projectPath: string,
  task: { id: string; harness?: TaskHarness }
): Promise<{ blocked: string | null; warning: string | null }> {
  try {
    const cfg = await configManager.readConfig(projectPath).catch(() => null)
    const { effectiveQaMode, qaDoneVerdict } = await import('./qa-gate')
    const mode = effectiveQaMode(cfg)
    if (mode === 'off') return { blocked: null, warning: null }
    const { getQaPlan } = await import('./qa-plan')
    const { readQaReceipt } = await import('./qa-runner')
    const { gitBinding } = await import('./gauntlet')
    const binding = await gitBinding(projectPath)
    const verdict = qaDoneVerdict({
      mode,
      harnessLevel: task.harness?.level,
      plan: getQaPlan(projectId, task.id),
      receipt: readQaReceipt(projectId, task.id)?.data ?? null,
      headSha: binding.headSha,
      nowMs: Date.now(),
    })
    if (verdict.blocked) return { blocked: verdict.message, warning: null }
    return { blocked: null, warning: verdict.message?.startsWith('⚠') ? verdict.message : null }
  } catch {
    return { blocked: null, warning: null }
  }
}

/**
 * Predictive risk briefing: for the cycle's likely files, recall ONLY preventive
 * memory (gotchas, anti-patterns, recurring-bugs) and dedup to a tight set. This
 * is `prjct guard` run automatically over the area the work will touch — risk
 * seen before the edit, not after. Best-effort; never blocks a start.
 */
export function recallRisksForFiles(projectId: string, files: LikelyFileHit[]): RiskHit[] {
  const seen = new Set<string>()
  const risks: RiskHit[] = []
  try {
    const top = files.slice(0, 5)
    const hitsByFile = projectMemory.recallForFiles(
      projectId,
      top.map((f) => f.path),
      2,
      { preventiveOnly: true }
    )
    for (const f of top) {
      for (const h of hitsByFile.get(f.path) ?? []) {
        if (seen.has(h.id)) continue
        seen.add(h.id)
        risks.push({
          id: h.id,
          label: preventiveLabel(h),
          title: deriveMemTitle(h),
          file: f.path,
        })
        if (risks.length >= 4) return risks
      }
    }
  } catch {
    /* best-effort — risk briefing never blocks a start */
  }
  return risks
}

/**
 * Pull likely file targets via unified work-scope (memory vector/FTS + code
 * index + graph). Best-effort; never blocks work start.
 */
async function recallLikelyFiles(
  projectPath: string,
  projectId: string,
  description: string
): Promise<LikelyFileHit[]> {
  try {
    const { resolveWorkScope, toLikelyFileHits } = await import('./work-scope')
    const scope = await resolveWorkScope(projectPath, projectId, description, 8)
    if (scope.files.length > 0) return toLikelyFileHits(scope.files)
    // Fallback pure sync ranker if async path empty
    return rankLikelyFiles(projectId, description)
  } catch {
    try {
      return rankLikelyFiles(projectId, description)
    } catch {
      return []
    }
  }
}

/** Pull the RAG for context related to a task description (best-effort). */
async function recallRelatedContext(
  projectPath: string,
  projectId: string,
  description: string
): Promise<RelatedContextHit[]> {
  try {
    const { enrichedRecall } = await import('../memory/enriched-recall')
    const { deriveTitle } = await import('../memory/format')
    const hits = await enrichedRecall(projectPath, projectId, {
      topic: description,
      types: [
        'decision',
        'gotcha',
        'fact',
        'spec',
        'anti-pattern',
        'pattern',
        'learning',
        'context',
      ],
      limit: 8,
    })
    if (hits.length === 0) return []
    // Learn which surfaced context proves useful (usefulness ledger).
    const { recordSurfacedForActiveTask } = await import('./usefulness/surface-attribution')
    await recordSurfacedForActiveTask(
      projectId,
      projectPath,
      hits.map((h) => h.id)
    )
    return hits.map((h) => {
      const fields = parseLivingContextFields(h.content)
      const files =
        fields.relatedFiles ??
        h.tags?.related_files?.split(',').filter(Boolean) ??
        h.tags?.files?.split(',').filter(Boolean)
      return {
        id: h.id,
        type: h.type,
        title: deriveTitle(h),
        detail: fields.contextSynthesis ?? flatDetail(h.content, 180),
        when: h.rememberedAt,
        author: fields.whoAuthor ?? h.tags?.author,
        keyData: fields.keyData ?? h.tags?.key_data,
        feature: fields.featureDomain ?? h.tags?.feature,
        files,
        why: fields.whyItMattered,
        pattern: fields.pattern,
        antiPattern: fields.antiPattern,
        decisionTrap: fields.decisionTrap,
        outcome: fields.outcome,
        nextImplication: fields.nextImplication,
      }
    })
  } catch {
    return []
  }
}

/**
 * The in-band directive emitted when a task closes: the agent (who just did the
 * work and understands the sentiment) writes the task's CONTEXT — the per-task
 * unit of the project's second-brain RAG. English, structured, not a raw quote.
 */
export const TASK_CONTEXT_PROMPT = buildLivingContextPrompt()

const BUG_RCA_CONTEXT_SUFFIX = [
  '',
  'Bug-cycle RCA receipt — include these compact fields in the same context entry:',
  'Symptom · exact repro command · causal mechanism · discriminating evidence · why prior tests missed it · regression seam/test · prevention.',
  'Use `unknown` for unavailable fields; never copy secrets or raw logs.',
].join('\n')

/** Add a compact, structured RCA receipt only when a bug cycle closes. */
export function taskContextPromptFor(harness?: Pick<TaskHarness, 'kind'> | null): string {
  return harness?.kind === 'bug'
    ? `${TASK_CONTEXT_PROMPT}${BUG_RCA_CONTEXT_SUFFIX}`
    : TASK_CONTEXT_PROMPT
}

export type SetStatusOutcome =
  | {
      ok: true
      taskId: string
      status: string
      verificationWarnings?: string[]
      /** Present when the task just closed (`done`): instruct the agent to
       *  write the task context. */
      contextPrompt?: string
    }
  /** No active task and no paused task to resume — caller emits the guard. */
  | { ok: false; reason: 'no-active-task' }
  /** The transition isn't supported in this context — caller prints `message`. */
  | { ok: false; reason: 'unsupported'; message: string }
  /** A strict gate (QA) refused `done` — `message` names the exact unblock. */
  | { ok: false; reason: 'gate-blocked'; message: string }

/**
 * Change the active task's status. Drives the real workflow state machine so
 * `state.json` and the audit log agree, after recording the transition. The
 * no-arg / paused-display branches are pure presentation and stay in the CLI
 * command; this owns only the write semantics (value always provided).
 * Mirrors the side-effects of `primitives.status` for the value path.
 */
export async function setTaskStatus(
  projectId: string,
  projectPath: string,
  value: string
): Promise<SetStatusOutcome> {
  const normalized = value.toLowerCase()
  const resumeIntent = RESUME_VALUES.includes(normalized)

  // Multi-agent: in a child worktree the status applies to THAT workspace's
  // task in activeTasks[], isolated from other worktrees. The main worktree
  // keeps the singular currentTask path below.
  const ws = await deriveWorkspace(projectPath)
  if (ws.gitError) {
    // Degraded identity — a status write keyed on the main fallback could
    // hit the wrong workspace's task. Refuse with the cause.
    return {
      ok: false,
      reason: 'unsupported',
      message: `git ${ws.gitError}: workspace identity unknown — refusing to change task status on the main fallback. Re-run when git is healthy.`,
    }
  }
  if (!ws.isMain) {
    const wsTask = await stateStorage.getCurrentTaskForWorkspace(projectId, ws.workspaceId)
    if (!wsTask) return { ok: false, reason: 'no-active-task' }

    // `done` removes the task from this workspace (-> idle for this worktree),
    // leaving every other workspace's task untouched.
    if (normalized === 'done' || normalized === 'completed') {
      const lastStatus = await readLastStatus(projectId, wsTask.id)
      const verification = await evaluateHarnessCompletion(projectPath, wsTask)
      const qaGate = await qaDoneGate(projectId, projectPath, wsTask)
      if (qaGate.blocked) return { ok: false, reason: 'gate-blocked', message: qaGate.blocked }
      if (qaGate.warning) verification.warnings.push(qaGate.warning)
      if (wsTask.worktreePath) {
        try {
          const { worktreeService } = await import('./worktree-service')
          await worktreeService.unlock(wsTask.worktreePath)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return {
            ok: false,
            reason: 'gate-blocked',
            message: `Cannot complete this cycle until its worktree lock is released: ${detail}`,
          }
        }
      }
      await memoryService.log(projectPath, STATUS_CHANGE_ACTION, {
        taskId: wsTask.id,
        from: lastStatus ?? null,
        to: value,
        workspaceId: ws.workspaceId,
        harnessWarnings: verification.warnings,
      })
      await stateStorage.completeTaskInWorkspace(projectId, ws.workspaceId)
      await recordEstimationOutcome(projectId, wsTask.id, verification.diffSize)
      try {
        const { usefulnessService } = await import('./usefulness')
        usefulnessService.creditShippedTask(projectId, wsTask.id)
      } catch {
        /* best-effort usefulness credit */
      }
      // Phase 3: incremental retention cleanup on task done (capped, best-effort).
      try {
        const { applyRetentionIncremental } = await import('./retention')
        applyRetentionIncremental(projectId)
      } catch {
        /* never block done on cleanup */
      }
      return {
        ok: true,
        taskId: wsTask.id,
        status: value,
        verificationWarnings: verification.warnings,
        contextPrompt: taskContextPromptFor(wsTask.harness),
      }
    }

    // Pause/resume PER worktree needs a per-workspace paused store (planned
    // follow-up). Returning an explicit `unsupported` — rather than a false
    // success that mutates nothing — avoids leaving the worktree task wedged
    // in `working` (which would then block the next `prjct work` here).
    return {
      ok: false,
      reason: 'unsupported',
      message: `'${value}' isn't supported for a worktree task yet — only 'done'. (pause/resume per-worktree is a planned follow-up)`,
    }
  }

  // Resume-intent bypasses the active-task guard: when the current task is
  // paused, there's no `currentTask` — promote a paused one first.
  if (resumeIntent) {
    const current = await stateStorage.getCurrentTask(projectId)
    if (!current) {
      const resumed = await stateStorage.resumeTask(projectId)
      if (resumed) {
        await memoryService.log(projectPath, STATUS_CHANGE_ACTION, {
          taskId: resumed.id,
          from: 'paused',
          to: value,
        })
        return { ok: true, taskId: resumed.id, status: value }
      }
    }
  }

  const active = await stateStorage.getCurrentTask(projectId)
  if (!active) return { ok: false, reason: 'no-active-task' }

  const lastStatus = await readLastStatus(projectId, active.id)
  const verification =
    normalized === 'done' || normalized === 'completed'
      ? await evaluateHarnessCompletion(projectPath, active)
      : { warnings: [] as string[], diffSize: 0 }

  // Done without a machine-green HEAD is narrated success, not verified
  // success — surface it through the existing warnings channel (non-blocking).
  if (normalized === 'done' || normalized === 'completed') {
    try {
      const { gauntletDoneWarning } = await import('./gauntlet')
      const warning = await gauntletDoneWarning(projectPath, projectId)
      if (warning) verification.warnings.push(warning)
    } catch {
      /* advisory only */
    }
    const qaGate = await qaDoneGate(projectId, projectPath, active)
    if (qaGate.blocked) return { ok: false, reason: 'gate-blocked', message: qaGate.blocked }
    if (qaGate.warning) verification.warnings.push(qaGate.warning)
  }

  await memoryService.log(projectPath, STATUS_CHANGE_ACTION, {
    taskId: active.id,
    from: lastStatus ?? null,
    to: value,
    harnessWarnings: verification.warnings,
  })

  // Drive the real workflow state machine so state.json and the audit log
  // agree. Without this, `status paused` flips the audit trail but leaves
  // state.currentTask.status='in_progress', which later blocks `prjct work`
  // with a bogus "cannot transition from working".
  try {
    if (normalized === 'done' || normalized === 'completed') {
      await stateStorage.completeTask(projectId)
      await recordEstimationOutcome(projectId, active.id, verification.diffSize)
      try {
        const { usefulnessService } = await import('./usefulness')
        usefulnessService.creditShippedTask(projectId, active.id)
      } catch {
        /* best-effort usefulness credit */
      }
      // Phase 3: incremental retention cleanup on task done (capped, best-effort).
      try {
        const { applyRetentionIncremental } = await import('./retention')
        applyRetentionIncremental(projectId)
      } catch {
        /* never block done on cleanup */
      }
    } else if (normalized === 'paused' || normalized === 'pause') {
      await stateStorage.pauseTask(projectId)
    } else if (resumeIntent) {
      // Only resume if there's no active task; otherwise it's a no-op.
      const current = await stateStorage.getCurrentTask(projectId)
      if (!current) await stateStorage.resumeTask(projectId)
    }
  } catch {
    // State machine rejected a redundant transition (e.g. `done` on an
    // already-completed task). The audit log still captures intent.
  }

  return {
    ok: true,
    taskId: active.id,
    status: value,
    verificationWarnings: verification.warnings,
    contextPrompt:
      normalized === 'done' || normalized === 'completed'
        ? taskContextPromptFor(active.harness)
        : undefined,
  }
}

/**
 * Resolve the active task for the CALLER's worktree — the main worktree's
 * singular currentTask, or the child worktree's slot in activeTasks[]. Returns
 * the full task (incl. linkedSpecId) so callers like `prjct ship` can read its
 * spec linkage and description. Null when this workspace has no active task.
 */
export async function resolveActiveTask(
  projectId: string,
  projectPath: string
): Promise<CurrentTask | null> {
  const ws = await deriveWorkspace(projectPath)
  // Degraded identity: returning main's task could bleed another worktree's
  // operations into main's cycle — "no active task" is the safe answer.
  if (ws.gitError) return null
  if (ws.isMain) return stateStorage.getCurrentTask(projectId)
  return stateStorage.getCurrentTaskForWorkspace(projectId, ws.workspaceId)
}

/**
 * Complete the active task for the CALLER's worktree, routing to the singular
 * (main) or per-workspace (child) completion so ship/done isolate correctly.
 * Returns the completed task, or null when nothing was active.
 */
/**
 * Estimation loop (close side): fold expected vs ACTUAL size into the
 * completed task's cold data. Runs AFTER the state-storage completion (whose
 * history mirror rewrites `data`), so json_set survives. Best-effort.
 */
async function recordEstimationOutcome(
  projectId: string,
  taskId: string,
  diffSize: number
): Promise<void> {
  try {
    const { prjctDb } = await import('../storage/database')
    const { pointsFromDiffLines } = await import('./task-orchestration')
    const row = prjctDb.get<{ expected_value: string | null }>(
      projectId,
      'SELECT expected_value FROM tasks WHERE id = ?',
      taskId
    )
    const expected = Number(row?.expected_value)
    if (!Number.isFinite(expected) || expected <= 0) return
    prjctDb.run(
      projectId,
      `UPDATE tasks SET data = json_set(COALESCE(data, '{}'),
         '$.expectedPoints', ?, '$.actualPoints', ?, '$.diffLines', ?)
       WHERE id = ?`,
      expected,
      pointsFromDiffLines(diffSize),
      diffSize,
      taskId
    )
  } catch {
    /* estimation telemetry only */
  }
}

export async function completeActiveTask(
  projectId: string,
  projectPath: string,
  feedback?: TaskFeedback
): Promise<CurrentTask | null> {
  const ws = await deriveWorkspace(projectPath)
  // Degraded identity: never complete MAIN's task from what might be a
  // linked worktree with a sick git.
  if (ws.gitError) return null
  if (ws.isMain) return stateStorage.completeTask(projectId, feedback)
  return stateStorage.completeTaskInWorkspace(projectId, ws.workspaceId, feedback)
}

/**
 * Read the most recent status transition for a task out of the memory event
 * log. Events outlive the task column (which only holds `type`) so we can
 * surface a real status without a schema change. Shared by the CLI's no-arg
 * status display and the status write path.
 */
export async function readLastStatus(projectId: string, taskId: string): Promise<string | null> {
  try {
    const { default: prjctDb } = await import('../storage/database')
    type Row = { data: string }
    const rows = prjctDb.query<Row>(
      projectId,
      'SELECT data FROM events WHERE type = ? ORDER BY id DESC LIMIT 10',
      `memory.${STATUS_CHANGE_ACTION}`
    )
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.data) as { taskId?: string; to?: string }
        if (parsed.taskId === taskId && parsed.to) return parsed.to
      } catch {
        // ignore malformed row
      }
    }
  } catch {
    // non-critical
  }
  return null
}
