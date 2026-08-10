/**
 * Work-graph verbs — the agent-facing surface of the dependency graph.
 *
 *   prjct ready [--md]              the unblocked frontier, ranked
 *   prjct next [--md]               top unclaimed item + orchestration directive
 *   prjct claim <id> [--as name]    race-free claim for multi-agent fan-out
 *   prjct depend <id> --on <id> [--type blocks|parent|related|discovered-from]
 *   prjct phases [--md]             topological parallelization plan
 *   prjct expand <id> ["sub" ...]   read the decomposition record / persist subtasks
 *   prjct switch <agent>            yield active cycle to another agent (realtime)
 *   prjct accept [hand_id]          accept a pending handoff
 *   prjct handoffs                  list recent handoffs
 */

import { acceptAgentHandoff, switchAgent } from '../services/agent-switch'
import { rankReadyWithImpact } from '../services/impact-ready'
import { buildTaskHarness } from '../services/task-harness'
import { orchestrationFor } from '../services/task-orchestration'
import { type DepType, workGraph } from '../services/work-graph'
import { listHandoffs } from '../storage/handoff-storage'
import { queueStorage } from '../storage/queue-storage'
import type { CommandResult } from '../types/commands'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'
import { requireProject } from './guards'

interface GraphOptions {
  md?: boolean
  on?: string
  type?: string
  as?: string
  reason?: string
  launch?: boolean
}

const DEP_TYPES: DepType[] = ['blocks', 'parent', 'related', 'discovered-from']

export class WorkGraphCommands extends PrjctCommandsBase {
  async ready(
    _input: string | null = null,
    projectPath: string = process.cwd(),
    options: GraphOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const base = workGraph.ready(proj.value)
    // Dynasty D4: re-rank by unblocks × world-model impact × SoT pressure.
    const items = rankReadyWithImpact(proj.value, base)
    if (items.length === 0) {
      const msg =
        'Nothing ready — the backlog is empty or fully blocked. `prjct phases --md` shows why.'
      if (options.md) console.log(`> ${msg}`)
      else out.info(msg)
      return { success: true, ready: 0 }
    }
    if (options.md) {
      const lines = [
        `# Ready frontier — ${items.length} unblocked item(s) (impact-ranked)`,
        '',
        '| Id | Item | Priority | Unblocks | Score | Claimed |',
        '|---|---|---|---:|---:|---|',
      ]
      for (const i of items) {
        lines.push(
          `| \`${i.id.slice(0, 8)}\` | ${i.description.slice(0, 80)} | ${i.priority ?? '-'} | ${i.unblocks} | ${Math.round(i.impactScore)} | ${i.claimedBy ?? '—'} |`
        )
      }
      lines.push(
        '',
        `Top rationale: ${items[0]?.why ?? '—'}`,
        '',
        'Claim before working: `prjct claim <id>`. Full id via `prjct sync --md`.'
      )
      console.log(lines.join('\n'))
    } else {
      out.info(`${items.length} ready item(s) (impact-ranked):`)
      for (const i2 of items) {
        out.info(`  • [${i2.id.slice(0, 8)}] ${i2.description.slice(0, 80)}`)
      }
      if (items[0]?.why) out.info(`  ${items[0].why}`)
    }
    return { success: true, ready: items.length, items }
  }

