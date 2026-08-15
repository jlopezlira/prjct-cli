/**
 * `prjct spec` — Spec-Driven Development primitive.
 *
 *   prjct spec "<title>"                    # create draft (Claude fills body)
 *   prjct spec list [--status <s>]          # ranked by created_at
 *   prjct spec show <id>                    # render one (--md for vault format)
 *   prjct spec update <id> --json '{...}'   # PATCH content (shallow merge, Zod-validated)
 *   prjct spec apply-delta <id> (--file <path> | --md '<delta>')  # canonical requirement/AC edits
 *   prjct spec set-status <id> <status>     # draft|reviewed|in_progress|shipped|archived
 *   prjct spec record-review <id> <reviewer> <pass|fail> --notes "..."
 *   prjct spec link-task <id> <task-id>
 *   prjct spec ship <id> [--pr <n>]
 *   prjct spec audit <id> [--strict]        # emits subagent dispatch prompt
 *   prjct spec validate <id> [--strict]     # structural validation (Phase 2)
 *
 * The CLI persists state. Claude does the structured drafting (asking the
 * forcing questions, populating acceptance_criteria) and the audit
 * subagent dispatch — see the `spec` and `audit-spec` verbs in the skill
 * body's intent map.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import configManager from '../infrastructure/config-manager'
import { renderAuditDispatch, selectReviewers } from '../services/spec-audit-dispatch'
import { renderSpecMarkdown, type SpecTaskState } from '../services/spec-markdown'
import { specService } from '../services/spec-service'
import { formatValidationLines, validateSpec } from '../services/spec-validate'
import { indexStorage } from '../storage/index-storage'
import { queueStorage } from '../storage/queue-storage'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { SPEC_STATUSES, type SpecContent, type SpecStatus } from '../types/spec'
import { failHard, failWith } from '../utils/md-aware'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

// Re-exported so existing importers (and tests) can reach the dispatch
// renderer through the command module; the impl lives in spec-audit-dispatch.
export { renderAuditDispatch }

interface SpecCmdOptions {
  md?: boolean
  status?: string
  json?: string | boolean
  notes?: string
  tags?: string
  pr?: number | string
  goal?: string
  /** Phase 1.6 / B-CTX: skip auto-inferring codebase context on draft. */
  skipContext?: boolean
}

