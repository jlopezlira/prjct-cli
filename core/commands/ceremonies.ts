/**
 * Tier-2 ceremonies (harness research: BMAD + Task Master + beads):
 *
 *   prjct log "<note>" [--task id]   append-only implementation journal —
 *                                    "what did the last agent try", the
 *                                    cheapest session-to-session continuity
 *   prjct brief [id] [--md]          COMPILED context artifact for a task:
 *                                    orchestration + journal + guards +
 *                                    related memory + sibling ships. BMAD
 *                                    compiles context; prjct compiles it
 *                                    from a database instead of files.
 *   prjct replan "<what changed>"    cascading drift repair: re-plan
 *                                    directive over downstream open items +
 *                                    automatic decision memory of the pivot
 *   prjct plan …                     plan-mode ceremony (read-only until
 *                                    approve) — Grok-style gate before edits
 *   prjct prime [--md]               session-open bundle: cycle + frontier +
 *                                    traps + budget in one pull
 *   prjct land [--md]                session-close checklist ("land the
 *                                    plane"): what is uncaptured, unclaimed,
 *                                    unfinished — BEFORE the context dies
 */

import { deriveTitle } from '../memory/format'
import { projectMemory } from '../memory/project-memory'
import { resolveCallerIdentity } from '../services/agent-identity'
import { extractDeveloperRules } from '../services/developer-profile'
import { gateDelivery } from '../services/session-context-cache'
import { buildTaskHarness } from '../services/task-harness'
import { orchestrationFor } from '../services/task-orchestration'
import { collectActiveTasks } from '../services/task-overview'
import { recordCliDeliveryChars } from '../services/work-cost-service'
import { workGraph } from '../services/work-graph'
import { prjctDb } from '../storage/database'
import { planStorage, type WorkPlan } from '../storage/plan-storage'
import { queueStorage } from '../storage/queue-storage'
import type { CommandResult } from '../types/commands'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'
import { requireProject } from './guards'

/** Cold-start apply-loop: enough rules for a fresh window to act as the dev. */
const PRIME_DEV_RULES = 4
const PRIME_TRAPS = 3

interface CeremonyOptions {
  md?: boolean
  task?: string
  force?: boolean
  dryRun?: boolean
  minHours?: number
  minSessions?: number
  /** Bypass session-scoped delivery trimming (re-emit everything). */
  full?: boolean
}

export class CeremonyCommands extends PrjctCommandsBase {
  /** Append a journal entry to the active (or named) work cycle. */
  async log(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: CeremonyOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const content = (input ?? '').trim()
    if (!content)
      return this.fail('Usage: prjct log "<what you tried / found>" [--task id]', options)
    const taskId =
      options.task ??
      (await collectActiveTasks(proj.value, projectPath).catch(() => null))?.current?.id
    if (!taskId) return this.fail('No active work cycle — pass --task <id>', options)
    prjctDb.run(
      proj.value,
      'INSERT INTO task_log (task_id, session_id, content, created_at) VALUES (?, ?, ?, ?)',
      taskId,
      // Wire/env-resolved caller session — a raw env read here returned the
      // DAEMON's frozen env on the warm path, stamping the wrong session.
      resolveCallerIdentity('log').sessionId ?? null,
      content,
      new Date().toISOString()
    )
    const msg = `logged to ${taskId.slice(0, 8)}: ${content.slice(0, 70)}`
    if (options.md) console.log(`✓ ${msg}`)
    else out.done(msg)
    return { success: true, taskId }
  }

