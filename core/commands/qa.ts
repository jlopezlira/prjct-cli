/**
 * `prjct qa` — the QA phase verb (same shape as `tdd`/`sdd`: one registered
 * verb, subcommand-parsed, a single file).
 *
 *   prjct qa                          → mode · active cycle plan · app · receipt
 *   prjct qa off|advisory|strict      → set intensity (writes config.qa.mode)
 *   prjct qa plan [--json '{…}']      → show/seed the plan · upsert criteria+flows
 *   prjct qa set <key> "<value>"      → app.start | app.baseUrl | app.readyPath | e2e | …
 *   prjct qa run [--flow <id>]        → execute probes, receipt bound to HEAD
 *   prjct qa next                     → the next card (write_plan · run_probes · dispatch_qa_agent · …)
 *   prjct qa brief                    → the blind QA subagent's only input
 *   prjct qa report --json '[…]'      → subagent verdicts (verifiedBy: agent)
 *   prjct qa mark <id> <status>       → author self-mark (never satisfies strict)
 *   prjct qa receipt                  → last receipt
 *   prjct qa browser <verb> …         → install|status · goto|fill|click|text|screenshot|close (prjct's own headless browser)
 *
 * prjct owns the mechanism; the model writes criteria/flows and drives the
 * browser. Nothing here needs a test framework in the client project.
 */

import configManager from '../infrastructure/config-manager'
import {
  QA_MODES,
  type QaCriterionStatus,
  type QaFlowStatus,
  type QaMode,
  QaPlanInputSchema,
  QaReportSchema,
} from '../schemas/qa'
import { gitBinding } from '../services/gauntlet'
import { buildQaBrief } from '../services/qa-brief'
import { effectiveQaMode, qaNextAction } from '../services/qa-gate'
import {
  applyQaReport,
  getQaPlan,
  markCriterion,
  markFlow,
  QA_PLAN_JSON_HINT,
  qaPlanSummary,
  renderQaChecklistMd,
  upsertQaPlan,
} from '../services/qa-plan'
import {
  detectQaCandidates,
  QA_SET_KEYS,
  qaExtraCommands,
  readQaReceipt,
  renderQaReceiptMd,
  renderQaReceiptText,
  runQa,
  setQaValue,
} from '../services/qa-runner'
import { resolveActiveTask } from '../services/task-service'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import type { LocalConfig } from '../types/config'
import { failHard, failWith } from '../utils/md-aware'
import { mdOutput } from '../utils/md-formatter'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'
import { parseModeSubcommand, requireProjectConfig } from './mode-command-helpers'

export interface QaCmdOptions extends MdOption {
  json?: string
  flow?: string
  evidence?: string
  noServe?: boolean
}

type ActiveCycle = { id: string; harnessLevel?: 'H0' | 'H1' | 'H2' | 'H3' }

const CRITERION_STATUSES: readonly QaCriterionStatus[] = ['pending', 'met', 'unmet']
const FLOW_STATUSES: readonly QaFlowStatus[] = ['pending', 'passed', 'failed', 'skipped']

export class QaCommands extends PrjctCommandsBase {
  async qa(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: QaCmdOptions = {}
  ): Promise<CommandResult> {
    const parsed = parseModeSubcommand(input, QA_MODES)
    if (parsed.kind === 'status') return this.showStatus(projectPath, options)
    if (parsed.kind === 'mode') return this.setMode(parsed.mode as QaMode, projectPath, options)
    const tokens = (input ?? '').trim().split(/\s+/).filter(Boolean)
    switch (parsed.sub) {
      case 'plan':
        return this.plan(projectPath, options)
      case 'set':
        return this.set(tokens[1] ?? null, tokens.slice(2).join(' '), projectPath, options)
      case 'run':
        return this.run(projectPath, options)
      case 'next':
        return this.next(projectPath, options)
      case 'brief':
        return this.brief(projectPath, options)
      case 'report':
        return this.report(projectPath, options)
      case 'mark':
        return this.mark(tokens[1] ?? null, tokens[2] ?? null, projectPath, options)
      case 'receipt':
        return this.receipt(projectPath, options)
      case 'browser':
        return this.browser(tokens.slice(1), projectPath, options)
      default:
        return failWith(
          `Unknown qa subcommand "${parsed.sub}". Use: plan, set, run, next, brief, report, mark, receipt, browser, or ${QA_MODES.join('|')}.`,
          options
        )
    }
  }