  async next(
    _input: string | null = null,
    projectPath: string = process.cwd(),
    options: GraphOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    // Impact-ordered: top unclaimed after re-rank (not pure SQL age/priority).
    const ranked = rankReadyWithImpact(
      proj.value,
      workGraph.ready(proj.value, { unclaimedOnly: true, limit: 20 })
    )
    const item = ranked[0] ?? null
    if (!item) {
      const msg = 'No unclaimed ready work. `prjct ready --md` for the frontier.'
      if (options.md) console.log(`> ${msg}`)
      else out.info(msg)
      return { success: true, next: null }
    }
    // prjct's edge over beads/Task Master: the next item ships WITH its
    // orchestration directive — model tier, effort, ceremony, fan-out.
    const harness = buildTaskHarness(item.description)
    const plan = orchestrationFor(harness)
    if (options.md) {
      const lines = [
        `# Next: ${item.description}`,
        '',
        `- Id: \`${item.id}\` · priority: ${item.priority ?? '-'} · unblocks ${item.unblocks} item(s) · impactScore ${Math.round(item.impactScore)}`,
        `- ${item.why}`,
        `- Orchestration: ${plan.model}/${plan.effort} · spec: ${plan.spec} · tests: ${plan.tests} · fan-out: ${plan.fanout} · ~${plan.expectedPoints} pt`,
        '',
        `Claim it: \`prjct claim ${item.id}\` — then \`prjct work "${item.description.slice(0, 60)}"\``,
      ]
      console.log(lines.join('\n'))
    } else {
      out.info(`next: [${item.id.slice(0, 8)}] ${item.description}`)
      out.info(`  ${item.why}`)
    }
    return { success: true, next: item, orchestration: plan, why: item.why }
  }

  async claim(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: GraphOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const id = await this.resolveId(proj.value, (input ?? '').trim())
    if (!id) return this.fail('Usage: prjct claim <task-id>', options)
    // Codex-style adorable default when neither --as nor PRJCT_AGENT is set.
    const claimant =
      options.as ??
      process.env.PRJCT_AGENT ??
      (await (async () => {
        const { pickCodename } = await import('../services/agent-codenames')
        const taken = workGraph
          .ready(proj.value, { limit: 50 })
          .map((i) => i.claimedBy)
          .filter((x): x is string => Boolean(x))
        return pickCodename(`claim:${id}:${Date.now()}`, taken)
      })())
    const won = workGraph.claim(proj.value, id, claimant)
    const msg = won
      ? `claimed ${id.slice(0, 8)} as ${claimant}`
      : `claim lost — ${id.slice(0, 8)} is already taken`
    if (options.md) console.log(`${won ? '✓' : '✗'} ${msg}`)
    else if (won) out.done(msg)
    else out.fail(msg)
    return { success: won, id, claimant }
  }

