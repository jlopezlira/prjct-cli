/**
 * Shipping Commands — workflow-first dispatcher.
 *
 * ship() has no hardcoded "code pipeline". Version bump, changelog,
 * git commit/push all live as rules in the workflow table (seeded
 * per-project at init based on stack detection). Non-code projects
 * get no rules and ship just records a shipped_features row.
 *
 * If no step rules exist and the project doesn't auto-seed as code,
 * we return a `clarification` instead of acting — the agent is
 * expected to ask the user and re-invoke with an explicit intent.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import configManager from '../infrastructure/config-manager'
import { defaultPrConventionFor, detectPrConventionSignal } from '../services/pr-convention'
import { syncService } from '../services/sync-service'
import { completeActiveTask, resolveActiveTask } from '../services/task-service'
import { assertRemoteDefaultBranchIncluded } from '../services/version-service'
import { getGitBranch } from '../session/git-helpers'
import { customWorkflowStorage } from '../storage/custom-workflow-storage'
import { prjctDb } from '../storage/database'
import { shippedStorage } from '../storage/shipped-storage'
import { workflowRuleStorage } from '../storage/workflow-rule-storage'
import type { CommandClarification, CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import type { WorkflowRule } from '../types/storage/extended'
import type { WorkflowRunContext } from '../types/workflow.js'
import * as dateHelper from '../utils/date-helper'
import { GitInfraError } from '../utils/exec'
import { failFromError } from '../utils/md-aware'
import { mdDone, mdList, mdNextSteps, mdOutput, mdSection } from '../utils/md-formatter'
import { getNextSteps, showNextSteps } from '../utils/next-steps'
import out from '../utils/output'
import { detectProjectCommands } from '../utils/project-commands'
import { executeWorkflowRules } from '../workflow-engine/workflow-engine'
import { PrjctCommandsBase } from './base'
import { requireProject } from './guards'

// kv marker written before the shipped row is recorded and cleared after.
// If a ship pushes a version (via the before-rules) but crashes before
// `addShipped`, this marker survives → the NEXT ship reconciles it
// idempotently, closing the version-divergence class (mem_2920).
const SHIP_MARKER_KEY = 'ship:in_progress'

interface ShipMarker {
  feature: string
  version: string
  startedAt: string
}

type ShipIntent =
  | 'register-only'
  | 'seed-code-workflow'
  | 'proceed'
  | 'pr-convention-auto'
  | 'pr-convention-manual'

interface ShipOptions {
  skipHooks?: boolean
  md?: boolean
  intent?: ShipIntent
  /** SDD: skip the spec acceptance gate (use only on explicit user override) */
  noSpecGate?: boolean
  /** TDD: skip the test gate surfaced in strict mode (explicit override) */
  noTestGate?: boolean
  /** Package legitimacy: allow ship with new deps vs HEAD (explicit consent) */
  allowNewDeps?: boolean
  /** Context-pressure critical: force ship despite hard gate (explicit consent) */
  forcePressure?: boolean
  /** Delivery geometry decision for large diffs (explicit consent) */
  geometry?: 'direct' | 'single' | 'split'
  /** Skip precision-judgment ledger gate (explicit consent — not --no-spec-gate) */
  noJudgmentGate?: boolean
  /** Skip the machine gauntlet gate (explicit consent — the override is recorded) */
  noGauntlet?: boolean
}