  /**
   * `prjct qa browser install|status|goto|fill|click|text|screenshot|close` —
   * prjct's own headless browser: machine `browser` probes and agent
   * primitives for rigs with no browser MCP.
   */
  private async browser(
    args: string[],
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const { browserStatus, installBrowser, renderBrowserStatus, runBrowserPrimitive } =
      await import('../services/qa-browser')
    const verb = args[0] ?? 'status'
    if (verb === 'status') {
      const status = browserStatus()
      if (options.md) console.log(mdOutput('## QA browser', renderBrowserStatus(status)))
      else out.info(renderBrowserStatus(status))
      return { success: true, installed: status.installed, status }
    }
    if (verb === 'install') {
      const result = await installBrowser((line) => {
        if (options.md) console.log(`> ${line}`)
        else out.info(line)
      })
      if (!result.ok) return failHard(`Browser install failed: ${result.error}`, options)
      const msg =
        'prjct browser installed — browser probes run by machine; the QA subagent can drive `prjct qa browser …`.'
      if (options.md)
        console.log(mdOutput('## QA browser', `> ${msg}`, renderBrowserStatus(result.status)))
      else out.done(msg)
      return { success: true, installed: true, status: result.status }
    }
    const guard = await requireProjectConfig(projectPath, options)
    if (!guard.ok) return guard.result
    const config = guard.value
    const result = await runBrowserPrimitive(
      config.projectId,
      args,
      config.qa?.app?.baseUrl ?? null
    )
    if (options.md) console.log(mdOutput('## QA browser', result.text))
    else if (result.ok) out.info(result.text)
    else out.fail(result.text)
    return { success: result.ok, text: result.text }
  }

  private async activeCycle(
    config: LocalConfig,
    projectPath: string,
    options: MdOption
  ): Promise<{ ok: true; value: ActiveCycle } | { ok: false; result: CommandResult }> {
    const task = await resolveActiveTask(config.projectId, projectPath).catch(() => null)
    if (!task) {
      return {
        ok: false,
        result: failHard(
          'No active work cycle — start one with `prjct work "<intent>"` first.',
          options
        ),
      }
    }
    return { ok: true, value: { id: task.id, harnessLevel: task.harness?.level } }
  }