  async depend(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: GraphOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const fromRaw = (input ?? '').trim()
    if (!fromRaw || !options.on) {
      return this.fail(
        'Usage: prjct depend <id> --on <id> [--type blocks|parent|related|discovered-from]',
        options
      )
    }
    const depType = (options.type ?? 'blocks') as DepType
    if (!DEP_TYPES.includes(depType)) {
      return this.fail(`Unknown dep type '${options.type}'. Use: ${DEP_TYPES.join(' | ')}`, options)
    }
    const fromId = await this.resolveId(proj.value, fromRaw)
    const toId = await this.resolveId(proj.value, options.on.trim())
    if (!fromId || !toId) return this.fail('Could not resolve one of the ids', options)
    try {
      workGraph.addDependency(proj.value, fromId, toId, depType)
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : 'dependency rejected', options)
    }
    const msg = `${fromId.slice(0, 8)} —${depType}→ ${toId.slice(0, 8)}`
    if (options.md) console.log(`✓ ${msg}`)
    else out.done(msg)
    return { success: true, fromId, toId, depType }
  }

  async phases(
    _input: string | null = null,
    projectPath: string = process.cwd(),
    options: GraphOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const plan = workGraph.phases(proj.value)
    if (plan.length === 0) {
      const msg = 'No open work in the graph.'
      if (options.md) console.log(`> ${msg}`)
      else out.info(msg)
      return { success: true, phases: 0 }
    }
    if (options.md) {
      const lines = [
        '# Execution phases (topological)',
        '',
        'Items in the SAME phase have no dependency path between them — safe to fan out in parallel.',
        '',
      ]
      // Working-set bound (beads learned this at ~25k tokens): cap the render,
      // never the computation — the full plan is in the JSON result.
      const PER_PHASE_RENDER_CAP = 12
      for (const p of plan) {
        lines.push(`## Phase ${p.phase} — ${p.items.length} item(s), parallelizable`)
        for (const i of p.items.slice(0, PER_PHASE_RENDER_CAP)) {
          const harness = buildTaskHarness(i.description)
          const o = orchestrationFor(harness)
          lines.push(
            `- \`${i.id.slice(0, 8)}\` ${i.description.slice(0, 80)} _(${o.model}/${o.effort}, ~${o.expectedPoints} pt)_`
          )
        }
        if (p.items.length > PER_PHASE_RENDER_CAP) {
          lines.push(
            `- _…and ${p.items.length - PER_PHASE_RENDER_CAP} more (full list in --json / prjct ready)_`
          )
        }
        lines.push('')
      }
      console.log(lines.join('\n'))
    } else {
      for (const p2 of plan) out.info(`phase ${p2.phase}: ${p2.items.length} item(s)`)
    }
    return { success: true, phases: plan.length, plan }
  }

  async expand(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: GraphOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const parts = (input ?? '')
      .trim()
      .split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map((p) => p.replace(/^"|"$/g, ''))
      .filter(Boolean)
    const idRaw = parts[0]
    if (!idRaw) return this.fail('Usage: prjct expand <id> ["subtask 1" "subtask 2" ...]', options)
    const id = await this.resolveId(proj.value, idRaw)
    if (!id) return this.fail(`Unknown item '${idRaw}'`, options)
    const subDescriptions = parts.slice(1)

    if (subDescriptions.length === 0) {
      // Read side: serve the decomposition record (or compute one now).
      const parent = (await queueStorage.getTasks(proj.value)).find((t) => t.id === id)
      const description = parent?.description ?? id
      const existingRecord = workGraph.getComplexity(proj.value, id)
      const rec =
        existingRecord ??
        (() => {
          const harness = buildTaskHarness(description)
          const plan = orchestrationFor(harness)
          const computed = {
            score: plan.expectedPoints,
            recommendedSubtasks: plan.expectedPoints >= 5 ? Math.min(plan.expectedPoints, 6) : 0,
            expansionPrompt: `Decompose "${description}" into ${Math.min(plan.expectedPoints, 6)} independent, testable subtasks; make dependencies explicit; each subtask ≤ 2 points.`,
            reasoning: `Triage level ${harness.level}; ~${plan.expectedPoints} points.`,
          }
          workGraph.recordComplexity(proj.value, id, {
            score: computed.score,
            recommendedSubtasks: computed.recommendedSubtasks,
            expansionPrompt: computed.expansionPrompt ?? undefined,
            reasoning: computed.reasoning ?? undefined,
          })
          return computed
        })()
      if (options.md) {
        const lines = [
          `# Expand \`${id.slice(0, 8)}\` — ${description.slice(0, 90)}`,
          '',
          `- Complexity: ${rec.score} pt · recommended subtasks: ${rec.recommendedSubtasks}`,
          ...(rec.reasoning ? [`- Reasoning: ${rec.reasoning}`] : []),
          '',
          rec.recommendedSubtasks > 0
            ? `${rec.expansionPrompt}\n\nPersist your decomposition: \`prjct expand ${id.slice(0, 8)} "subtask 1" "subtask 2" ...\``
            : 'Small enough — no decomposition needed. Work it directly.',
        ]
        console.log(lines.join('\n'))
      } else {
        out.info(`complexity ${rec.score} pt, recommended subtasks: ${rec.recommendedSubtasks}`)
      }
      return { success: true, id, complexity: rec }
    }

    // Write side: persist the agent's decomposition as backlog items with
    // parent edges (the parent is blocked until all children complete).
    const created: string[] = []
    for (const desc of subDescriptions) {
      const task = await queueStorage.addTask(proj.value, {
        description: desc,
        section: 'active',
        type: 'feature',
        priority: 'medium',
      })
      workGraph.addDependency(proj.value, id, task.id, 'parent')
      created.push(task.id)
    }
    const msg = `expanded into ${created.length} subtask(s); parent is blocked until they complete`
    if (options.md) console.log(`✓ ${msg}`)
    else out.done(msg)
    return { success: true, id, created }
  }

  /**
   * Yield the current work cycle to another agent runtime.
   * Usage: prjct switch codex --reason "looping on auth" [--launch]
   */
  async switch(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: GraphOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const target = (input ?? '').trim().split(/\s+/).filter(Boolean)[0]
    if (!target) {
      return this.fail('Usage: prjct switch <agent> [--reason "…"] [--launch]', options)
    }
    const result = await switchAgent(proj.value, projectPath, target, {
      reason: options.reason,
      launch: options.launch,
      md: options.md,
    })
    if (!result.ok) return this.fail(result.error ?? 'switch failed', options)
    const h = result.handoff!
    if (options.md) {
      console.log(result.resumeCard ?? '')
      if (result.launched) console.log('\n_Launched target CLI (best-effort)._')
      else if (result.launchError) console.log(`\n_Launch skipped: ${result.launchError}_`)
    } else {
      out.done(`Yielded ${h.taskId.slice(0, 8)} → ${h.toAgent} (${h.id.slice(0, 16)})`)
      out.info(`Reason: ${h.reason}`)
      out.info(`Accept: prjct accept ${h.id}`)
      if (result.launched) out.info('Launched target CLI (best-effort)')
      else if (result.launchError) out.info(`Launch skipped: ${result.launchError}`)
    }
    return {
      success: true,
      handoffId: h.id,
      taskId: h.taskId,
      toAgent: h.toAgent,
      launched: result.launched ?? false,
    }
  }

  /**
   * Accept a pending handoff (by id or latest for this runtime).
   * Usage: prjct accept [hand_id]
   */
  async accept(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: GraphOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const id = (input ?? '').trim().split(/\s+/).filter(Boolean)[0] ?? null
    const result = await acceptAgentHandoff(proj.value, projectPath, id)
    if (!result.ok) return this.fail(result.error ?? 'accept failed', options)
    if (options.md) console.log(result.brief ?? '')
    else {
      out.done(`Accepted ${result.handoff!.id.slice(0, 16)} — cycle is yours`)
      out.info(`Task: ${result.handoff!.taskId.slice(0, 8)} · ${result.handoff!.taskDescription}`)
      out.info(`Why yielded: ${result.handoff!.reason}`)
      out.info('Next: prjct work --md  (same cycle; do not restart)')
    }
    return {
      success: true,
      handoffId: result.handoff!.id,
      taskId: result.handoff!.taskId,
    }
  }

  /** List recent / pending handoffs. */
  async handoffs(
    _input: string | null = null,
    projectPath: string = process.cwd(),
    options: GraphOptions = {}
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const rows = listHandoffs(proj.value, { limit: 20 })
    if (rows.length === 0) {
      const msg = 'No handoffs yet. Yield with `prjct switch <agent> --reason "…"`.'
      if (options.md) console.log(`> ${msg}`)
      else out.info(msg)
      return { success: true, count: 0 }
    }
    if (options.md) {
      const lines = [
        `# Handoffs (${rows.length})`,
        '',
        '| Id | Status | From → To | Task | Reason |',
        '|---|---|---|---|---|',
      ]
      for (const h of rows) {
        lines.push(
          `| \`${h.id.slice(0, 14)}\` | ${h.status} | ${h.fromAgent} → ${h.toAgent} | \`${h.taskId.slice(0, 8)}\` | ${h.reason.slice(0, 60)} |`
        )
      }
      lines.push('', 'Accept: `prjct accept <id>`')
      console.log(lines.join('\n'))
    } else {
      for (const h2 of rows) {
        out.info(
          `[${h2.status}] ${h2.id.slice(0, 14)} ${h2.fromAgent}→${h2.toAgent} ${h2.taskId.slice(0, 8)} — ${h2.reason.slice(0, 50)}`
        )
      }
    }
    return { success: true, count: rows.length, handoffs: rows }
  }

  /** Accept full UUIDs or unambiguous short prefixes (beads-style). */
  private async resolveId(projectId: string, raw: string): Promise<string | null> {
    if (!raw) return null
    const all = await queueStorage.getTasks(projectId)
    const exact = all.find((t) => t.id === raw)
    if (exact) return exact.id
    const matches = all.filter((t) => t.id.startsWith(raw))
    return matches.length === 1 ? matches[0].id : null
  }

  private fail(msg: string, options: GraphOptions): CommandResult {
    if (options.md) console.log(`> ${msg}`)
    else out.fail(msg)
    return { success: false, error: msg }
  }
}