  /** Compile (and persist) the context brief for a task. */
  async brief(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: CeremonyOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const inputTaskId = (input ?? '').trim() || undefined
    const activeTask = !inputTaskId
      ? (await collectActiveTasks(proj.value, projectPath).catch(() => null))?.current
      : undefined
    const taskId = inputTaskId ?? activeTask?.id
    if (!taskId) return this.fail('No active work cycle — pass a task id', options)
    const description =
      activeTask?.description ??
      (await queueStorage.getTasks(proj.value)).find((task) => task.id === taskId)?.description ??
      prjctDb.get<{ description: string }>(
        proj.value,
        'SELECT description FROM tasks WHERE id = ?',
        taskId
      )?.description ??
      taskId

    const sections: string[] = [`# Brief — ${description}`, '']

    // 1. Orchestration directive (how to run THIS task).
    const harness = buildTaskHarness(description)
    const plan = orchestrationFor(harness)
    sections.push(
      `**Orchestration:** ${plan.model}/${plan.effort} · spec: ${plan.spec} · tests: ${plan.tests} · fan-out: ${plan.fanout} · ~${plan.expectedPoints} pt`,
      ''
    )

    // 2. Journal — what previous sessions tried (last 8 entries).
    const journal = prjctDb.query<{ content: string; created_at: string }>(
      proj.value,
      'SELECT content, created_at FROM task_log WHERE task_id = ? ORDER BY id DESC LIMIT 8',
      taskId
    )
    if (journal.length > 0) {
      sections.push('## Journal (previous attempts)', '')
      for (const j of journal.reverse()) {
        sections.push(`- ${j.created_at.slice(5, 16)} — ${j.content}`)
      }
      sections.push('')
    }

    // 3. Related memory — decisions/gotchas ranked against the description.
    try {
      const keywords = description
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 6)
      const hits = projectMemory.searchFts(proj.value, keywords, 5)
      if (hits.length > 0) {
        sections.push('## Related memory', '')
        for (const h of hits) sections.push(`- [${h.id} · ${h.type}] ${h.content.slice(0, 140)}`)
        sections.push('')
      }
    } catch {
      /* FTS unavailable → brief still useful */
    }

    // 4. Sibling context (BMAD's epic-rolling-context): recently shipped
    // work — conventions the codebase just adopted.
    const siblings = prjctDb.query<{ description: string }>(
      proj.value,
      `SELECT description FROM tasks WHERE status IN ('completed','shipped') AND id != ?
       ORDER BY COALESCE(completed_at, shipped_at) DESC LIMIT 3`,
      taskId
    )
    if (siblings.length > 0) {
      sections.push('## Recently landed (follow their conventions)', '')
      for (const s of siblings) sections.push(`- ${s.description.slice(0, 110)}`)
      sections.push('')
    }

    // 5. Graph position.
    const deps = workGraph.dependenciesOf(proj.value, taskId)
    if (deps.length > 0) {
      sections.push('## Graph position', '')
      for (const d of deps) {
        sections.push(`- \`${d.fromId.slice(0, 8)}\` —${d.depType}→ \`${d.toId.slice(0, 8)}\``)
      }
      sections.push('')
    }

    sections.push('_Compiled brief — regenerate with `prjct brief` after major drift._')
    const content = sections.join('\n')

    prjctDb.run(
      proj.value,
      `INSERT INTO task_briefs (task_id, content, created_at) VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET content = excluded.content, created_at = excluded.created_at`,
      taskId,
      content,
      new Date().toISOString()
    )

