/**
 * Workflow Commands — `now` (work start) + `workflow` CRUD + `run`.
 *
 * Lean path: `prjct work "<intent>"` registers a work cycle, runs the
 * workflow rules, emits a minimal context block, and preserves quality gates.
 * All the agentic orchestration (command
 * executor, loop detector, plan mode, orchestrator-executor,
 * prompt-builder, context-builder) was dropped — it was harness.
 * Context arrives via hooks; Claude pulls on demand via the memory
 * verbs.
 *
 * Implementation lives in `./workflow/`:
 *   - intent.ts        — intent keyword detection + parseAction/searchRules
 *   - rule-actions.ts  — 12 standalone subcommand handlers
 *   - md-helpers.ts    — buildFlowDiagram for `--md` output
 */

import { resolveCallerIdentity } from '../services/agent-identity'
import { formatLikelyFileForAgent } from '../services/file-cue'
import { formatModelOnlyGuidance } from '../services/private-skill-router'
import {
  projectPatternAlignmentEntries,
  relevantProjectPatterns,
} from '../services/project-pattern-context'
import { condenseDeliveredDurable, gateDelivery } from '../services/session-context-cache'
import { collectActiveTasks } from '../services/task-overview'
import {
  formatRelatedContextForAgent,
  formatRiskForAgent,
  startTask,
} from '../services/task-service'
import { customWorkflowStorage } from '../storage/custom-workflow-storage'
import { stateStorage } from '../storage/state-storage'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { failFromError } from '../utils/md-aware'
import {
  mdActionRequired,
  mdDone,
  mdList,
  mdNextSteps,
  mdOutput,
  mdSection,
  mdTaskHeader,
} from '../utils/md-formatter'
import { showNextSteps, showStateInfo } from '../utils/next-steps'
import out from '../utils/output'
import { executeWorkflowRules } from '../workflow-engine/workflow-engine'
import { PrjctCommandsBase } from './base'
import { requireProject } from './guards'
import { detectIntent } from './workflow/intent'
import {
  workflowAdd,
  workflowDisable,
  workflowGate,
  workflowInstruction,
  workflowReset,
  workflowRm,
} from './workflow/rule-actions/rules'
import { workflowHelp, workflowShow } from './workflow/rule-actions/show'
import {
  workflowCreate,
  workflowDelete,
  workflowInit,
  workflowList,
} from './workflow/rule-actions/workflows'

const WORK_MD_BUDGET = 2_000

/** Priority-pack whole markdown sections; never cut a guidance section mid-byte. */
export function packWorkMarkdownSections(
  required: Array<string | null | undefined | false>,
  optional: Array<string | null | undefined | false>,
  budget = WORK_MD_BUDGET
): string {
  const kept: string[] = []
  const packing = { used: 0, omitted: 0 }
  for (const section of [...required, ...optional]) {
    if (!section) continue
    const separator = kept.length > 0 ? 2 : 0
    if (packing.used + separator + section.length <= budget) {
      kept.push(section)
      packing.used += separator + section.length
    } else {
      packing.omitted += 1
    }
  }
  const receipt =
    packing.omitted > 0
      ? `> ${packing.omitted} lower-priority section(s) omitted from this bounded surface; pull with \`prjct context\`, \`prjct search\`, or \`prjct workflows --md\`.`
      : null
  if (receipt) {
    const separator = kept.length > 0 ? 2 : 0
    if (packing.used + separator + receipt.length <= budget) kept.push(receipt)
  }
  return mdOutput(...kept)
}