export class ShippingCommands extends PrjctCommandsBase {
  async ship(
    feature: string | null,
    projectPath: string = process.cwd(),
    options: ShipOptions = {}
  ): Promise<CommandResult> {
    try {
      const proj = await requireProject(projectPath)
      if (!proj.ok) return proj.result
      const projectId = proj.value

      // B1: delivery kill switch — removes mutation path without fake approval.
      // Outranks --no-judgment-gate / --no-spec-gate / --force-pressure.
      try {
        const shipConfigEarly = await configManager.readConfig(projectPath)
        if (shipConfigEarly?.delivery?.killSwitch === 'on') {
          return {
            success: false,
            error:
              'Delivery kill-switch ON — mutation path removed. ' +
              'Lift only by setting `delivery.killSwitch` to `off` in `.prjct/prjct.config.json` ' +
              '(not via --no-judgment-gate / --no-spec-gate).',
          }
        }
      } catch {
        /* config read best-effort — never invent kill-on from a bad read */
      }

      // Crash recovery: a prior ship that pushed a version but died before
      // recording the shipped row left a marker. Reconcile it idempotently
      // (skip if that version is already recorded) before doing anything.
      try {
        const stale = prjctDb.getDoc<ShipMarker>(projectId, SHIP_MARKER_KEY)
        if (stale?.version) {
          const already = await shippedStorage.getByVersion(projectId, stale.version)
          if (!already) {
            await shippedStorage.addShipped(projectId, {
              name: stale.feature,
              version: stale.version,
            })
            console.log(`ℹ️  Reconciled an interrupted ship: ${stale.feature} (v${stale.version})`)
          }
          prjctDb.deleteDoc(projectId, SHIP_MARKER_KEY)
        }
      } catch {
        // Best-effort recovery — never block a ship on reconciliation.
      }

      // Resolve the task for THIS worktree first. Hard gates run BEFORE
      // completeActiveTask so a blocked ship does not silently close the cycle.
      const currentTask = await resolveActiveTask(projectId, projectPath)
      const linkedSpecId = currentTask?.linkedSpecId
      const taskFeatureName =
        normalizeShipFeature(feature) ?? normalizeShipFeature(currentTask?.description ?? null)

      // SDD strict gate (opt-in via config.sdd.mode === 'strict'): refuse to
      // ship work with no linked spec — the pipeline is mandatory in strict.
      // advisory/off never block here. `--no-spec-gate` is the override.
      const shipConfig = await configManager.readConfig(projectPath).catch(() => null)
      if (!options.noSpecGate && !linkedSpecId) {
        try {
          const { effectiveSddMode } = await import('./sdd')
          if (effectiveSddMode(shipConfig) === 'strict') {
            return {
              success: false,
              error:
                'Strict SDD: this work has no linked intent/spec. Start it via `prjct intent` → `audit-spec` → `prjct work --spec <id>`, or override with `prjct ship --no-spec-gate`.',
            }
          }
        } catch {
          // best-effort — never crash ship on the gate lookup
        }
      }

      // Package legitimacy (SUPERIOR to GSD slopcheck): new deps vs HEAD.
      // Override is `--allow-new-deps` only — never shared with `--no-spec-gate`.
      try {
        const { checkPackageLegitimacy } = await import('../services/package-legitimacy')
        const pkg = await checkPackageLegitimacy(projectPath)
        if (pkg.risky && pkg.message) {
          const hard =
            shipConfig?.sdd?.mode === 'strict' ||
            shipConfig?.tdd?.mode === 'strict' ||
            shipConfig?.deliveryGeometry?.mode === 'strict'
          if (hard && !options.allowNewDeps) {
            return {
              success: false,
              error: `${pkg.message}\nOverride only with explicit consent: verify packages, then \`prjct ship --allow-new-deps\`.`,
            }
          }
          console.log(`⚠️  ${pkg.message}`)
        }
      } catch {
        /* package check is best-effort */
      }

      // Context-density soft gate — default does NOT kill sessions or block ship.
      // Opt-in hard block: config.contextPressure.hardBlockShip + critical.
      try {
        const { contextPressureBlocksExpansion, contextPressureVerdict } = await import(
          '../services/context-pressure'
        )
        const pressure = contextPressureVerdict(shipConfig, {
          turnCount: currentTask?.turnCount,
          tokensIn: currentTask?.tokensIn,
          tokensOut: currentTask?.tokensOut,
          description: currentTask?.description,
        })
        if (contextPressureBlocksExpansion(pressure, shipConfig) && !options.forcePressure) {
          return {
            success: false,
            error:
              pressure.cue ??
              'Context density hard-block is enabled (contextPressure.hardBlockShip). Soften injection or pass --force-pressure with consent.',
          }
        }
        if ((pressure.level === 'warn' || pressure.level === 'critical') && pressure.cue) {
          console.log(pressure.cue)
        }
      } catch {
        /* pressure gate best-effort */
      }

      // Delivery geometry at ship — large committed diffs need an explicit strategy.
      const geomMode = shipConfig?.deliveryGeometry?.mode ?? 'off'
      try {
        const { computeCommittedChangeset, shipGeometryVerdict } = await import(
          '../services/delivery-geometry'
        )
        const cs = await computeCommittedChangeset(projectPath)
        const gv = shipGeometryVerdict({
          changeset: cs,
          mode: geomMode,
          explicitGeometry: options.geometry ?? null,
          locThreshold: shipConfig?.deliveryGeometry?.locThreshold,
        })
        if (gv.blocked) {
          return { success: false, error: gv.message ?? 'Delivery geometry gate blocked ship.' }
        }
        if (gv.message) console.log(gv.message)
      } catch (err) {
        // Strict mode must not fail open when the changeset is unevaluable:
        // a git infra failure blocks with the cause instead of silently
        // passing the gate. Advisory/off stay best-effort.
        if (geomMode === 'strict' && err instanceof GitInfraError) {
          return {
            success: false,
            error: `Delivery geometry gate unevaluable: ${err.message}. Re-run when git is healthy, or ship with explicit \`--geometry\`.`,
          }
        }
        /* geometry best-effort */
      }

      // Structural code-graph risk (advisory; hard only when deliveryGeometry=strict
      // AND critical fan-in — never surprises default ships).
      try {
        const { hasSymbolIndex } = await import('../domain/symbol-graph')
        if (hasSymbolIndex(projectId)) {
          const { detectChanges, shipStructuralRiskCue } = await import(
            '../services/detect-changes'
          )
          const det = await detectChanges(projectPath, projectId, { source: 'auto' })
          const cue = shipStructuralRiskCue(det)
          if (cue) console.log(cue)
          const geomMode = shipConfig?.deliveryGeometry?.mode ?? 'off'
          if (
            geomMode === 'strict' &&
            det.summary.critical > 0 &&
            !options.geometry &&
            !options.allowNewDeps
          ) {
            // Soft-block only when geometry is already strict and critical structural risk.
            // Override: pass --geometry single|split|direct explicitly.
            return {
              success: false,
              error: `Strict delivery geometry + structural CRITICAL risk (${det.summary.critical} file(s), blast ${det.affectedFiles.length}). Review \`prjct code impact --md\`, then re-ship with explicit \`--geometry single|split|direct\`.`,
            }
          }
        }
      } catch (err) {
        // Advisory cue stays fail-open, but a git infra failure is surfaced
        // — never a silent "no structural risk" on a sick git.
        if (err instanceof GitInfraError) {
          console.log(`⚠️  Structural risk cue unavailable: ${err.message}`)
        }
        /* structural risk best-effort */
      }

      // Precision-gated judgment ship gate (human-invoked ship only — never
      // auto-ship). Intensity standard|full hard-blocks without ledger.approved.
      // Override: --no-judgment-gate only (consent-scoped; not --no-spec-gate).
      // code-strict pack forces dual-blind (full) intensity when quality applies.
      const packs = shipConfig?.persona?.packs ?? []
      const isCodeStrictPack = packs.includes('code-strict')
      try {
        const { intensityFromChangeset, judgmentShipVerdict } = await import(
          '../services/precision-judgment'
        )
        const { shipRequiresQuality } = await import('../services/judgment-orchestrator')
        const { computeCommittedChangeset } = await import('../services/delivery-geometry')
        const { judgmentLedgerStorage } = await import('../storage/judgment-ledger-storage')
        const cs = await computeCommittedChangeset(projectPath)
        const signals = {
          harnessLevel: currentTask?.harness?.level,
          harnessKind: currentTask?.harness?.kind,
        }
        const inferredIntensity = intensityFromChangeset(
          { files: cs?.files ?? 0, loc: cs?.loc ?? 0 },
          signals
        ).intensity
        // SUPERIOR: code-strict ALWAYS dual-blind (full) — even trivial diffs.
        // Ship-grade packs never skip the judgment ledger.
        const intensity = isCodeStrictPack ? 'full' : inferredIntensity
        // Hard gate for any non-skip intensity; pack code-strict always hard.
        const codeStrict = isCodeStrictPack || shipRequiresQuality(intensity)
        const ledger = judgmentLedgerStorage.get(projectId)
        const jv = judgmentShipVerdict({
          codeStrict,
          intensity,
          ledger,
          override: Boolean(options.noJudgmentGate),
        })
        if (jv.blocked) {
          return { success: false, error: jv.message }
        }
        if (jv.message) console.log(jv.message)

        // Content-bound stamp (Dynasty D2 + A1): under code-strict, approved
        // judgment without a stamp hard-blocks; with a stamp, post-approve
        // edits force re-judgment. Override: --no-judgment-gate only.
        if (codeStrict && !options.noJudgmentGate && jv.reason === 'approved') {
          try {
            const { contentBoundDriftVerdict, currentTreeHashForStamp } = await import(
              '../services/content-bound-stamp'
            )
            const stamp = ledger?.contentBound
            const current = stamp?.treeHash
              ? await currentTreeHashForStamp(projectPath, stamp)
              : null
            const cv = contentBoundDriftVerdict({
              stamp: stamp ?? null,
              currentTreeHash: current,
              hard: true,
              override: false,
            })
            if (cv.blocked) {
              return { success: false, error: cv.message }
            }
            if (cv.message) console.log(cv.message)
          } catch (err) {
            // Git infra must not fail-open the content-bound gate under
            // code-strict packs (null treeHash used to mean "unverified → pass").
            if (err instanceof GitInfraError) {
              return {
                success: false,
                error: `Content-bound stamp unevaluable: ${err.message}. Re-run when git is healthy, or override with \`--no-judgment-gate\`.`,
              }
            }
            /* non-infra: best-effort */
          }
        } else if (ledger?.contentBound?.treeHash && !options.noJudgmentGate) {
          // Non-strict: keep advisory drift check when a stamp exists.
          try {
            const { contentBoundDriftVerdict, currentTreeHashForStamp } = await import(
              '../services/content-bound-stamp'
            )
            const current = await currentTreeHashForStamp(projectPath, ledger.contentBound)
            const cv = contentBoundDriftVerdict({
              stamp: ledger.contentBound,
              currentTreeHash: current,
              hard: false,
              override: false,
            })
            if (cv.message) console.log(cv.message)
          } catch {
            /* best-effort */
          }
        }
      } catch (err) {
        // A hard judgment gate (code-strict pack) must not fail open when
        // the changeset is unevaluable — block with the cause. Everything
        // else stays best-effort and never crashes ship on lookup.
        if (isCodeStrictPack && err instanceof GitInfraError) {
          return {
            success: false,
            error: `Judgment ship gate unevaluable: ${err.message}. Re-run when git is healthy, or override with \`--no-judgment-gate\`.`,
          }
        }
        /* judgment gate is best-effort — never crash ship on lookup */
      }

      // Machine gauntlet (Uncle Bob): the work counts when the machine says
      // so. A fresh RED receipt always blocks; missing/stale blocks under
      // code-strict and warns otherwise; --no-gauntlet overrides, recorded.
      try {
        const {
          gauntletShipVerdict,
          projectHasGauntletCommands,
          readGauntletReceipt,
          recordGauntletOverride,
        } = await import('../services/gauntlet')
        const { gitStdout } = await import('../utils/exec')
        const headNow = await gitStdout(projectPath, ['rev-parse', 'HEAD'])
          .then((s) => s?.trim() || null)
          .catch(() => null)
        const stamped = readGauntletReceipt(projectId)
        const verdict = gauntletShipVerdict({
          receipt: stamped?.data ?? null,
          nowMs: Date.now(),
          headSha: headNow,
          hasCommands: await projectHasGauntletCommands(projectPath),
          strict: isCodeStrictPack,
          override: options.noGauntlet === true,
        })
        if (options.noGauntlet === true) recordGauntletOverride(projectId)
        if (verdict.blocked) {
          return { success: false, error: verdict.message ?? 'Machine gauntlet gate blocked.' }
        }
        if (verdict.message) console.log(verdict.message)
      } catch {
        /* gauntlet gate is best-effort — never crash ship on lookup */
      }

      // Gates passed — complete the task for THIS worktree (main → currentTask,
      // child worktree → its activeTasks[] slot) so parallel agents ship their
      // own work without disturbing sibling worktrees.
      if (currentTask) {
        await completeActiveTask(projectId, projectPath)
      }

      // SDD acceptance gate: surface the linked spec's acceptance_criteria
      // before ship proceeds. The CLI doesn't decide whether each criterion
      // is met — Claude (or the human) does, per the skill body's `ship`
      // entry. Without --no-spec-gate, we surface and continue; the agent
      // is responsible for halting if any criterion is unmet.
      if (linkedSpecId && !options.noSpecGate) {
        try {
          const { specService } = await import('../services/spec-service')
          const spec = await specService.get(projectPath, linkedSpecId)
          if (spec && spec.content.acceptance_criteria.length > 0) {
            const lines: string[] = []
            lines.push('')
            lines.push(`## Spec acceptance gate — \`${spec.title}\` (${spec.id.slice(0, 8)})`)
            lines.push('')
            lines.push('Walk each criterion. STOP if any is unmet.')
            lines.push('')
            for (const c of spec.content.acceptance_criteria) {
              lines.push(`- [ ] ${c}`)
            }
            lines.push('')
            lines.push('Override (only with explicit user consent): `prjct ship --no-spec-gate`.')
            lines.push('')
            console.log(lines.join('\n'))

            // Also link the eventual PR back to the spec when the user runs
            // `prjct spec ship <id> --pr <n>` after merge — out of scope for
            // this verb; the wiring lives on the spec command instead.
          }
        } catch {
          // ignore — spec lookup is best-effort
        }
      }

      // TDD gate (opt-in via config.tdd.mode): in `strict`, surface a hard
      // reminder to run the project's tests before shipping. Mirrors the spec
      // gate above — the CLI surfaces, the agent honours (running the real
      // red/green via `prjct tdd check`). `assist` is a softer nudge; `off`
      // (the default) is silent. `--no-test-gate` is the explicit override.
      if (!options.noTestGate) {
        try {
          const { effectiveTddMode } = await import('./tdd')
          const tddConfig = await configManager.readConfig(projectPath).catch(() => null)
          const tddMode = effectiveTddMode(tddConfig)
          if (tddMode !== 'off') {
            const detected = await detectProjectCommands(projectPath).catch(() => null)
            const testCmd = detected?.test?.command
            const lines: string[] = ['']
            if (tddMode === 'strict') {
              lines.push('## TDD gate (strict) — tests must be green before ship')
              lines.push('')
              lines.push(
                testCmd
                  ? `Run \`prjct tdd check\` (\`${testCmd}\`). STOP and fix if RED.`
                  : 'No test command detected — add tests (strict TDD expects them).'
              )
              lines.push('Override (only with explicit user consent): `prjct ship --no-test-gate`.')
            } else {
              lines.push('## TDD reminder (assist)')
              lines.push('')
              lines.push(
                testCmd
                  ? `Did the change ship with tests? Verify green: \`prjct tdd check\` (\`${testCmd}\`).`
                  : 'Consider adding a test for this change.'
              )
            }
            lines.push('')
            console.log(lines.join('\n'))
          }
        } catch {
          // ignore — TDD gate is best-effort surfacing
        }
      }

      const initialRules = workflowRuleStorage.getRulesForCommand(projectId, 'ship')

      // If the caller explicitly asked to seed, do it up front and continue.
      const explicitlySeeded =
        options.intent === 'seed-code-workflow'
          ? await seedCodeShipRules(projectId, projectPath)
          : null
      if (explicitlySeeded === false) {
        return {
          success: false,
          error:
            'seed-code-workflow requested but this project does not look like code (no package.json / Cargo.toml / pyproject.toml / VERSION). Add rules manually with `prjct workflow add`.',
        }
      }
      const rulesAfterExplicitSeed =
        explicitlySeeded === true
          ? workflowRuleStorage.getRulesForCommand(projectId, 'ship')
          : initialRules

      // Migration path: first ship on an existing code project that
      // predates workflow-first seeding. Silent — log a one-liner so
      // users see what happened.
      const hasSteps = rulesAfterExplicitSeed.some(
        (rule) => rule.type === 'step' && rule.position === 'before'
      )
      const autoSeeded =
        !hasSteps && options.intent !== 'register-only'
          ? await seedCodeShipRules(projectId, projectPath)
          : false
      if (autoSeeded) {
        console.log('ℹ️  Auto-seeded code ship workflow (one-time migration)')
      }
      const rulesAfterAutoSeed = autoSeeded
        ? workflowRuleStorage.getRulesForCommand(projectId, 'ship')
        : rulesAfterExplicitSeed

      // If the caller just answered the PR-convention backfill question
      // (Case 3.5 below), persist it and — for 'auto' — add the missing
      // pr:ensure step now, same "handle intent, then re-fetch" pattern
      // as seed-code-workflow above.
      const prConventionIntent =
        options.intent === 'pr-convention-auto'
          ? 'auto'
          : options.intent === 'pr-convention-manual'
            ? 'manual'
            : null
      if (prConventionIntent) {
        applyPrConventionDecision(projectId, prConventionIntent, rulesAfterAutoSeed)
      }
      const rules = prConventionIntent
        ? workflowRuleStorage.getRulesForCommand(projectId, 'ship')
        : rulesAfterAutoSeed

      // Ambiguity gate. Only triggers when the caller did NOT pass an
      // explicit intent — callers that have already asked the user
      // (e.g. re-invocation with --intent) skip the gate.
      const clarification = await buildClarification(projectId, projectPath, rules, options)
      if (clarification) {
        renderClarification(clarification, options.md === true)
        return { success: false, clarification }
      }

      // Precedence: explicit argument → feature branch → active cycle.
      //
      // The active cycle used to outrank the branch, so a ship inherited
      // whatever cycle happened to be open — which is routinely stale. That
      // released work under a months-old cycle title for a change
      // about model selection, and wrote that title into the PR, the commit,
      // and the CHANGELOG. The branch names the unit actually being shipped;
      // `inferShipFeatureFromBranch` returns null on main/master, so the cycle
      // description still covers shipping from a trunk branch.
      const featureName =
        normalizeShipFeature(feature) ??
        (await inferShipFeatureFromBranch(projectPath)) ??
        taskFeatureName
      if (!featureName) {
        return {
          success: false,
          error:
            'Ship needs a release description. Pass one explicitly, e.g. `prjct ship "add universal agent compatibility"`, or ship from a named feature branch.',
        }
      }

      const hasVersionBump = rules.some(
        (rule) =>
          rule.type === 'step' &&
          rule.position === 'before' &&
          rule.action.startsWith('version:bump')
      )
      if (hasVersionBump) await assertRemoteDefaultBranchIncluded(projectPath)

      const runCtx: WorkflowRunContext = { feature: featureName }

      const beforeResult = await executeWorkflowRules(projectId, 'ship', 'before', {
        projectPath,
        skipRules: options.skipHooks,
        runContext: runCtx,
      })
      if (!beforeResult.success) {
        const failedList =
          beforeResult.gatesFailed.length > 0 ? beforeResult.gatesFailed.join(', ') : 'unknown step'
        return { success: false, error: `Ship blocked: ${failedList}` }
      }

      const newVersion = typeof runCtx.version === 'string' ? runCtx.version : 'unversioned'

      // The before-rules have already pushed `newVersion`. Drop a marker so
      // a crash between here and `addShipped` is recoverable on the next
      // ship; clear it once the shipped row is durably recorded.
      try {
        prjctDb.setDoc<ShipMarker>(projectId, SHIP_MARKER_KEY, {
          feature: featureName,
          version: newVersion,
          startedAt: dateHelper.getTimestamp(),
        })
      } catch {
        // marker is best-effort — never block the ship
      }

      await shippedStorage.addShipped(projectId, {
        name: featureName,
        version: newVersion,
      })

      try {
        prjctDb.deleteDoc(projectId, SHIP_MARKER_KEY)
      } catch {
        // stale marker is harmless — next ship reconciles it as a no-op
        // (getByVersion finds the row we just wrote → skip)
      }

      // Stamp the shipped work cycle in the typed `tasks` table. `prjct
      // product` counts shipped cycles via `shipped_at IS NOT NULL` — nothing
      // ever wrote that column, so the count sat at 0 forever. Best-effort:
      // a ship without an active cycle simply has no row to stamp.
      if (currentTask) {
        try {
          prjctDb.run(
            projectId,
            'UPDATE tasks SET shipped_at = ? WHERE id = ?',
            dateHelper.getTimestamp(),
            currentTask.id
          )
        } catch {
          /* mirror column only — never block a ship */
        }
      }

      await this.logToMemory(projectPath, 'feature_shipped', {
        feature: featureName,
        version: newVersion,
        timestamp: dateHelper.getTimestamp(),
      })

      const afterResult = await executeWorkflowRules(projectId, 'ship', 'after', {
        projectPath,
        skipRules: options.skipHooks,
        runContext: runCtx,
      })

      const allInstructions = [...beforeResult.instructions, ...afterResult.instructions]

      try {
        await syncService.sync(projectPath)
      } catch (syncError) {
        console.warn('⚠️  Failed to sync AI context after shipping:', getErrorMessage(syncError))
      }

      const stepsRun = beforeResult.stepsRun.length + afterResult.stepsRun.length

      // Ship-success reinforcement: every memory surfaced during this task
      // just fed work that actually shipped — give it the strong usefulness
      // credit so it ranks higher in future recall. Best-effort; a completed
      // ship must never fail on reinforcement bookkeeping.
      if (currentTask?.id) {
        try {
          const { usefulnessService } = await import('../services/usefulness')
          usefulnessService.creditShippedTask(projectId, currentTask.id)
        } catch {
          /* best-effort */
        }
      }

      // Compound after ship: judgment receipt so closed-loop metrics move on
      // the ship path (not only land/Stop). Dynasty receipts were 0 when users
      // shipped without land — product gap. Best-effort; never block ship.
      const receiptSummary = await (async (): Promise<string | null> => {
        try {
          const { synthesizeJudgmentReceipt } = await import('../services/judgment-receipt')
          const receipt = await synthesizeJudgmentReceipt({
            projectId,
            projectPath,
            cycleDescription: currentTask?.description ?? featureName,
            cycleId: currentTask?.id ?? null,
          })
          return receipt.wrote ? (receipt.summary ?? 'Judgment receipt written') : null
        } catch {
          return null
        }
      })()

      if (options.md) {
        const steps = getNextSteps('ship', true)
        const md = mdOutput(
          mdDone(`Shipped: ${featureName}`, `Version: ${newVersion}`),
          mdSection(
            'Results',
            mdList(
              [
                `Version: ${newVersion}`,
                `Workflow steps run: ${stepsRun > 0 ? [...beforeResult.stepsRun, ...afterResult.stepsRun].join(', ') : 'none'}`,
                `Hooks failed (non-blocking): ${beforeResult.hooksFailed.length + afterResult.hooksFailed.length}`,
                receiptSummary ? `Compound judgment: ${receiptSummary}` : null,
              ].filter((s): s is string => s !== null)
            )
          ),
          allInstructions.length > 0
            ? mdSection('Agent Instructions', mdList(allInstructions))
            : null,
          mdNextSteps([
            ...steps.map((s) => ({ label: s.desc, command: s.cmd })),
            {
              label: 'Capture non-obvious learning (compounds next session)',
              command: 'prjct remember learning "…"',
            },
          ])
        )
        console.log(md)
      } else {
        out.done(`v${newVersion} shipped`)
        if (receiptSummary) out.info(`Compound: ${receiptSummary}`)
        showNextSteps('ship')
      }

      // Cloud sync (opt-in): push this ship + pull remote in the background.
      // Fire-and-forget — ship must never block on the network. Safe to not
      // await: the pending queue is durable, so an interrupted flush is
      // retried by the Stop hook / next `prjct cloud sync`. No-op unless the
      // project is linked.
      void (async () => {
        try {
          const { flushIfLinked } = await import('../sync/auto-flush')
          await flushIfLinked(projectPath)
        } catch {
          /* best-effort */
        }
      })()

      return { success: true, feature: featureName, version: newVersion }
    } catch (error) {
      out.fail(getErrorMessage(error))
      return failFromError(error)
    }
  }
}