  private async showStatus(projectPath: string, options: QaCmdOptions): Promise<CommandResult> {
    const guard = await requireProjectConfig(projectPath, options)
    if (!guard.ok) return guard.result
    const config = guard.value
    const mode = effectiveQaMode(config)
    const task = await resolveActiveTask(config.projectId, projectPath).catch(() => null)
    const plan = task ? getQaPlan(config.projectId, task.id) : null
    const receipt = readQaReceipt(config.projectId, task?.id)?.data ?? null
    const app = config.qa?.app
    const extras = qaExtraCommands(config)
    const candidates =
      extras.length === 0 ? await detectQaCandidates(projectPath).catch(() => []) : []
    const summary = plan ? qaPlanSummary(plan) : null
    const planLine = !task
      ? 'no active work cycle'
      : !plan
        ? `none for cycle ${task.id.slice(0, 8)} — \`prjct qa plan --json '…'\``
        : `${summary?.criteria.met}/${summary?.criteria.total} criteria met · ${summary?.flows.passed}/${summary?.flows.total} flows passed (${summary?.flows.withProbe} probes)`
    const appLine = app?.baseUrl
      ? `${app.baseUrl}${app.start ? ` · start: \`${app.start}\`` : ' · start: not registered'}`
      : 'not registered — `prjct qa set app.start "<cmd>"` + `prjct qa set app.baseUrl <url>`'
    const receiptLine = receipt
      ? `${receipt.vacuous ? 'VACUOUS' : receipt.passed ? 'PASS' : 'RED'} · HEAD ${receipt.headSha?.slice(0, 8) ?? 'no-git'} · ${receipt.ranAt}`
      : 'none — `prjct qa run`'
    const { browserStatus } = await import('../services/qa-browser')
    const browser = browserStatus()
    const browserLine = browser.installed
      ? `installed (playwright-core ${browser.playwrightVersion}) — \`prjct qa browser goto|fill|click|text|screenshot\``
      : 'not installed — `prjct qa browser install` (one-time, under the prjct cache; browser probes + a universal driver for the QA subagent)'
    const extraLines =
      extras.length > 0
        ? extras.map((c) => `- extra ${c.kind}: \`${c.command}\``)
        : candidates.map(
            (c) =>
              `- detected ${c.kind} (${c.source}): \`${c.command}\` — register with \`prjct qa set ${c.kind} "${c.command}"\``
          )
    if (options.md) {
      console.log(
        mdOutput(
          '## QA',
          `> **Mode**: \`${mode}\`${mode === 'off' ? ' (phase dormant)' : ''}`,
          [
            `- Plan: ${planLine}`,
            `- App: ${appLine}`,
            `- Browser: ${browserLine}`,
            `- Receipt: ${receiptLine}`,
            ...extraLines,
          ].join('\n'),
          plan ? renderQaChecklistMd(plan).join('\n') : null,
          'Set: `prjct qa off|advisory|strict` · Next step: `prjct qa next`'
        )
      )
    } else {
      out.info(
        `QA — Mode: ${mode}\n  Plan: ${planLine}\n  App: ${appLine}\n  Browser: ${browserLine}\n  Receipt: ${receiptLine}`
      )
      for (const line of extraLines) out.info(`  ${line}`)
      if (plan) for (const line of renderQaChecklistMd(plan)) out.info(`  ${line}`)
    }
    return { success: true, mode, plan, receipt }
  }

  private async setMode(
    mode: QaMode,
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const guard = await requireProjectConfig(projectPath, options)
    if (!guard.ok) return guard.result
    const config = guard.value
    config.qa = { ...(config.qa ?? {}), mode }
    await configManager.writeConfig(projectPath, config)
    const msg =
      mode === 'off'
        ? 'QA mode off — no plan directive, no done/ship gates.'
        : mode === 'advisory'
          ? 'QA mode → advisory. `work` asks for the plan; `done`/`ship` warn on unverified flows.'
          : 'QA mode → strict. `done`/`ship` block until every flow is machine- or agent-verified (override: `prjct ship --no-qa-gate`).'
    if (options.md) console.log(mdOutput('## QA', `> ${msg}`))
    else out.done(msg)
    return { success: true, mode }
  }

  private async plan(projectPath: string, options: QaCmdOptions): Promise<CommandResult> {
    const guard = await requireProjectConfig(projectPath, options)
    if (!guard.ok) return guard.result
    const config = guard.value
    const cycle = await this.activeCycle(config, projectPath, options)
    if (!cycle.ok) return cycle.result
    const mode = effectiveQaMode(config)
    const jsonInput = typeof options.json === 'string' ? options.json : ''
    if (!jsonInput) {
      const plan = getQaPlan(config.projectId, cycle.value.id)
      const body = plan
        ? renderQaChecklistMd(plan).join('\n')
        : `No QA plan for this cycle yet. Write it:\n\`prjct qa plan --json '${QA_PLAN_JSON_HINT}'\``
      if (options.md) console.log(mdOutput('## QA plan', body))
      else out.info(body)
      return { success: true, plan }
    }
    const decoded = (() => {
      try {
        return JSON.parse(jsonInput) as unknown
      } catch {
        return undefined
      }
    })()
    if (decoded === undefined) return failWith('--json is not valid JSON', options)
    const parsed = QaPlanInputSchema.safeParse(decoded)
    if (!parsed.success) {
      return failWith(
        `--json does not match the plan shape: ${parsed.error.issues[0]?.message ?? 'invalid'}\nShape: ${QA_PLAN_JSON_HINT}`,
        options
      )
    }
    const result = upsertQaPlan(config.projectId, cycle.value.id, parsed.data, { mode })
    if (!result.plan) {
      return failHard(`QA plan refused (strict): ${result.rejected}`, options)
    }
    const s = qaPlanSummary(result.plan)
    const warn = result.report.ok ? null : `⚠ ${result.report.message}`
    const msg = `QA plan saved: ${s.criteria.total} criteria · ${s.flows.total} flows (${s.flows.withProbe} with probes). Next: \`prjct qa next\`.`
    if (options.md)
      console.log(
        mdOutput('## QA plan', `> ${msg}`, warn, renderQaChecklistMd(result.plan).join('\n'))
      )
    else {
      out.done(msg)
      if (warn) out.warn(warn)
    }
    return { success: true, plan: result.plan, vague: result.report.vague }
  }

  private async set(
    key: string | null,
    value: string,
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    if (!key || !value.trim()) {
      return failWith(`Usage: prjct qa set <${QA_SET_KEYS.join('|')}> "<value>"`, options)
    }
    const result = await setQaValue(projectPath, key, value)
    if (!result.ok) return failWith(result.error ?? 'could not save', options)
    const msg = `QA ${key}: ${value.trim()}`
    if (options.md) console.log(mdOutput('## QA', `> ${msg}`))
    else out.done(msg)
    return { success: true, key, value: value.trim() }
  }

  private async run(projectPath: string, options: QaCmdOptions): Promise<CommandResult> {
    const guard = await requireProjectConfig(projectPath, options)
    if (!guard.ok) return guard.result
    const config = guard.value
    const task = await resolveActiveTask(config.projectId, projectPath).catch(() => null)
    const plan = task ? getQaPlan(config.projectId, task.id) : null
    const receipt = await runQa(projectPath, config.projectId, {
      plan,
      flowId: options.flow,
      serve: options.noServe !== true,
    })
    console.log(options.md ? renderQaReceiptMd(receipt) : renderQaReceiptText(receipt))
    return { success: receipt.passed, passed: receipt.passed, vacuous: receipt.vacuous, receipt }
  }

  private async next(projectPath: string, options: MdOption): Promise<CommandResult> {
    const guard = await requireProjectConfig(projectPath, options)
    if (!guard.ok) return guard.result
    const config = guard.value
    const cycle = await this.activeCycle(config, projectPath, options)
    if (!cycle.ok) return cycle.result
    const plan = getQaPlan(config.projectId, cycle.value.id)
    const receipt = readQaReceipt(config.projectId, cycle.value.id)?.data ?? null
    const binding = await gitBinding(projectPath)
    const card = qaNextAction({
      mode: effectiveQaMode(config),
      harnessLevel: cycle.value.harnessLevel,
      plan,
      receipt,
      headSha: binding.headSha,
      nowMs: Date.now(),
      browserInstalled: (await import('../services/qa-browser')).browserStatus().installed,
    })
    const body = [
      `- **kind**: \`${card.kind}\``,
      `- **directive**: ${card.directive}`,
      ...(card.steps.length
        ? ['', '### Steps', ...card.steps.map((s, i) => `${i + 1}. ${s}`)]
        : []),
    ].join('\n')
    if (options.md) console.log(mdOutput('## QA — next', body))
    else
      out.info(
        `QA next: ${card.kind}\n  ${card.directive}\n${card.steps.map((s) => `  - ${s}`).join('\n')}`
      )
    return { success: true, card }
  }

  private async brief(projectPath: string, options: MdOption): Promise<CommandResult> {
    const guard = await requireProjectConfig(projectPath, options)
    if (!guard.ok) return guard.result
    const config = guard.value
    const cycle = await this.activeCycle(config, projectPath, options)
    if (!cycle.ok) return cycle.result
    const plan = getQaPlan(config.projectId, cycle.value.id)
    if (!plan)
      return failHard('No QA plan for this cycle — `prjct qa plan --json …` first.', options)
    const receipt = readQaReceipt(config.projectId, cycle.value.id)?.data ?? null
    const { browserStatus } = await import('../services/qa-browser')
    console.log(
      buildQaBrief({ plan, receipt, config, browserInstalled: browserStatus().installed })
    )
    return { success: true }
  }

  private async report(projectPath: string, options: QaCmdOptions): Promise<CommandResult> {
    const guard = await requireProjectConfig(projectPath, options)
    if (!guard.ok) return guard.result
    const config = guard.value
    const cycle = await this.activeCycle(config, projectPath, options)
    if (!cycle.ok) return cycle.result
    const jsonInput = typeof options.json === 'string' ? options.json : ''
    if (!jsonInput) return failWith("report requires --json '[{id, verdict, evidence}]'", options)
    const decoded = (() => {
      try {
        return JSON.parse(jsonInput) as unknown
      } catch {
        return undefined
      }
    })()
    if (decoded === undefined) return failWith('--json is not valid JSON', options)
    const parsed = QaReportSchema.safeParse(decoded)
    if (!parsed.success) {
      return failWith(
        `--json does not match the report shape (evidence ≥ 40 chars): ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        options
      )
    }
    const result = applyQaReport(config.projectId, cycle.value.id, parsed.data)
    if (!result.plan)
      return failHard('No QA plan for this cycle — nothing to report against.', options)
    const msg = `QA report applied: ${result.applied.length} verdict(s)${result.unknown.length ? ` · unknown ids: ${result.unknown.join(', ')}` : ''}. Next: \`prjct qa next\`.`
    if (options.md)
      console.log(mdOutput('## QA report', `> ${msg}`, renderQaChecklistMd(result.plan).join('\n')))
    else out.done(msg)
    return {
      success: result.unknown.length === 0,
      applied: result.applied,
      unknown: result.unknown,
    }
  }

  private async mark(
    id: string | null,
    status: string | null,
    projectPath: string,
    options: QaCmdOptions
  ): Promise<CommandResult> {
    const guard = await requireProjectConfig(projectPath, options)
    if (!guard.ok) return guard.result
    const config = guard.value
    const cycle = await this.activeCycle(config, projectPath, options)
    if (!cycle.ok) return cycle.result
    if (!id || !status) {
      return failWith(
        'Usage: prjct qa mark <ac-…|fl-…> <met|unmet|passed|failed|skipped> [--evidence "…"]',
        options
      )
    }
    const normalized = status.toLowerCase()
    const updated = id.startsWith('ac-')
      ? (CRITERION_STATUSES as readonly string[]).includes(normalized)
        ? markCriterion(config.projectId, cycle.value.id, id, {
            status: normalized as QaCriterionStatus,
            evidence: options.evidence,
            verifiedBy: 'author',
          })
        : undefined
      : (FLOW_STATUSES as readonly string[]).includes(normalized)
        ? markFlow(config.projectId, cycle.value.id, id, {
            status: normalized as QaFlowStatus,
            evidence: options.evidence,
            verifiedBy: 'author',
          })
        : undefined
    if (updated === undefined)
      return failWith(`"${status}" is not a valid status for ${id}.`, options)
    if (updated === null)
      return failWith(`No criterion/flow \`${id}\` in this cycle's QA plan.`, options)
    const msg = `${id} → ${normalized} (author-marked${effectiveQaMode(config) === 'strict' ? ' — strict needs a probe or the QA subagent to count it' : ''}).`
    if (options.md) console.log(mdOutput('## QA mark', `> ${msg}`))
    else out.done(msg)
    return { success: true, id, status: normalized }
  }

  private async receipt(projectPath: string, options: MdOption): Promise<CommandResult> {
    const guard = await requireProjectConfig(projectPath, options)
    if (!guard.ok) return guard.result
    const config = guard.value
    const task = await resolveActiveTask(config.projectId, projectPath).catch(() => null)
    const stamped = readQaReceipt(config.projectId, task?.id)
    if (!stamped) {
      const msg = 'No QA receipt yet — `prjct qa run`.'
      if (options.md) console.log(mdOutput('## QA receipt', `> ${msg}`))
      else out.info(msg)
      return { success: true, receipt: null }
    }
    console.log(options.md ? renderQaReceiptMd(stamped.data) : renderQaReceiptText(stamped.data))
    return { success: true, receipt: stamped.data }
  }
}

/** Exported for unit tests. */
export const _internal = { QA_MODES }