export class WorkflowCommands extends PrjctCommandsBase {
  /**
   * `prjct work "<intent>"` — register the work cycle, run before/after rules,
   * emit a lean context block. Everything that used to go through the
   * agentic orchestration stack (commandExecutor → contextBuilder +
   * promptBuilder + orchestratorExecutor) was harness — dropped.
   * Context flows via hooks now; the memory verbs let Claude pull
   * more when it wants it.
   */
  async now(
    task: string | null = null,
    projectPath: string = process.cwd(),
    options: {
      skipHooks?: boolean
      md?: boolean
      spec?: string
      extend?: boolean
      geometry?: string
      /** Bypass session-scoped delivery trimming (re-emit everything). */
      full?: boolean
    } = {}
  ): Promise<CommandResult> {
    try {
      const proj = await requireProject(projectPath)
      if (!proj.ok) return proj.result
      const projectId = proj.value

      // `prjct work --extend` — consciously lift the hard turn-budget block for
      // the active cycle so editing can continue (advisory-by-consent).
      if (options.extend) {
        const ok = await stateStorage.acknowledgeTurnLimit(projectId, new Date().toISOString())
        const msg = ok
          ? 'Turn budget extended for the active cycle — the hard stop is lifted. Keep it honest: finish it, then `prjct status done`.'
          : 'No active cycle to extend. Start one with `prjct work "<intent>"`.'
        if (options.md) console.log(`> ${msg}`)
        else out.done(msg)
        return { success: ok, error: ok ? undefined : 'no active cycle' }
      }

      // No work arg → show the active one (or none).
      if (!task) return this._showActiveTask(projectId, projectPath, options)

      const geoRaw = options.geometry?.toLowerCase()
      const geometry =
        geoRaw === 'direct' || geoRaw === 'single' || geoRaw === 'split' ? geoRaw : undefined

      // Side-effecting core lives in task-service so the MCP write-path
      // fires identical gates/state/memory without printing to stdout.
      const outcome = await startTask(projectId, projectPath, task, {
        skipHooks: options.skipHooks,
        spec: options.spec,
        geometry,
      })
      if (!outcome.ok) {
        return { success: false, error: outcome.blocked ?? 'Task start blocked' }
      }

      const taskDescription = outcome.description ?? task
      const taskId = outcome.taskId ?? ''
      const linearId = outcome.linearId
      const branch = outcome.branch ?? ''
      const beforeInstructions = outcome.instructions ?? []
      const pipeline = outcome.pipeline
      const harness = outcome.harness
      const orchestration = outcome.orchestration
      const modelGuidance = formatModelOnlyGuidance(
        outcome.privateSkills ?? {},
        outcome.outputProfile ?? 'compact'
      )
      // Cap the passive surface: 3–4 reranked hits are enough as a "has this
      // come up before?" cue. The agent pulls full bodies on demand via
      // `prjct search <id>` / `prjct context memory`. Keeps work --md lean.
      const related = (outcome.relatedContext ?? []).slice(0, 4)
      // Session-scoped ledger: an entry already delivered in this session
      // (earlier cycle, mem_list, guard) collapses to an id ref here.
      const caller = resolveCallerIdentity('work')
      const relatedScope = {
        projectId,
        projectPath,
        sessionId: caller.sessionId,
        surface: 'cli-work' as const,
      }
      const relatedDeliverables = related.map((h) => ({
        id: h.id,
        content: formatRelatedContextForAgent(h),
      }))
      const relatedCondensed = await condenseDeliveredDurable(relatedScope, relatedDeliverables, {
        full: Boolean(options.full),
        probe: Boolean(options.md),
      })
      const relatedLines = [
        ...relatedCondensed.fresh.map((entry) => entry.content),
        ...(relatedCondensed.repeats.length > 0
          ? [
              `_Already in your context this session: ${relatedCondensed.repeats
                .map((entry) => `\`${entry.id}\``)
                .join(' ')}_`,
            ]
          : []),
      ]
      // The work surface is bounded. Four ranked implementations are enough
      // to establish house style while leaving room for the worktree path and
      // the mandatory alignment cue.
      const likelyFiles = (outcome.likelyFiles ?? []).slice(0, 4)
      const likelyFileLines = likelyFiles.map(formatLikelyFileForAgent)
      // Predictive risk — the preventive memory for the area this cycle touches,
      // surfaced before the edit when the bounded surface still has room.
      const risks = outcome.risks ?? []
      const riskLines = risks.map(formatRiskForAgent)

      // Project pattern supremacy: match house style; upgrade only real anti-patterns.
      // Prefer durable project style model (recomputed every sync), then related hits.
      const { buildAlignmentBrief } = await import('../services/project-alignment')
      const patternHits = related.filter((h) => h.type === 'pattern' || h.pattern)
      const antiHits = related.filter((h) => h.type === 'anti-pattern' || h.antiPattern)
      const { stylePatterns, styleAntis } = await (async () => {
        try {
          const selected = relevantProjectPatterns(projectId, taskDescription, {
            targetFiles: likelyFiles.map((file) => file.path),
            maxPatterns: 3,
            maxConventions: 2,
            maxAntiPatterns: 2,
          })
          const entries = projectPatternAlignmentEntries(selected)
          return {
            stylePatterns: entries.patterns,
            styleAntis: entries.antiPatterns,
          }
        } catch {
          return { stylePatterns: [], styleAntis: [] }
        }
      })()
      const alignment = buildAlignmentBrief({
        patterns: [
          ...stylePatterns,
          ...patternHits.map((h) => ({
            title: h.title,
            content: h.pattern || h.detail,
          })),
        ],
        antiPatterns: [
          ...styleAntis,
          ...antiHits.map((h) => ({
            title: h.title,
            content: h.antiPattern || h.detail,
          })),
        ],
        neighborHint: likelyFiles[0]?.path ?? null,
      })

      const isolation = outcome.isolation
      if (options.md) {
        const alignmentGateRequest = {
          projectId,
          projectPath,
          sessionId: caller.sessionId,
          surface: 'cli-work' as const,
          key: 'alignment',
          content: alignment.line,
          full: Boolean(options.full),
          noSession: { mode: 'static' as const, ttlMs: 15 * 60_000 },
          onRepeat: () => '_Unchanged this session — `prjct work --full` re-emits._',
        }
        const alignmentDelivery = await gateDelivery({ ...alignmentGateRequest, probe: true })
        const alignmentSection = mdSection('Project alignment (MUST before edit)', alignment.line)
        const livingKnowledgeSection =
          relatedLines.length > 0
            ? mdSection(
                'Living knowledge — SoT · tips (terminal → user)',
                [
                  '> **You are the tip channel** (no separate UI). On your next reply to the user, surface relevant lines as short terminal tips, then act.',
                  '> **SoT** = binding project truth — do not contradict without `prjct remember` superseding.',
                  '> **SUGGEST / tip** = propose the live modification in chat (files + action) and apply when editing.',
                  mdList(relatedLines),
                ].join('\n')
              )
            : null
        const workSections = [
          mdTaskHeader({
            description: [...taskDescription].slice(0, 240).join(''),
            status: 'active',
          }),
          isolation
            ? mdSection(
                '⚠ Isolated to worktree (foreign occupant)',
                mdList([
                  isolation.reason,
                  `Was: ${isolation.occupantSummary}`,
                  `Worktree: \`${isolation.worktreePath}\``,
                  `Branch: \`${isolation.branch}\``,
                  `**Next:** \`cd ${isolation.worktreePath}\` and continue there`,
                ])
              )
            : null,
          mdSection(
            'State',
            mdList(
              [
                `Work cycle: \`${taskId}\``,
                branch ? `Branch: \`${branch}\`` : null,
                outcome.ownerAgent
                  ? `Owner: \`${outcome.ownerAgent}/${outcome.ownerIdentity ?? '?'}\``
                  : null,
                linearId ? `Linear: \`${linearId}\`` : null,
                harness ? `Harness: ${harness.level} ${harness.kind}/${harness.risk}` : null,
                harness?.expectedEvidence.length
                  ? `Evidence: ${harness.expectedEvidence.join(', ')}`
                  : null,
                beforeInstructions.length > 0
                  ? `Agent instructions: ${beforeInstructions.length}`
                  : null,
              ].filter((s): s is string => s !== null)
            )
          ),
          orchestration
            ? mdSection(
                'How to run this (orchestration)',
                [
                  orchestration.directive,
                  orchestration.cast && orchestration.cast.length > 0
                    ? `\n**Subagents:** ${orchestration.cast.map((c) => `${c.name} (${c.role})`).join(' · ')}`
                    : '',
                ]
                  .filter(Boolean)
                  .join('')
              )
            : null,
          mdSection('Model guidance', modelGuidance),
          pipeline
            ? mdSection(
                'Task Pipeline',
                [
                  '> AUTHORITATIVE: this station state is computed from persisted pipeline data — follow `Next action` over your own phase inference.',
                  mdList([
                    `Classification: \`${pipeline.classification}\``,
                    `Station: \`${pipeline.station}\``,
                    `Requires spec: ${pipeline.requiresSpec ? 'yes' : 'no'}`,
                    `Tests first: ${pipeline.requiresTestsFirst ? 'yes' : 'no'}`,
                    `Next action: ${pipeline.nextAction}`,
                  ]),
                ].join('\n')
              )
            : null,
          beforeInstructions.length > 0
            ? mdSection('Agent Instructions', mdList(beforeInstructions))
            : null,
          riskLines.length > 0
            ? mdSection(
                '⚠ Risk — what bit us in this area before (read before you edit)',
                mdList(riskLines)
              )
            : null,
          alignmentSection,
          livingKnowledgeSection,
          likelyFileLines.length > 0
            ? mdSection(
                'Work scope — prjct (MUST before Grep/Glob)',
                [
                  '> Do NOT tree-walk. Open these first. Expand with `prjct guard <file>` or MCP `prjct_relevant_files` / `prjct_impact_analysis`. Memory+index+graph already ran.',
                  mdList(likelyFileLines),
                ].join('\n')
              )
            : mdSection(
                'Work scope — prjct',
                '> No high-confidence files yet. MUST run `prjct context memory <topic>` + `prjct search` (and `prjct sync` if indexes cold) before Grep/Glob walks.'
              ),
          mdNextSteps([
            { label: 'Synthesize context on close', command: 'prjct remember context "..."' },
            { label: 'Ship when done', command: 'prjct ship --md' },
          ]),
          // [12] QA plan — appended LAST: packing below is by positional index.
          outcome.qa?.section
            ? mdSection(
                'QA plan (MUST before implementing)',
                [
                  '> AUTHORITATIVE: acceptance criteria + flows are verified before done/ship.',
                  outcome.qa.section,
                ].join('\n')
              )
            : null,
        ]
        const md = packWorkMarkdownSections(
          [
            workSections[0],
            workSections[1],
            // QA directive is a MUST-before-implementing gate and short: it rides
            // right behind the header so the budget can never drop it.
            workSections[12],
            // Source alignment is a correctness gate, not optional prose.
            // Keep it ahead of orchestration/model guidance so tight budgets
            // cannot tell Codex how to work while hiding what to reuse.
            workSections[8],
            workSections[10],
            workSections[2],
            workSections[3],
            workSections[4],
            workSections[5],
            workSections[6],
            workSections[7],
            workSections[11],
          ],
          [workSections[9]]
        )
        if (md.includes(alignmentSection) && !alignmentDelivery.suppressed) {
          await gateDelivery({ ...alignmentGateRequest, full: true })
        }
        if (livingKnowledgeSection && md.includes(livingKnowledgeSection)) {
          await condenseDeliveredDurable(relatedScope, relatedDeliverables, {
            full: Boolean(options.full),
          })
        }
        console.log(md)
      } else {
        out.done(`Work: ${taskDescription}`)
        if (isolation) {
          out.warn(isolation.reason)
          out.info(`Isolated → ${isolation.worktreePath} (${isolation.branch})`)
          out.info(`Next: cd ${isolation.worktreePath}`)
        }
        if (outcome.ownerAgent) {
          out.info(`Owner: ${outcome.ownerAgent}/${outcome.ownerIdentity ?? '?'}`)
        }
        if (harness) {
          out.info(`Harness: ${harness.level} ${harness.kind}/${harness.risk}`)
          if (harness.expectedEvidence.length > 0) {
            out.info(`Evidence: ${harness.expectedEvidence.join(', ')}`)
          }
        }
        if (orchestration) out.info(orchestration.directive)
        if (outcome.qa?.directive) out.info(`QA plan (AUTHORITATIVE): ${outcome.qa.directive}`)
        out.info(modelGuidance)
        out.info(alignment.line)
        if (riskLines.length > 0) {
          out.info('⚠ Risk — what bit us in this area before (read before you edit)')
          for (const line of riskLines) out.info(`  ${line}`)
        }
        if (relatedLines.length > 0) {
          out.info(
            'Living knowledge — surface as terminal tips to the user (SoT binding · SUGGEST live mods)'
          )
          for (const line2 of relatedLines) out.info(`  ${line2}`)
        }
        if (likelyFileLines.length > 0) {
          out.info('Work scope — prjct (MUST before Grep/Glob)')
          for (const line3 of likelyFileLines) out.info(`  ${line3}`)
        } else {
          out.info(
            'Work scope empty — run prjct context memory / search (or prjct sync) before Grep/Glob'
          )
        }
        showStateInfo('working')
        showNextSteps('task')
      }

      return { success: true, task: taskDescription, taskId, harness }
    } catch (error) {
      const msg = getErrorMessage(error)
      if (options.md) console.log(`> ${msg}`)
      else out.fail(msg)
      return { success: false, error: msg }
    }
  }

  /**
   * Render the active work cycle when `prjct work` is called without args.
   * Null-path when nothing's active — clean exit, no pressure.
   */
  private async _showActiveTask(
    projectId: string,
    projectPath: string,
    options: { md?: boolean }
  ): Promise<CommandResult> {
    const overview = await collectActiveTasks(projectId, projectPath)
    const active = overview.current
    const others = overview.all.filter((v) => !v.isCurrent)

    // Rig-agnostic delegation trigger: rigs without per-turn hooks (Codex,
    // Gemini, Cursor, ...) poll `prjct work`/`status` — count the working
    // tree's touched files via git (no hook events needed) and surface the
    // same trigger the Claude hook fires. Best-effort: no git → no trigger.
    const delegationTrigger = await (async (): Promise<string | null> => {
      try {
        const { execFileAsync } = await import('../utils/exec')
        // status --porcelain covers modified AND untracked (diff HEAD misses
        // brand-new files — often the bulk of a multi-file change). This counts
        // current working-tree surface, an honest proxy for "this cycle" on
        // rigs without edit hooks; committed-as-you-go work under-counts.
        const r = await execFileAsync('git', ['status', '--porcelain'], {
          cwd: projectPath,
          timeout: 2000,
        })
        const touched = r.stdout.split('\n').filter(Boolean).length
        const { renderDelegationTrigger } = await import('../services/task-orchestration')
        return renderDelegationTrigger(touched)
      } catch {
        return null
      }
    })()

    if (!active) {
      // Nothing in THIS worktree — but sibling worktrees may be busy.
      const base = 'no active work cycle. `prjct work "<intent>"` to start one.'
      const hint =
        others.length > 0
          ? `\n${others.length} active in other workspace(s):\n${others
              .map((v) => `  ${v.label}    ${v.description}`)
              .join('\n')}`
          : ''
      const msg = base + hint
      if (options.md) console.log(`> ${msg}`)
      else out.info(msg)
      return { success: true, message: 'no active work cycle' }
    }
    if (options.md) {
      console.log(
        mdOutput(
          mdTaskHeader({ description: active.description, status: 'active' }),
          mdSection(
            'State',
            mdList(
              [
                `Work cycle: \`${active.id}\``,
                `Workspace: \`${active.label}\``,
                active.branch ? `Branch: \`${active.branch}\`` : null,
                active.linearId ? `Linear: \`${active.linearId}\`` : null,
                `Started: ${active.startedAt}`,
                active.pipeline ? `Pipeline: \`${active.pipeline.station}\`` : null,
                active.harness
                  ? `Harness: ${active.harness.level} ${active.harness.kind}/${active.harness.risk}`
                  : null,
                delegationTrigger,
                others.length > 0 ? `Other active workspaces: ${others.length}` : null,
              ].filter((s): s is string => s !== null)
            )
          ),
          active.pipeline
            ? mdSection(
                'Next Action',
                mdList([
                  active.pipeline.requiresTestsFirst
                    ? 'Write tests before implementation for substantive work.'
                    : 'Proceed directly for this trivial work.',
                ])
              )
            : null,
          others.length > 0
            ? mdSection(
                'Other Active Workspaces',
                mdList(others.map((v) => `${v.label} — ${v.description}`))
              )
            : null
        )
      )
    } else {
      out.info(`Active: ${active.description}`)
      out.info(`Workspace: ${active.label}`)
      if (active.pipeline) out.info(`Pipeline: ${active.pipeline.station}`)
      if (active.harness) {
        out.info(`Harness: ${active.harness.level} ${active.harness.kind}/${active.harness.risk}`)
      }
      for (const v of others) out.info(`  other: ${v.label} — ${v.description}`)
    }
    return { success: true, currentTask: active }
  }

  /**
   * `prjct workflow [intent] [args]` — view and manage workflow rules.
   *
   * Detects the intent keyword, dispatches to the matching handler in
   * `./workflow/rule-actions.ts`. Empty input → show all rules.
   */
  async workflow(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const proj = await requireProject(projectPath, options)
      if (!proj.ok) return proj.result
      const projectId = proj.value

      const trimmed = input?.trim() ?? ''

      if (!trimmed) {
        return workflowShow(null, projectId, options)
      }

      // `runs` (C8 read surface) isn't an executable IntentType — handle it here.
      if (trimmed.toLowerCase() === 'runs') {
        return this.runs(projectId, options)
      }

      const intent = detectIntent(trimmed)

      switch (intent.type) {
        case 'add':
          return workflowAdd(intent.args, projectId, options)
        case 'gate':
          return workflowGate(intent.args, projectId, options)
        case 'instruction':
          return workflowInstruction(intent.args, projectId, options)
        case 'remove':
          return workflowRm(intent.args, projectId, options)
        case 'disable':
          return workflowDisable(intent.args, projectId, options)
        case 'reset':
          return workflowReset(projectId, options)
        case 'init':
          return workflowInit(projectId, projectPath, options)
        case 'help':
          return workflowHelp(options)
        case 'create':
          return workflowCreate(intent.args, projectId, projectPath, options)
        case 'list':
          return workflowList(projectId, options)
        case 'delete':
          return workflowDelete(intent.args, projectId, options)
        case 'run':
          return this.run(intent.args, projectPath, options)
        case 'view':
          return workflowShow(intent.args || null, projectId, options)
        default:
          // Fallback: treat the first token as a command filter for show.
          return workflowShow(trimmed.split(/\s+/)[0]?.toLowerCase() || null, projectId, options)
      }
    } catch (error) {
      if (options.md) {
        console.log(`> Error: ${getErrorMessage(error)}`)
      } else {
        out.fail(getErrorMessage(error))
      }
      return failFromError(error)
    }
  }

  /**
   * Recent workflow runs with step + gate-outcome counts (C8 read surface).
   */
  async runs(projectId: string, options: MdOption): Promise<CommandResult> {
    const { getRecentWorkflowRuns } = await import('../workflow-engine/run-recorder')
    const runs = getRecentWorkflowRuns(projectId, 20)
    if (runs.length === 0) {
      const msg = 'No workflow runs recorded yet.'
      if (options.md) console.log(`> ${msg}`)
      else out.info(msg)
      return { success: true }
    }
    const lines = runs.map(
      (r) =>
        `- \`${r.command}\` — ${r.status} · ${r.steps} step(s) · gates ${r.gatesPassed}✓/${r.gatesFailed}✗`
    )
    if (options.md) console.log(['## Workflow runs', ...lines].join('\n'))
    else out.info(['Workflow runs:', ...lines].join('\n'))
    return { success: true }
  }

  /**
   * Execute a custom workflow (runs all before/after rules).
   */
  async run(
    workflowName: string,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const proj = await requireProject(projectPath, options)
      if (!proj.ok) return proj.result
      const projectId = proj.value

      const name = workflowName.trim()
      if (!name) {
        const msg = 'Usage: prjct workflow run <name>'
        if (options.md) console.log(`> ${msg}`)
        else out.warn(msg)
        return { success: false, error: msg }
      }

      const workflow = customWorkflowStorage.getWorkflow(projectId, name)
      if (!workflow || !workflow.enabled) {
        const msg = `Workflow '${name}' not found`
        if (options.md) console.log(`> ${msg}`)
        else out.warn(msg)
        return { success: false, error: msg }
      }

      // Execute before phase (gates + steps)
      const beforeResult = await executeWorkflowRules(projectId, name, 'before', { projectPath })

      if (!beforeResult.success) {
        if (options.md) {
          mdActionRequired('failed', 'workflow_gates_failed', [
            { label: 'View rules', command: `prjct workflow ${name} --md` },
          ])
        } else {
          out.fail('Workflow gates failed')
          if (beforeResult.gatesFailed) {
            for (const gate of beforeResult.gatesFailed) {
              console.log(`  ✗ ${gate}`)
            }
          }
        }
        return {
          success: false,
          error: 'Workflow gates failed',
          gatesFailed: beforeResult.gatesFailed,
        }
      }

      // Execute after phase (hooks)
      await executeWorkflowRules(projectId, name, 'after', { projectPath })

      if (options.md) {
        console.log(
          mdOutput(
            mdDone(`Workflow: ${name}`, workflow.description || ''),
            mdNextSteps([
              { label: 'View rules', command: `prjct workflow ${name} --md` },
              { label: 'Run again', command: `p. ${name}` },
            ])
          )
        )
      } else {
        out.done(`${name} completed successfully`)
      }

      return { success: true, workflow: name }
    } catch (error) {
      const msg = getErrorMessage(error)
      if (options.md) {
        console.log(`> Error: ${msg}`)
      } else {
        out.fail(msg)
      }
      return { success: false, error: msg }
    }
  }
}