export class SpecCommands extends PrjctCommandsBase {
  /**
   * Default verb: `prjct spec "<title>"` creates a new draft. The body
   * fields default to empty — Claude fills them via the skill's spec
   * intent flow. `--goal "..."` lets a CLI user pre-populate the goal.
   */
  async draft(
    title: string | null = null,
    projectPath: string = process.cwd(),
    options: SpecCmdOptions = {}
  ): Promise<CommandResult> {
    try {
      if (!title || !title.trim()) {
        out.info('Usage: prjct spec "<title>" [--goal "..."] [--tags k:v,...]')
        return { success: false, error: 'Title required' }
      }

      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const goal = options.goal?.trim() || title.trim()
      const tags = parseFlagTags(options.tags)

      const spec = await specService.create(projectPath, {
        title: title.trim(),
        content: { goal },
        tags,
        autoContext: !options.skipContext,
      })

      if (options.md) {
        console.log(
          `✓ spec drafted: ${spec.title}\n\nspec_id: ${spec.id}\nstatus: ${spec.status}\ngoal: ${spec.content.goal}\n\nNext: fill acceptance_criteria, scope, out_of_scope, risks, test_plan via \`prjct spec update ${spec.id} --json '{...}'\` then run \`prjct spec audit ${spec.id}\`.`
        )
      } else {
        out.done(`spec drafted: ${spec.title}`)
        out.info(`  id: ${spec.id}`)
        out.info(`  goal: ${spec.content.goal}`)
        out.info(`  next: prjct spec audit ${spec.id}`)
      }

      return { success: true, specId: spec.id, title: spec.title, status: spec.status }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }

  async list(
    _arg: string | null = null,
    projectPath: string = process.cwd(),
    options: SpecCmdOptions = {}
  ): Promise<CommandResult> {
    try {
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const status = options.status
      if (status && !(SPEC_STATUSES as readonly string[]).includes(status)) {
        return failWith(`unknown status: ${status} (valid: ${SPEC_STATUSES.join(', ')})`)
      }

      const specs = await specService.list(projectPath, {
        status: status as SpecStatus | undefined,
      })

      if (options.md) {
        if (specs.length === 0) {
          console.log('# Specs\n\n_No specs yet. Start one with `prjct spec "<title>"`._')
        } else {
          console.log('# Specs')
          for (const s of specs) {
            const ac = s.content.acceptance_criteria.length
            const tasks = s.content.linked_tasks.length
            console.log(
              `\n## ${s.title}\n- id: \`${s.id}\`\n- status: ${s.status}\n- acceptance criteria: ${ac}\n- linked tasks: ${tasks}\n- created: ${s.createdAt}`
            )
          }
        }
      } else {
        if (specs.length === 0) {
          out.info('no specs yet — `prjct spec "<title>"` to start one')
        } else {
          for (const s2 of specs) {
            const ac = s2.content.acceptance_criteria.length
            console.log(`  ${s2.status.padEnd(12)} ${s2.id.slice(0, 8)}  ${s2.title}  (${ac} AC)`)
          }
        }
      }

      return { success: true, count: specs.length }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }

  async show(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: SpecCmdOptions = {}
  ): Promise<CommandResult> {
    try {
      if (!id) return failWith('Usage: prjct spec show <id>')
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const spec = await specService.get(projectPath, id)
      if (!spec) return failWith(`spec not found: ${id}`)

      if (options.md) {
        // Queue state for the `## Tasks` checklist — keyed by AC text
        // (queue task `body`), restricted to rows of this spec.
        const showProjectId = await configManager.getProjectId(projectPath).catch(() => null)
        const taskStates = new Map<string, SpecTaskState>()
        if (showProjectId) {
          for (const t of await queueStorage.getTasks(showProjectId)) {
            if (t.featureId === spec.id && t.body != null) {
              taskStates.set(t.body, { id: t.id, completed: t.completed })
            }
          }
        }
        console.log(renderSpecMarkdown(spec, taskStates))
      } else {
        console.log(`# ${spec.title}`)
        console.log(`status: ${spec.status}`)
        console.log(`goal: ${spec.content.goal}`)
        if (spec.content.eli10) console.log(`eli10: ${spec.content.eli10}`)
        if (spec.content.acceptance_criteria.length > 0) {
          console.log('\nacceptance criteria:')
          for (const c of spec.content.acceptance_criteria) console.log(`  - ${c}`)
        }
        if (spec.content.scope.length > 0) {
          console.log('\nscope:')
          for (const c2 of spec.content.scope) console.log(`  - ${c2}`)
        }
        if (spec.content.out_of_scope.length > 0) {
          console.log('\nout of scope:')
          for (const c3 of spec.content.out_of_scope) console.log(`  - ${c3}`)
        }
        if (spec.content.risks.length > 0) {
          console.log('\nrisks:')
          for (const r of spec.content.risks) console.log(`  - ${r.risk} → ${r.mitigation}`)
        }
        if (spec.content.test_plan.length > 0) {
          console.log('\ntest plan:')
          for (const c4 of spec.content.test_plan) console.log(`  - ${c4}`)
        }
      }

      return { success: true, spec }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }

  /**
   * PATCH the spec content. Pass any subset of fields as JSON via --json;
   * fields you omit are PRESERVED from the existing spec, fields you
   * include REPLACE the existing value (shallow merge at top level).
   *
   * This avoids the wipe footgun where a partial payload (e.g. updating
   * just the goal) would silently zero out reviews / acceptance_criteria
   * / linked_tasks because their schema defaults are empty. PATCH-style
   * semantics match user expectation and dogfood reality — when Claude
   * iterates on a spec mid-audit, it shouldn't have to re-send every
   * field to keep the rest intact.
   */
  async update(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: SpecCmdOptions = {}
  ): Promise<CommandResult> {
    try {
      if (!id) return failWith('Usage: prjct spec update <id> --json \'{"goal": "...", ...}\'')
      const jsonInput = typeof options.json === 'string' ? options.json : ''
      if (!jsonInput) return failWith('--json is required')

      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const patch = (() => {
        try {
          return JSON.parse(jsonInput) as unknown
        } catch {
          return undefined
        }
      })()
      if (patch === undefined) return failWith('--json is not valid JSON')
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        return failWith('--json must decode to an object')
      }

      const existing = await specService.get(projectPath, id)
      if (!existing) return failWith(`spec not found: ${id}`)

      const updated = await specService.patch(projectPath, id, patch as Partial<SpecContent>)
      if (!updated) return failWith(`spec not found: ${id}`)

      if (options.md) console.log(`✓ spec updated: ${updated.title}`)
      else out.done(`spec updated: ${updated.title}`)
      return { success: true, specId: updated.id }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }

  /**
   * Apply an OpenSpec-subset delta (`## ADDED/MODIFIED/REMOVED Requirements`)
   * — the canonical path for requirement/AC changes. The delta markdown comes
   * from `--file <path>` or inline via `--md '<delta>'` (for this subverb
   * `--md` carries a payload; bare `--md` still selects markdown output).
   * Idempotent by delta id; MODIFIED/REMOVED target existing requirement
   * slugs. Body edits invalidate reviews and demote reviewed → draft.
   */
  async applyDelta(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean | string; file?: string } = {}
  ): Promise<CommandResult> {
    try {
      if (!id) {
        return failWith(
          "Usage: prjct spec apply-delta <id> (--file <path> | --md '<delta markdown>')"
        )
      }
      const inline = typeof options.md === 'string' ? options.md.trim() : ''
      const file = options.file?.trim() ?? ''
      if (!inline && !file) return failWith("provide --file <path> or --md '<delta markdown>'")
      if (inline && file) return failWith('pass either --file or --md, not both')

      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const markdown = file ? await fs.readFile(path.resolve(projectPath, file), 'utf8') : inline

      const updated = await specService.applyDelta(projectPath, id, markdown)
      if (!updated) return failWith(`spec not found: ${id}`)

      const msg = `✓ delta applied: ${updated.title} (${updated.content.delta_log.length} delta(s) logged)`
      if (options.md === true) console.log(msg)
      else out.done(msg)
      return { success: true, specId: updated.id }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }

  /**
   * `prjct spec validate <id> [--strict]` — structural validation of the
   * stored spec (Phase 2; rules + severities documented in
   * services/spec-validate.ts).
   *
   * Exit semantics: ERRORS fail the command in every mode; warnings are
   * advisory EXCEPT under `--strict`, which turns them into failures — the
   * established convention (`prjct guard --strict` does the same).
   */
  async validate(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: SpecCmdOptions & { strict?: boolean } = {}
  ): Promise<CommandResult> {
    try {
      if (!id) return failWith('Usage: prjct spec validate <id> [--strict]')
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const spec = await specService.get(projectPath, id)
      if (!spec) return failWith(`spec not found: ${id}`)

      const strict = options.strict === true
      const validation = validateSpec(spec, { projectPath })
      const failed = validation.errors.length > 0 || (strict && validation.warnings.length > 0)

      if (options.md) {
        console.log(`# spec validate — ${spec.title}`)
        console.log('')
        console.log(`spec id: \`${spec.id}\` · mode: ${strict ? 'strict' : 'advisory'}`)
        console.log('')
        if (validation.errors.length === 0 && validation.warnings.length === 0) {
          console.log('_No findings — structure OK._')
        } else {
          console.log('## Findings')
          for (const line of formatValidationLines(validation)) console.log(line)
        }
        console.log('')
        console.log(failed ? '**verdict: FAIL**' : '**verdict: PASS**')
      } else {
        for (const e of validation.errors) out.fail(e)
        for (const w of validation.warnings) out.warn(w)
        if (validation.errors.length === 0 && validation.warnings.length === 0) {
          out.done('spec structure OK')
        }
      }

      if (failed) {
        return {
          success: false,
          error: `spec validation failed: ${validation.errors.length} error(s), ${validation.warnings.length} warning(s)${strict ? ' (strict: warnings count as failures)' : ''}`,
          specId: id,
        }
      }
      return {
        success: true,
        specId: id,
        errors: validation.errors.length,
        warnings: validation.warnings.length,
      }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }

  async setStatus(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: SpecCmdOptions = {}
  ): Promise<CommandResult> {
    try {
      if (!id) return failWith('Usage: prjct spec set-status <id> <status>')
      const status = options.status
      if (!status || !(SPEC_STATUSES as readonly string[]).includes(status)) {
        return failWith(`status must be one of: ${SPEC_STATUSES.join(', ')}`)
      }

      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const next = await specService.setStatus(projectPath, id, status as SpecStatus)
      if (!next) return failWith(`spec not found: ${id}`)

      if (options.md) console.log(`✓ spec ${id} → ${status}`)
      else out.done(`spec status: ${status}`)
      return { success: true, specId: id, status }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }

  /**
   * Record a single reviewer's verdict from `audit-spec`. Claude calls
   * this after each subagent returns. When all three reviewers pass, the
   * service auto-promotes the spec from `draft` → `reviewed`.
   */
  async recordReview(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: SpecCmdOptions & { reviewer?: string; verdict?: string } = {}
  ): Promise<CommandResult> {
    try {
      if (!id) {
        return failWith(
          'Usage: prjct spec record-review <id> --reviewer <lens> --verdict <pass|fail> --notes "..."'
        )
      }
      // Open lens vocabulary — accept any non-empty lowercase token, not just
      // the fixed trio. The audit picks the lens set per spec dynamically.
      const reviewer = options.reviewer?.trim().toLowerCase()
      const verdict = options.verdict
      if (!reviewer) {
        return failWith('--reviewer is required (the lens name, e.g. architecture, security)')
      }
      if (verdict !== 'pass' && verdict !== 'fail') {
        return failWith('--verdict must be `pass` or `fail`')
      }

      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const updated = await specService.recordReview(projectPath, id, reviewer, {
        verdict,
        notes: options.notes ?? '',
      })
      if (!updated) return failWith(`spec not found: ${id}`)

      // Light guard: warn (don't fail) if the lens wasn't in the audit's
      // selected set — a typo'd lens would never satisfy the promote gate.
      const selected = updated.content.selected_reviewers
      if (selected.length > 0 && !selected.includes(reviewer)) {
        out.warn(`lens "${reviewer}" is not in this spec's selected set (${selected.join(', ')})`)
      }

      const msg = `${reviewer} → ${verdict}${updated.status === 'reviewed' ? ' (all selected lenses passed → status: reviewed)' : ''}`
      if (options.md) console.log(`✓ ${msg}`)
      else out.done(msg)
      return { success: true, specId: id, status: updated.status }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }

  async linkTask(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: SpecCmdOptions & { taskId?: string } = {}
  ): Promise<CommandResult> {
    try {
      if (!id || !options.taskId) {
        return failWith('Usage: prjct spec link-task <spec-id> --task-id <id>')
      }
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const updated = await specService.linkTask(projectPath, id, options.taskId)
      if (!updated) return failWith(`spec not found: ${id}`)

      if (options.md) console.log(`✓ linked task ${options.taskId} to spec ${id}`)
      else out.done(`linked task → spec`)
      return { success: true, specId: id, taskId: options.taskId }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }

  async ship(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: SpecCmdOptions = {}
  ): Promise<CommandResult> {
    try {
      if (!id) return failWith('Usage: prjct spec ship <id> [--pr <number>]')
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const pr = options.pr !== undefined ? Number(options.pr) : undefined
      const next = await specService.ship(
        projectPath,
        id,
        pr !== undefined && Number.isFinite(pr) ? pr : undefined
      )
      if (!next) return failWith(`spec not found: ${id}`)

      if (options.md) console.log(`✓ spec shipped: ${next.title}${pr ? ` (PR #${pr})` : ''}`)
      else out.done(`spec shipped${pr ? ` (PR #${pr})` : ''}`)
      return { success: true, specId: id, status: 'shipped' }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }

  /**
   * Emits the dispatch prompt for Claude to run three review subagents
   * in parallel via the Agent tool. Claude reads this output, dispatches,
   * then writes each verdict back via `prjct spec record-review`.
   *
   * No subagent dispatch happens HERE — the CLI doesn't have an LLM. The
   * dispatch lives in Claude's tool use, exactly like the existing
   * `audit` workflow in the skill body.
   */
  async audit(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: SpecCmdOptions & { lenses?: string; strict?: boolean } = {}
  ): Promise<CommandResult> {
    try {
      if (!id) return failWith('Usage: prjct spec audit <id> [--lenses a,b,c] [--strict]')
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const spec = await specService.get(projectPath, id)
      if (!spec) return failWith(`spec not found: ${id}`)

      // Phase 2: structural validation BEFORE the dispatch. ERRORS block the
      // dispatch under `--strict` or SDD mode=strict; otherwise every finding
      // prints as an advisory block above the dispatch. Warnings never block.
      const validation = validateSpec(spec, { projectPath })
      if (validation.errors.length > 0 || validation.warnings.length > 0) {
        const { effectiveSddMode } = await import('./sdd')
        const auditCfg = await configManager.readConfig(projectPath).catch(() => null)
        const strictGate = options.strict === true || effectiveSddMode(auditCfg) === 'strict'
        const blocked = strictGate && validation.errors.length > 0
        console.log(
          blocked
            ? '## spec validation — dispatch BLOCKED (strict)\n'
            : '## spec validation (advisory)\n'
        )
        for (const line of formatValidationLines(validation)) console.log(line)
        console.log('')
        if (blocked) {
          return failWith(
            `spec validation: ${validation.errors.length} error(s) block the audit dispatch in strict mode — fix the spec (see \`prjct spec validate ${id}\`) or drop strict gating`
          )
        }
      }

      // Dynamic lenses: `--lenses` overrides; otherwise prjct computes a
      // deterministic baseline from the spec. Persist the chosen set so the
      // auto-promote gate (`reviewsGatePassed`) knows what to expect.
      // Domain experts: the project's own discovered domains, so a change that
      // touches `auth`/`billing`/… composes that domain's specialist alongside
      // the function lenses. Best-effort — none/no-index ⇒ function lenses only.
      const auditProjectId = await configManager.getProjectId(projectPath).catch(() => null)
      const domains = auditProjectId
        ? (indexStorage.readDomainsSync(auditProjectId)?.domains ?? [])
        : []
      const lenses =
        typeof options.lenses === 'string' && options.lenses.trim() !== ''
          ? options.lenses
              .split(',')
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean)
          : selectReviewers(spec.content, domains)
      await specService.setSelectedReviewers(projectPath, id, lenses)

      const dispatch = await renderAuditDispatch(
        spec.id,
        spec.title,
        spec.content,
        lenses,
        undefined,
        domains
      )
      console.log(dispatch)
      return { success: true, specId: id, dispatch: 'emitted' }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }

  /**
   * `prjct spec breakdown <id> [--force]` — manual recovery / re-trigger
   * for breakdownSpecToTasks. Idempotent on tasks_created_at; safe to
   * call repeatedly. Default gate: status='reviewed' or later. `--force`
   * bypass emits an audit event (`type=spec.breakdown.forced`) and
   * echoes the resulting mem id on stdout.
   *
   * See spec a50b32d1 AC #14.
   */
  async breakdown(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: SpecCmdOptions & { force?: boolean } = {}
  ): Promise<CommandResult> {
    try {
      if (!id) return failWith('Usage: prjct spec breakdown <id> [--force]')
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const spec = await specService.get(projectPath, id)
      if (!spec) return failWith(`spec not found: ${id}`)

      const GATED_STATES = new Set<SpecStatus>(['reviewed', 'shipped', 'archived'])
      if (!GATED_STATES.has(spec.status as SpecStatus) && options.force !== true) {
        process.stderr.write(
          `error: spec status is '${spec.status}'; breakdown requires 'reviewed' or later. Re-run with --force if intentional.\n`
        )
        process.exitCode = 2
        return {
          success: false,
          error: `spec status '${spec.status}' is below the breakdown gate`,
        }
      }

      const forced = options.force === true && !GATED_STATES.has(spec.status as SpecStatus)
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) return failHard('No prjct project. Run `prjct init` first.')
      const { breakdownSpecToTasks } = await import('../services/spec-task-breakdown')
      const result = await breakdownSpecToTasks(projectId, projectPath, spec)

      const forcedEventMemId = await (async (): Promise<string | null> => {
        if (!forced) return null
        // Audit event so a forced breakdown shows up in `prjct context
        // memory spec` and the event log. Free-form `type` string per
        // publishEvent semantics.
        const { projectMemory } = await import('../memory/project-memory')
        const memId = await projectMemory.remember(projectPath, {
          type: 'spec',
          content: `prjct spec breakdown --force on '${spec.title}' (status was '${spec.status}')`,
          tags: {
            spec_id: spec.id,
            event: 'spec.breakdown.forced',
            from_status: spec.status,
          },
          source: spec.id,
        })
        return typeof memId === 'string' ? memId : null
      })()

      const lines: string[] = []
      if (forcedEventMemId) lines.push(`forced-breakdown event=${forcedEventMemId}`)
      if (result.skippedReason === 'already_broken_down') {
        lines.push(`skipped: already_broken_down (spec ${id})`)
      } else if (result.skippedReason === 'no_acceptance_criteria') {
        lines.push(`skipped: no_acceptance_criteria (spec ${id})`)
      } else {
        const tag = result.recoveredFromPartial ? ' (recovered from partial)' : ''
        lines.push(`✓ breakdown: ${result.taskIds.length} task(s) linked${tag}`)
      }
      for (const line of lines) console.log(line)

      return {
        success: true,
        specId: id,
        forced,
        forcedEventMemId,
        taskIds: result.taskIds,
        recoveredFromPartial: result.recoveredFromPartial === true,
        skippedReason: result.skippedReason,
      }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }

  /**
   * `prjct spec inventory [--md|--json]` — coverage map per module +
   * drift detection over shipped specs (Phase 1.6 / B-INV).
   *
   * Drift definition: shipped specs whose scope[] paths accumulated
   * >5 LOC of NON-cosmetic changes between shipped_sha and HEAD.
   * Shipped specs without shipped_sha (legacy) report drift=unknown.
   */
  async inventory(
    _arg: string | null = null,
    projectPath: string = process.cwd(),
    options: SpecCmdOptions = {}
  ): Promise<CommandResult> {
    try {
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const { default: configManager } = await import('../infrastructure/config-manager')
      const cfg = await configManager.readConfig(projectPath)
      const projectId = cfg?.projectId
      if (!projectId) return failWith('not a prjct project')

      const { buildInventory, renderInventoryMd } = await import('../services/spec-inventory')
      const report = await buildInventory(projectPath, projectId)

      if (options.json) {
        console.log(JSON.stringify(report, null, 2))
      } else if (options.md) {
        console.log(renderInventoryMd(report))
      } else {
        // Compact human-readable summary (no flag).
        out.info(`${report.totalSpecs} specs across ${report.modules.length} modules`)
        for (const m of report.modules) {
          const pct = m.coveredPct === null ? 'n/a' : `${m.coveredPct}%`
          const drift = m.drift === true ? ' DRIFT' : m.drift === 'unknown' ? ' ?' : ''
          console.log(
            `  ${m.module.padEnd(20)} ${String(m.specCount).padStart(3)} specs · ${pct.padStart(6)} covered${drift}`
          )
        }
        if (report.uncoveredModules.length > 0) {
          out.info(`${report.uncoveredModules.length} module(s) without specs`)
        }
      }
      return { success: true, totalSpecs: report.totalSpecs }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }
}

function parseFlagTags(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  const tags: Record<string, string> = {}
  for (const token of raw.split(',')) {
    const pair = token.trim()
    const idx = pair.indexOf(':')
    if (idx > 0) tags[pair.slice(0, idx)] = pair.slice(idx + 1)
  }
  return tags
}
