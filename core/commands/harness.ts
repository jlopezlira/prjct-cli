/**
 * `prjct harness` — scorecard + Body creation.
 *
 *   score · learn-from · list · use <rig>
 *
 * prjct describes; the host runs LLM work and persists via prjct verbs.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import configManager from '../infrastructure/config-manager'
import {
  type InstructionFailureDisposition,
  InstructionFailureDispositionSchema,
} from '../schemas/instruction-failure'
import { probeHarnessCoverage, renderHarnessCoverageMd } from '../services/harness-coverage'
import {
  buildInductionDispatch,
  findRig,
  RIGS,
  renderRigAdoption,
  renderRigList,
} from '../services/harness-rigs'
import { computeHarnessScore, renderHarnessScoreMd } from '../services/harness-score'
import {
  buildInstructionFailureReport,
  parseInstructionReportWindow,
  renderInstructionFailureReportMd,
} from '../services/instruction-failure-report'
import { computeHarnessDelta, renderHarnessDeltaMd } from '../services/weak-frontier-demo'
import { instructionFailureStorage } from '../storage/instruction-failure-storage'
import { stateStorage } from '../storage/state-storage'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { PrjctCommandsBase } from './base'

export class HarnessCommands extends PrjctCommandsBase {
  /** `prjct harness instructions set <id> <disposition>` — close the feedback loop. */
  async instructionDisposition(
    id: string | null,
    rawDisposition: string | null,
    projectPath: string = process.cwd()
  ): Promise<CommandResult> {
    try {
      if (!id || !rawDisposition) {
        throw new Error(
          'Usage: prjct harness instructions set <id> <open|resolved|false-positive>.'
        )
      }
      const disposition = InstructionFailureDispositionSchema.parse(
        rawDisposition === 'false-positive' ? 'false_positive' : rawDisposition
      ) as InstructionFailureDisposition
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        return { success: false, error: 'No prjct project found in the current directory.' }
      }
      if (!instructionFailureStorage.setDisposition(projectId, id, disposition)) {
        return { success: false, error: `Instruction failure not found: ${id}` }
      }
      console.log(`Instruction failure ${id}: ${disposition.replace('_', '-')}`)
      return { success: true, id, disposition }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  }

  /** `prjct harness instructions [window]` — instruction observability ledger. */
  async instructions(
    rawWindow: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const window = parseInstructionReportWindow(rawWindow)
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        return { success: false, error: 'No prjct project found in the current directory.' }
      }
      const report = buildInstructionFailureReport(projectId, window)
      if (options.md) {
        console.log(renderInstructionFailureReportMd(report))
      } else {
        console.log(
          `Instruction failures (${window}): ${report.total}; attributed ${report.attributed} (${(
            report.attributionRate * 100
          ).toFixed(1)}%); open ${report.open}; false-trigger ${(
            report.falseTriggerRate * 100
          ).toFixed(1)}%`
        )
      }
      return { success: true, ...report }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  }

  /** `prjct harness retrieval` — measured Recall@k/MRR/nDCG for this project's recall pipeline. */
  async retrieval(
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        return { success: false, error: 'No prjct project found in the current directory.' }
      }
      const { buildRetrievalReport, renderRetrievalReportMd, renderRetrievalReportText } =
        await import('../eval/report')
      const report = await buildRetrievalReport(projectId, 10, projectPath)
      console.log(options.md ? renderRetrievalReportMd(report) : renderRetrievalReportText(report))
      return {
        success: true,
        pairCount: report.pairCount,
        corpusSize: report.corpusSize,
        heldOut: report.heldOut,
      }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  }

  /** `prjct harness audit` — the visible, fail-able memory relevance check. */
  async audit(projectPath: string = process.cwd(), options: MdOption = {}): Promise<CommandResult> {
    try {
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        return { success: false, error: 'No prjct project found in the current directory.' }
      }
      const { buildMemoryAudit, renderMemoryAuditMd, renderMemoryAuditText } = await import(
        '../services/memory-audit'
      )
      const report = buildMemoryAudit(projectId)
      console.log(options.md ? renderMemoryAuditMd(report) : renderMemoryAuditText(report))
      // success = threshold passed, so the dispatch exits non-zero on a failing
      // audit and it works as a CI/lint gate. The report is already printed.
      return { success: report.passed, ...report }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  }

  async score(projectPath: string = process.cwd(), options: MdOption = {}): Promise<CommandResult> {
    try {
      // Structural grade is machine-independent (CI/release). Live organic board
      // is advisory: laptop install state must not tank programDone. Adapter
      // presence is gated by weak-model-bench, not ~/.claude probes on runners.
      const coverage = await probeHarnessCoverage(projectPath)
      const evidencePath = path.join(projectPath, '.prjct', 'evaluations', 'paired-outcomes.json')
      const pairedRuns: unknown = existsSync(evidencePath)
        ? JSON.parse(readFileSync(evidencePath, 'utf8'))
        : undefined
      const report = computeHarnessScore({ pairedRuns })
      const delta = computeHarnessDelta()
      const { outcomesMd, outcomesLine, weakLine } = await (async () => {
        try {
          const projectId = await configManager.getProjectId(projectPath)
          if (!projectId) return { outcomesMd: null, outcomesLine: null, weakLine: null }
          const { buildDynastyOutcomes, renderDynastyOutcomesMd } = await import(
            '../services/dynasty-outcomes'
          )
          const outcomes = buildDynastyOutcomes(projectId)
          const cfg = await configManager.readConfig(projectPath)
          const { effectiveWeakModelMode, weakModelOneLiner } = await import(
            '../services/weak-model-mode'
          )
          return {
            outcomesMd: renderDynastyOutcomesMd(outcomes),
            outcomesLine: outcomes.line,
            weakLine: effectiveWeakModelMode(cfg) === 'on' ? weakModelOneLiner() : null,
          }
        } catch {
          return { outcomesMd: null, outcomesLine: null, weakLine: null }
        }
      })()
      if (options.md) {
        const md = renderHarnessScoreMd(report, {
          coverageMd: renderHarnessCoverageMd(coverage),
          deltaMd: renderHarnessDeltaMd(delta),
          outcomesMd: outcomesMd ?? undefined,
        })
        const extras = [weakLine ? `## Weak-model mode\n\n${weakLine}` : '']
          .filter(Boolean)
          .join('\n\n')
        console.log(extras ? `${md}\n\n${extras}\n` : md)
      } else {
        console.log(`Harness grade: ${report.grade}/5${report.programDone ? ' (done)' : ''}`)
        console.log(report.summary)
        for (const c of report.criteria) {
          const mark = c.status === 'green' ? '✓' : c.status === 'amber' ? '△' : '✗'
          console.log(`  ${mark} ${c.name}: ${c.score} — ${c.measured}`)
        }
        console.log(delta.line)
        console.log(
          `Organic board: ${coverage.liveCount}/${coverage.detectedCount} live (${coverage.organicPct}%) — advisory`
        )
        if (outcomesLine) console.log(outcomesLine)
        if (weakLine) console.log(weakLine)
      }
      return {
        success: true,
        grade: report.grade,
        programDone: report.programDone,
        criteria: report.criteria,
        organicPct: coverage.organicPct,
        liveRuntimes: coverage.liveCount,
        harnessDeltaPass: delta.allGreen,
        intentDeltaPp: delta.intentDeltaPp,
      }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  }

  /** `prjct harness learn-from` — induction from the just-performed flow. */
  async learnFrom(
    projectPath: string = process.cwd(),
    _options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const activeCycle = await configManager
        .getProjectId(projectPath)
        .then((projectId) => (projectId ? stateStorage.getCurrentTask(projectId) : null))
        .then((task) => task?.description ?? null)
        .catch(() => null)
      const hasGit = existsSync(path.join(projectPath, '.git'))
      console.log(buildInductionDispatch({ activeCycle, hasGit }))
      return { success: true }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  }

  /** `prjct harness list` — the stealable rigs. */
  async list(_options: MdOption = {}): Promise<CommandResult> {
    console.log(renderRigList())
    return { success: true }
  }

  /** `prjct harness use <name>` — adopt a rig as the Body's base. */
  async use(
    name: string | null,
    _projectPath: string = process.cwd(),
    _options: MdOption = {}
  ): Promise<CommandResult> {
    if (!name) {
      console.error(
        `Usage: prjct harness use <rig>. Available: ${RIGS.map((r) => r.name).join(', ')}.`
      )
      return { success: false, error: 'missing rig name' }
    }
    const rig = findRig(name)
    if (!rig) {
      console.error(`Unknown rig: ${name}. Available: ${RIGS.map((r) => r.name).join(', ')}.`)
      return { success: false, error: `unknown rig: ${name}` }
    }
    console.log(renderRigAdoption(rig))
    return { success: true }
  }
}