function normalizeShipFeature(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

async function inferShipFeatureFromBranch(projectPath: string): Promise<string | null> {
  const branch = await getGitBranch(projectPath)
  if (!branch) return null

  const normalized = branch.replace(/^refs\/heads\//, '').trim()
  if (!normalized || /^(main|master|develop|development|dev|trunk)$/i.test(normalized)) {
    return null
  }

  const leaf = normalized.split('/').filter(Boolean).at(-1) ?? normalized
  if (!leaf || /^\d+(?:\.\d+)*$/.test(leaf)) return null

  const words = leaf
    .replace(/^[a-z]+-\d+[-_]/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return words.length >= 3 ? words : null
}

function isCodeProject(projectPath: string): boolean {
  const markers = [
    'package.json',
    'Cargo.toml',
    'pyproject.toml',
    'go.mod',
    'Gemfile',
    'pom.xml',
    'build.gradle',
    'VERSION',
  ]
  return markers.some((m) => existsSync(path.join(projectPath, m)))
}

function isGitRepo(projectPath: string): boolean {
  return existsSync(path.join(projectPath, '.git'))
}

/**
 * Seed the 4 code-default ship steps (version:bump, changelog:add,
 * git:commit, git:push) if this project looks like code. Returns true
 * when rules were added.
 *
 * Delegates the "does this look like code?" check to isCodeProject
 * here (instead of detectProjectCommands) because we want ship's
 * migration path to stay decoupled from planning.ts internals.
 */
export async function seedCodeShipRules(projectId: string, projectPath: string): Promise<boolean> {
  if (!isCodeProject(projectPath)) return false

  const now = new Date().toISOString()
  const existing = workflowRuleStorage.getRulesForCommand(projectId, 'ship')
  const existingActions = new Set(existing.map((r) => r.action))
  // Seeded rules are sorted after any user-authored rules. Start from
  // max(existing) + 1 so we don't collide.
  const maxSort = existing.reduce((m, r) => Math.max(m, r.sortOrder ?? 0), 0)

  // Gate: refuse to ship from main/master. Auto-seed used to skip this
  // and only add the 4 steps, so projects that predated workflow-first
  // would happily bump + commit + push from main. Seed it here too so
  // the migration and fresh-init paths produce the same rule set.
  const gates: Array<{ action: string; description: string; timeoutMs: number }> = []
  if (isGitRepo(projectPath)) {
    gates.push({
      action: 'git branch --show-current | grep -vE "^(main|master)$"',
      description: 'Prevent shipping from main branch',
      timeoutMs: 5000,
    })
  }

  // Stop-Slop on by default: verify before shipping when the project has a
  // detected test command. Seeded with the resolved command (not `verify:auto`,
  // which would block when nothing is detected). The user can disable or remove
  // this rule like any other — the harness compensates for a degraded model by
  // catching unverified output at the line, not after release.
  const detected = await detectProjectCommands(projectPath).catch(() => null)
  if (detected?.test?.command) {
    gates.push({
      action: `verify:${detected.test.command}`,
      description: 'Verify before shipping (Stop-Slop)',
      timeoutMs: 300000,
    })
  }

  const steps: Array<{ action: string; description: string; timeoutMs: number }> = [
    { action: 'version:bump', description: 'Bump version (stack-aware)', timeoutMs: 10000 },
    { action: 'changelog:add', description: 'Append CHANGELOG entry', timeoutMs: 10000 },
  ]
  if (isGitRepo(projectPath)) {
    steps.push({ action: 'git:commit', description: 'Commit ship', timeoutMs: 15000 })
    steps.push({ action: 'git:push', description: 'Push to origin', timeoutMs: 30000 })
    // Shipping from a feature branch (the gate above already forbids main/
    // master) previously left the branch pushed with no PR ever opened or
    // updated — repeated ships silently piled up unmerged commits with no
    // review surface. Not every project wants this though (custom PR
    // process, non-GitHub host, trunk-based/no-PR flow) — resolvePrConvention
    // reads the stored per-project decision, or falls back to a detected
    // default when nothing has been decided yet (no wizard/TTY here).
    const convention = await resolvePrConvention(projectId, projectPath)
    if (convention === 'auto') {
      steps.push({ action: 'pr:ensure', description: 'Open or confirm the PR', timeoutMs: 30000 })
    }
  }

  const newRules = [
    ...gates.map((gate) => ({ ...gate, type: 'gate' as const })),
    ...steps.map((step) => ({ ...step, type: 'step' as const })),
  ].filter((rule) => !existingActions.has(rule.action))

  for (const [index, rule] of newRules.entries()) {
    workflowRuleStorage.addRule(projectId, {
      type: rule.type,
      command: 'ship',
      position: 'before',
      action: rule.action,
      description: rule.description,
      enabled: true,
      timeoutMs: rule.timeoutMs,
      sortOrder: maxSort + index + 1,
      createdAt: now,
    })
  }

  return newRules.length > 0
}

/**
 * Read the project's stored PR convention (`custom_workflows.ship.metadata
 * .prConvention`, set once by init's wizard prompt or a ship-time
 * clarification). Undecided projects get a detected, non-interactive
 * default persisted here so the decision only needs making once, from
 * whichever path first calls this — init, auto-seed, or the ship-time
 * backfill clarification below.
 */
async function resolvePrConvention(
  projectId: string,
  projectPath: string
): Promise<'auto' | 'manual'> {
  const workflow = customWorkflowStorage.getWorkflow(projectId, 'ship')
  const stored = workflow?.metadata?.prConvention
  if (stored === 'auto' || stored === 'manual') return stored

  const signal = await detectPrConventionSignal(projectPath)
  const convention = defaultPrConventionFor(signal)
  customWorkflowStorage.updateWorkflow(projectId, 'ship', {
    metadata: { ...(workflow?.metadata ?? {}), prConvention: convention },
  })
  return convention
}

/**
 * Persist a human's answer to the PR-convention backfill question (Case
 * 3.5) and, for 'auto', add the pr:ensure step that seedCodeShipRules
 * would have added had this project decided the convention before its
 * ship steps were first seeded.
 */
function applyPrConventionDecision(
  projectId: string,
  convention: 'auto' | 'manual',
  rules: WorkflowRule[]
): void {
  const workflow = customWorkflowStorage.getWorkflow(projectId, 'ship')
  customWorkflowStorage.updateWorkflow(projectId, 'ship', {
    metadata: { ...(workflow?.metadata ?? {}), prConvention: convention },
  })
  if (convention === 'auto' && !rules.some((r) => r.action === 'pr:ensure')) {
    const maxSort = rules.reduce((m, r) => Math.max(m, r.sortOrder ?? 0), 0)
    workflowRuleStorage.addRule(projectId, {
      type: 'step',
      command: 'ship',
      position: 'before',
      action: 'pr:ensure',
      description: 'Open or confirm the PR',
      enabled: true,
      timeoutMs: 30000,
      sortOrder: maxSort + 1,
      createdAt: new Date().toISOString(),
    })
  }
}

/**
 * Inspect state and decide whether ship can proceed autonomously. When
 * we're unsure, return a clarification object; the dispatcher lifts it
 * into CommandResult.clarification and the agent surfaces the question
 * to the user.
 */
async function buildClarification(
  projectId: string,
  projectPath: string,
  rules: WorkflowRule[],
  options: ShipOptions
): Promise<CommandClarification | null> {
  // If caller already expressed intent, trust them.
  if (options.intent === 'proceed' || options.intent === 'register-only') return null

  const hasSteps = rules.some((r) => r.type === 'step' && r.position === 'before')

  // Case 1 — no steps configured at all. Auto-seed already ran, so
  // arriving here means the project isn't code (or migration failed).
  if (!hasSteps) {
    return {
      question: 'No `ship` workflow steps are configured for this project. What should ship do?',
      options: ['register-only', 'seed-code-workflow', 'abort'],
      state: {
        rulesCount: rules.length,
        looksLikeCode: isCodeProject(projectPath),
      },
    }
  }

  // Case 2 — steps are defined AND there's an active task → proceed.
  const activeTask = await resolveActiveTask(projectId, projectPath)
  if (activeTask) return null

  // Case 3 — no active work cycle but steps exist. Dangerous when there's a
  // PR already open for this branch: we don't know whether the user
  // wants another commit on top or to start fresh. Ask.
  const pr = await findOpenPrForBranch(projectPath)
  if (pr) {
    return {
      question: `No active work cycle, and PR #${pr.number} ("${pr.title}") is OPEN for this branch. Continue ship anyway?`,
      options: ['proceed', 'abort'],
      state: { openPr: pr.number, branch: pr.branch },
    }
  }

  // Case 3.5 — steps were seeded before pr:ensure existed (this project's
  // own history: seedCodeShipRules only adds new default steps the first
  // time it runs, so already-initialized projects never retroactively
  // pick up later additions to the recipe). Ask once; the answer is
  // persisted by applyPrConventionDecision so this never fires again.
  if (
    isGitRepo(projectPath) &&
    rules.some((r) => r.action === 'git:push') &&
    !rules.some((r) => r.action === 'pr:ensure') &&
    !customWorkflowStorage.getWorkflow(projectId, 'ship')?.metadata?.prConvention
  ) {
    return {
      question:
        'This project ships without opening/updating a PR. Want ship to handle that automatically (`gh pr create`), or do you manage PRs yourself?',
      options: ['pr-convention-auto', 'pr-convention-manual'],
    }
  }

  // Case 4 — steps exist, no task, no PR. Nothing obviously wrong;
  // proceed. The configured gate step (e.g. "not on main") handles the
  // rest.
  return null
}

function renderClarification(c: CommandClarification, md: boolean): void {
  if (md) {
    const body = mdOutput(
      mdSection(`Clarification needed`, c.question),
      mdSection('Options', mdList(c.options.map((o) => `\`prjct ship --intent=${o}\``))),
      c.state
        ? mdSection(
            'State',
            mdList(Object.entries(c.state).map(([k, v]) => `${k}: ${JSON.stringify(v)}`))
          )
        : null
    )
    console.log(body)
    return
  }
  console.log(`\n⚠️  ${c.question}`)
  console.log('\nOptions:')
  for (const o of c.options) {
    console.log(`  prjct ship --intent=${o}`)
  }
}

async function findOpenPrForBranch(
  projectPath: string
): Promise<{ number: number; title: string; branch: string } | null> {
  if (!isGitRepo(projectPath)) return null
  try {
    const { execFileAsync } = await import('../utils/exec')
    const { stdout: branch } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: projectPath,
      timeout: 3000,
    })
    const head = branch.toString().trim()
    if (!head) return null
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'list', '--head', head, '--state', 'open', '--json', 'number,title', '--limit', '1'],
      { cwd: projectPath, timeout: 5000 }
    )
    const parsed = JSON.parse(stdout.toString()) as Array<{ number: number; title: string }>
    if (parsed.length === 0) return null
    return { number: parsed[0].number, title: parsed[0].title, branch: head }
  } catch {
    // gh missing, no auth, or non-github remote — treat as "no PR".
    return null
  }
}