    console.log(content)
    return { success: true, taskId, bytes: content.length }
  }

  /** Cascading drift repair + automatic decision capture. */
  async replan(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: CeremonyOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const change = (input ?? '').trim()
    if (!change) return this.fail('Usage: prjct replan "<what actually changed>"', options)

    // The pivot is a decision the project must remember — captured BEFORE
    // the re-planning, so it survives even if the session dies mid-replan.
    await projectMemory.remember(projectPath, {
      type: 'decision',
      content: `Replan: ${change}`,
      tags: { topic: 'replan' },
      provenance: 'declared',
    })

    const ready = workGraph.ready(proj.value, { limit: 15 })
    const lines = [
      '# Replan directive',
      '',
      `**What changed:** ${change}`,
      '',
      'Re-evaluate each open item below against the change. For each one: still valid → leave;',
      'obsolete → complete or remove it; needs rewording → update via `prjct sync` flow;',
      'new work implied → `prjct capture "<item>" --fromCurrent`.',
      '',
    ]
    for (const i of ready) lines.push(`- \`${i.id.slice(0, 8)}\` ${i.description.slice(0, 100)}`)
    lines.push('', '_The pivot was already captured as a decision memory._')
    console.log(lines.join('\n'))
    return { success: true, items: ready.length }
  }

  /**
   * Plan-mode ceremony (Grok Build pattern, harness-layer):
   *
   *   prjct plan ["title"]           start draft (or show active) + host contract
   *   prjct plan show                print active plan
   *   prjct plan write "<markdown>"  update draft body only
   *   prjct plan approve             exit plan mode; persist decision memory
   *   prjct plan clear|abandon       drop / abandon plan
   *
   * While status=draft the host must treat source as read-only; only this verb
   * mutates the plan artifact in SQLite (not a free-form plan.md on disk).
   */
  async plan(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: CeremonyOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result

    const raw = (input ?? '').trim()
    const parts = raw.split(/\s+/).filter(Boolean)
    const sub = (parts[0] ?? '').toLowerCase()
    const rest = parts.slice(1).join(' ').trim()

    if (!sub || sub === 'show' || sub === 'status') {
      return this.planShowOrStart(proj.value, projectPath, raw, options)
    }
    if (sub === 'write' || sub === 'set') {
      return this.planWrite(proj.value, rest || null, options)
    }
    if (sub === 'approve' || sub === 'ok') {
      return this.planApprove(proj.value, projectPath, options)
    }
    if (sub === 'clear' || sub === 'abandon' || sub === 'quit') {
      return this.planClear(proj.value, sub === 'clear', options)
    }
    // Bare title after first word that isn't a known sub — treat full input as start title
    if (['start', 'new', 'enter'].includes(sub)) {
      return this.planStart(proj.value, projectPath, rest || 'Untitled plan', options)
    }
    // `prjct plan "Add auth"` — title is the whole input
    return this.planStart(proj.value, projectPath, raw, options)
  }

  private async planShowOrStart(
    projectId: string,
    projectPath: string,
    titleOrEmpty: string,
    options: CeremonyOptions
  ): Promise<CommandResult> {
    const existing = planStorage.get(projectId)
    if (existing) {
      this.printPlan(existing, options)
      return { success: true, status: existing.status, title: existing.title }
    }
    if (!titleOrEmpty || ['show', 'status'].includes(titleOrEmpty.toLowerCase())) {
      return this.fail(
        'No active plan. Start one: `prjct plan "<title>"` then fill sections; approve with `prjct plan approve`.',
        options
      )
    }
    return this.planStart(projectId, projectPath, titleOrEmpty, options)
  }

  private async planStart(
    projectId: string,
    projectPath: string,
    title: string,
    options: CeremonyOptions
  ): Promise<CommandResult> {
    const existing = planStorage.get(projectId)
    if (existing?.status === 'draft') {
      this.printPlan(existing, options)
      return {
        success: true,
        status: existing.status,
        title: existing.title,
        message: 'draft already active',
      }
    }

    const taskId = await collectActiveTasks(projectId, projectPath)
      .then((overview) => overview?.current?.id ?? null)
      .catch(() => null)

    const plan = planStorage.start(projectId, title, taskId)
    this.printPlan(plan, options)
    return { success: true, status: plan.status, title: plan.title, created: true }
  }

  private planWrite(
    projectId: string,
    content: string | null,
    options: CeremonyOptions
  ): CommandResult {
    if (!content) {
      return this.fail(
        'Usage: prjct plan write "<markdown plan body>" — only allowed while status is draft.',
        options
      )
    }
    const updated = planStorage.writeContent(projectId, content)
    if (!updated) {
      return this.fail(
        'No draft plan to update. Start with `prjct plan "<title>"` or approve/clear the current plan.',
        options
      )
    }
    this.printPlan(updated, options)
    return { success: true, status: updated.status, title: updated.title, written: true }
  }

  private async planApprove(
    projectId: string,
    projectPath: string,
    options: CeremonyOptions
  ): Promise<CommandResult> {
    const approved = planStorage.approve(projectId)
    if (!approved) {
      return this.fail(
        'No draft plan to approve. Start with `prjct plan "<title>"` and fill the sections first.',
        options
      )
    }
    await projectMemory.remember(projectPath, {
      type: 'decision',
      content: `Plan approved: ${approved.title}\n\n${approved.content.slice(0, 2000)}`,
      tags: { topic: 'plan-mode', status: 'approved' },
      provenance: 'declared',
    })
    this.printPlan(approved, options)
    if (options.md) {
      console.log('\n> Plan approved. Source edits are allowed. Implement against the plan.')
    } else {
      out.done('Plan approved — implement against the plan')
    }
    return { success: true, status: approved.status, title: approved.title, approved: true }
  }

  private planClear(
    projectId: string,
    hardClear: boolean,
    options: CeremonyOptions
  ): CommandResult {
    const cur = planStorage.get(projectId)
    if (!cur) return this.fail('No active plan to clear.', options)
    if (hardClear) planStorage.clear(projectId)
    else planStorage.abandon(projectId)
    const msg = hardClear ? 'Plan cleared from SQLite.' : `Plan abandoned (${cur.title}).`
    if (options.md) console.log(`> ${msg}`)
    else out.done(msg)
    return { success: true, cleared: hardClear, abandoned: !hardClear }
  }

  private printPlan(plan: WorkPlan, options: CeremonyOptions): void {
    const hostContract =
      plan.status === 'draft'
        ? [
            '## Host contract (draft — read-only)',
            '',
            '- Do **not** edit project source files until `prjct plan approve`.',
            '- Only mutate the plan via `prjct plan write "<markdown>"`.',
            '- Fill: Context · Recommended approach · Critical files · Reuse · Verification.',
            '- When ready, ask the user; then `prjct plan approve --md`.',
            '',
          ]
        : plan.status === 'approved'
          ? [
              '## Host contract (approved)',
              '',
              '- Source edits allowed. Implement against this plan.',
              '- Persist decisions/learnings with `prjct remember`.',
              '',
            ]
          : ['## Host contract (abandoned)', '']

    const lines = [
      `# Plan — ${plan.status}`,
      '',
      `**Title:** ${plan.title}`,
      `**Updated:** ${plan.updatedAt}`,
      plan.taskId ? `**Work cycle:** \`${plan.taskId.slice(0, 8)}\`` : null,
      '',
      ...hostContract,
      '## Plan body',
      '',
      plan.content.trimEnd(),
      '',
    ].filter((x): x is string => x !== null)

    console.log(lines.join('\n'))
    if (!options.md && plan.status === 'draft') {
      out.info('Plan mode: draft — no source edits until approve')
    }
  }

  /**
   * Session-open bundle: managed-session resume + developer grounding.
   *
   * Brutal bar vs fresh-context harnesses (e.g. GSD): a new window with
   * `prjct prime` must already *be* this developer on this project — last land
   * stamp, session-close hand-off, cycle + frontier + standing rules + traps.
   * Deeper recall stays on demand so tokens stay lean.
   */
  async prime(
    _input: string | null = null,
    projectPath: string = process.cwd(),
    options: CeremonyOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const overview = await collectActiveTasks(proj.value, projectPath).catch(() => null)

    // Managed session resume card (land → prime continuity).
    const journal = overview?.current
      ? prjctDb
          .query<{ content: string }>(
            proj.value,
            'SELECT content FROM task_log WHERE task_id = ? ORDER BY id DESC LIMIT 3',
            overview.current.id
          )
          .map((entry) => entry.content)
          .reverse()
      : []
    const { loadSessionContinuity, loadLastSessionCloseContent, formatSessionResumeCard } =
      await import('../services/session-continuity')
    const stamp = loadSessionContinuity(proj.value)
    const sessionClose = loadLastSessionCloseContent(proj.value)
    const pendingHandoffCue = await import('../services/agent-switch')
      .then(({ formatPendingHandoffCue }) => formatPendingHandoffCue(proj.value))
      .catch(() => null)
    const lines: string[] = [
      formatSessionResumeCard({
        stamp,
        liveCycleDescription: overview?.current?.description ?? null,
        liveCycleId: overview?.current?.id ?? null,
        journal,
        sessionCloseContent: sessionClose,
        pendingHandoffCue,
      }),
      '',
    ]

    const ready = workGraph.ready(proj.value, { limit: 5 })
    if (ready.length > 0) {
      lines.push('**Ready frontier:**')
      for (const i of ready) lines.push(`- \`${i.id.slice(0, 8)}\` ${i.description.slice(0, 90)}`)
      lines.push('')
    }

    // Apply-loop: push developer model + traps into every fresh window.
    try {
      const pool = projectMemory.recall(proj.value, {
        types: ['feedback', 'improvement-signal'],
        limit: 40,
        dedupeByKey: false,
      })
      const rules = extractDeveloperRules(pool, PRIME_DEV_RULES)
      if (rules.length > 0) {
        lines.push('**Act as this developer:**')
        for (const r of rules) {
          const tag = r.kind === 'preference' ? 'said' : 'showed'
          lines.push(`- ${r.rule.slice(0, 140)} _(${tag})_`)
        }
        lines.push('')
      }
    } catch {
      // Best-effort — prime never fails for missing memory.
    }
    try {
      const traps = projectMemory.recall(proj.value, {
        types: ['gotcha', 'anti-pattern'],
        limit: PRIME_TRAPS,
      })
      if (traps.length > 0) {
        lines.push('**Top traps (do not re-pay):**')
        for (const t of traps) {
          lines.push(`- ${deriveTitle(t).slice(0, 100)} \`${t.id}\``)
        }
        lines.push('')
      }
    } catch {
      // ignore
    }

    // Token economics (daily product score) + weak-model mode banner.
    try {
      const { default: configManager } = await import('../infrastructure/config-manager')
      const cfg = await configManager.readConfig(projectPath)
      const { buildTokenEconomics } = await import('../services/token-economics')
      const cycle = overview?.current
      const econ = buildTokenEconomics(proj.value, {
        cycleTokensIn:
          cycle && 'tokensIn' in cycle ? (cycle as { tokensIn?: number }).tokensIn : undefined,
        cycleTokensOut:
          cycle && 'tokensOut' in cycle ? (cycle as { tokensOut?: number }).tokensOut : undefined,
        maxTokensPerCycle: cfg?.maxTokensPerCycle ?? null,
      })
      lines.push(`**${econ.line}**`)
      const { effectiveWeakModelMode, weakModelOneLiner } = await import(
        '../services/weak-model-mode'
      )
      if (effectiveWeakModelMode(cfg) === 'on') {
        lines.push(`**${weakModelOneLiner()}**`)
      }
    } catch {
      /* best-effort */
    }

    // Session-scoped trimming: prime is BY DESIGN once-per-fresh-window —
    // a repeat within the SAME session collapses to a pointer. Without
    // session identity the window is unknowable → never suppress.
    const output = lines.join('\n').trimEnd()
    const caller = resolveCallerIdentity('prime')
    const gate = caller.sessionId
      ? await gateDelivery({
          projectId: proj.value,
          projectPath,
          sessionId: caller.sessionId,
          surface: 'cli-prime',
          content: output,
          full: Boolean(options.full),
          onRepeat: (hash) =>
            `Prime already delivered this session (hash ${hash.slice(0, 8)}) — state unchanged.\nRe-emit: \`prjct prime --full\`.`,
        })
      : null
    const printed = gate?.suppressed ? (gate.emit ?? output) : output
    console.log(`${printed}\n`)
    recordCliDeliveryChars(proj.value, overview?.current?.id, printed.length, caller.agent, 'prime')
    const { isContinuityFresh } = await import('../services/session-continuity')
    return {
      success: true,
      continuity: stamp
        ? {
            landedAt: stamp.landedAt,
            cycleId: stamp.cycleId,
            fresh: isContinuityFresh(stamp),
          }
        : null,
    }
  }

  /** Session-close checklist — land the plane before the context dies. */
  async land(
    _input: string | null = null,
    projectPath: string = process.cwd(),
    options: CeremonyOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const lines = ['# Land the plane', '']
    const todo: string[] = []
    const overview = await collectActiveTasks(proj.value, projectPath).catch(() => null)

    // Auto-synthesis: write the hand-off NOW so the agent never has to
    // remember to `prjct remember context "Session close: …"`.
    const { synthesizeLandHandoff } = await import('../services/land-synthesis')
    const handoff = await synthesizeLandHandoff({
      projectId: proj.value,
      projectPath,
      cycleDescription: overview?.current?.description ?? null,
      cycleId: overview?.current?.id ?? null,
    }).catch(() => null)

    // Closed-loop Judgment Receipt (continuity proof — not bulk memory).
    const { synthesizeJudgmentReceipt } = await import('../services/judgment-receipt')
    const receipt = await synthesizeJudgmentReceipt({
      projectId: proj.value,
      projectPath,
      cycleDescription: overview?.current?.description ?? null,
      cycleId: overview?.current?.id ?? null,
    }).catch(() => null)

    // Managed session stamp — next `prjct prime` restores this SoT.
    const continuityStamp = await (async () => {
      try {
        const { default: configManager } = await import('../infrastructure/config-manager')
        const cfg = await configManager.readConfig(projectPath).catch(() => null)
        const { stateStorage } = await import('../storage/state-storage')
        const task = overview?.current
          ? await stateStorage.getCurrentTask(proj.value).catch(() => null)
          : null
        const { stampSessionContinuity } = await import('../services/session-continuity')
        return stampSessionContinuity({
          projectId: proj.value,
          projectPath,
          config: cfg,
          cycleId: overview?.current?.id ?? null,
          cycleDescription: overview?.current?.description ?? null,
          turns: task?.turnCount ?? null,
          tokensIn: task?.tokensIn ?? null,
          tokensOut: task?.tokensOut ?? null,
          handoffWrote: handoff?.wrote ?? false,
          receiptWrote: receipt?.wrote ?? false,
          handoffContent: handoff?.content ?? null,
        })
      } catch {
        return null
      }
    })()

    if (overview?.current) {
      todo.push(
        `Active cycle still open: "${overview.current.description.slice(0, 70)}" — finish it (\`prjct status done\`) or journal the state (\`prjct log "..."\`).`
      )
    }
    const claimed = prjctDb.query<{ id: string; description: string }>(
      proj.value,
      'SELECT id, description FROM queue_tasks WHERE completed = 0 AND claimed_by IS NOT NULL LIMIT 5'
    )
    for (const c of claimed) {
      todo.push(
        `Claimed but open: \`${c.id.slice(0, 8)}\` ${c.description.slice(0, 60)} — release or finish.`
      )
    }
    const pendingSync = prjctDb.get<{ c: number }>(
      proj.value,
      'SELECT COUNT(*) AS c FROM sync_pending'
    )
    if ((pendingSync?.c ?? 0) > 0) todo.push(`${pendingSync?.c} event(s) pending cloud sync.`)

    if (handoff?.wrote) {
      lines.push(
        '- [x] Hand-off auto-synthesized (`context` · topic:`session-close` · source:`land-auto`). No `remember` required.',
        ''
      )
    } else if (handoff?.reason === 'nothing-to-land') {
      lines.push(
        '- [x] Nothing durable to hand off (no cycle / journal / commits / auto-captures).',
        ''
      )
    } else {
      todo.push(
        'Persist the hand-off: `prjct remember context "Session close: what changed, why, next" --tags topic:<key>`.'
      )
    }
    if (receipt?.wrote && receipt.summary) {
      lines.push(`- [x] ${receipt.summary} (tags: source:land-receipt · capture:receipt-v1).`, '')
    }

    // Dynasty D5: Rho dry-run — show memory mass Δ so vault never grows silently.
    const rhoLine = await (async (): Promise<string | null> => {
      try {
        const { runLandRhoDryRun } = await import('../services/land-rho')
        const rho = runLandRhoDryRun(proj.value)
        if (!rho) return null
        if (options.md) lines.push(rho.md)
        else lines.push(`- [x] ${rho.line}`, '')
        return rho.line
      } catch {
        return null
      }
    })()

    // Claude Code steal: auto-dream when time+session gates open (bumps session
    // counter always). Best-effort — never block land.
    const dreamLine = await (async (): Promise<string | null> => {
      try {
        const { maybeDreamOnLand } = await import('../services/memory-dream')
        const dream = maybeDreamOnLand(proj.value)
        if (!dream) return null
        if (options.md) lines.push(dream.md)
        else if (dream.ran || !dream.skipped) lines.push(`- [x] ${dream.line}`, '')
        return dream.line
      } catch {
        return null
      }
    })()

    // Always refresh L0 index on land when dream did not rebuild it.
    try {
      if (!dreamLine || !dreamLine.startsWith('Dream complete')) {
        const { buildAndStoreMemoryL0Index } = await import('../services/memory-index')
        buildAndStoreMemoryL0Index({ projectId: proj.value, source: 'land' })
      }
    } catch {
      /* best-effort */
    }

    // Remove only clean, inactive worktrees created below <main>/.worktrees
    // whose commits are already contained in the main worktree's HEAD.
    try {
      const [{ stateStorage }, { worktreeService }] = await Promise.all([
        import('../storage/state-storage'),
        import('../services/worktree-service'),
      ])
      const removedWorktrees = await worktreeService.clean(projectPath, {
        isProtected: async (worktreePath) => {
          const snapshot = await stateStorage.getTaskSnapshot(proj.value)
          return snapshot.activeTasks.some((task) => task.worktreePath === worktreePath)
        },
      })
      if (removedWorktrees.length > 0) {
        lines.push(`- [x] Removed stale managed worktrees: ${removedWorktrees.join(', ')}.`, '')
      }
    } catch {
      /* best-effort; any uncertainty preserves the worktree */
    }

    todo.push(
      'Team share (optional): `prjct memory export` → commit `.prjct/memory-export/` → clone → `prjct memory import`.'
    )
    todo.push('Next window: `prjct prime --md` (managed session resume — not a blank chat).')
    lines.push(...todo.map((t) => `- [ ] ${t}`))

    if (continuityStamp) {
      const { formatLandContinuityFooter } = await import('../services/session-continuity')
      lines.push(formatLandContinuityFooter(continuityStamp))
    }

    console.log(lines.join('\n'))
    return {
      success: true,
      items: todo.length + (handoff?.wrote ? 1 : 0) + (receipt?.wrote ? 1 : 0),
      dream: dreamLine,
      handoff: handoff?.wrote ?? false,
      receipt: receipt?.wrote ?? false,
      receiptSummary: receipt?.summary ?? null,
      rhoDryRun: rhoLine,
      continuity: continuityStamp
        ? { landedAt: continuityStamp.landedAt, key: 'session:continuity' }
        : null,
    }
  }

  /**
   * Memory auto-dream — Claude Code KAIROS consolidation for prjct.
   * Gates: time (default 24h) + sessions (default 5 lands). Force with --force.
   * Dry-run with --dry-run. Rebuilds L0 memory index on success.
   */
  async dream(
    _input: string | null = null,
    projectPath: string = process.cwd(),
    options: CeremonyOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result

    const { runMemoryDream } = await import('../services/memory-dream')
    const report = runMemoryDream({
      projectId: proj.value,
      projectPath,
      force: options.force === true,
      dryRun: options.dryRun === true,
      minHours: options.minHours,
      minSessions: options.minSessions,
    })

    if (options.md) {
      console.log(report.md)
      if (report.index?.markdown && report.ran) {
        console.log(report.index.markdown)
      }
    } else if (report.skipped) {
      out.info(report.line)
      out.info('Use `prjct dream --force` to run now, or `--dry-run` to preview.')
    } else {
      out.done(report.line)
    }

    return {
      success: true,
      ran: report.ran,
      skipped: report.skipped,
      dryRun: report.dryRun,
      reason: report.reason ?? null,
      line: report.line,
      archived: report.phases.consolidate.archived,
      deleted: report.phases.consolidate.deleted,
      indexLive: report.phases.prune.indexLive,
    }
  }

  private fail(msg: string, options: CeremonyOptions): CommandResult {
    if (options.md) console.log(`> ${msg}`)
    else out.fail(msg)
    return { success: false, error: msg }
  }
}
