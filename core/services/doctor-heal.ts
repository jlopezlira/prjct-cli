/**
 * Doctor auto-heal — Dynasty D6 / E3.
 *
 * `prjct doctor --fix` repairs dead hooks, multi-runtime wire gaps, and
 * project agent surfaces. Pure plan + thin apply (reuses install paths).
 */

import { detectAgentRuntimes } from '../infrastructure/agent-runtime-registry'
import configManager from '../infrastructure/config-manager'
import { probeHarnessCoverage } from './harness-coverage'
import { writeProjectAgentSurfaces } from './project-agent-surfaces'
import { status as hookStatus, install as installHooks } from './settings-installer'

export type HealActionId =
  | 'claude-hooks'
  | 'multi-runtime-wire'
  | 'agent-surfaces'
  | 'portable-skills'
  | 'organic-board'

export interface HealAction {
  id: HealActionId
  label: string
  needed: boolean
  reason: string
}

export interface HealPlan {
  actions: HealAction[]
  neededCount: number
  line: string
}

export interface HealApplyResult {
  planned: number
  applied: string[]
  skipped: string[]
  errors: string[]
  organicPct: number
  liveCount: number
  detectedCount: number
  line: string
}

/**
 * Pure plan from probe numbers — unit-testable without disk.
 */
export function planDoctorHeal(input: {
  hooksInstalled: number
  hooksExpected: number
  liveCount: number
  detectedCount: number
  organicPct: number
  hasProject: boolean
  /** True when global Claude skill embeds project identity (poison). */
  skillPoisoned?: boolean
}): HealPlan {
  const actions: HealAction[] = [
    {
      id: 'claude-hooks',
      label: 'Reinstall Claude hooks',
      needed: input.hooksExpected > 0 && input.hooksInstalled < input.hooksExpected,
      reason:
        input.hooksInstalled < input.hooksExpected
          ? `${input.hooksInstalled}/${input.hooksExpected} hooks missing`
          : 'hooks complete',
    },
    {
      id: 'multi-runtime-wire',
      label: 'Wire detected multi-runtime adapters',
      needed:
        input.detectedCount > 0 &&
        (input.liveCount < input.detectedCount || input.organicPct < 100),
      reason:
        input.detectedCount === 0
          ? 'no runtimes detected'
          : `organic ${input.liveCount}/${input.detectedCount} (${input.organicPct}%)`,
    },
    {
      id: 'agent-surfaces',
      label: 'Refresh project AGENTS.md / adapters',
      needed: input.hasProject,
      reason: input.hasProject
        ? 'explicit surface refresh (clean-repo opt-in)'
        : 'no project — skip surfaces',
    },
    {
      id: 'portable-skills',
      label: 'Rewrite portable multi-host skills (clear project stamp)',
      needed: input.skillPoisoned === true,
      reason:
        input.skillPoisoned === true
          ? 'global skill has project identity (multi-project poison)'
          : 'skills portable',
    },
    {
      id: 'organic-board',
      label: 'Re-probe organic board',
      needed: true,
      reason: 'always re-probe after heal',
    },
  ]
  const neededCount = actions.filter((a) => a.needed).length
  const line = `Doctor heal plan: ${neededCount}/${actions.length} actions needed`
  return { actions, neededCount, line }
}

/**
 * Apply heal plan — reinstall hooks + multi-runtime adapters + surfaces.
 * Best-effort per action; never throws past report.
 */
export async function applyDoctorHeal(
  projectPath: string = process.cwd()
): Promise<HealApplyResult> {
  const applied: string[] = []
  const skipped: string[] = []
  const errors: string[] = []

  const { hooksInstalled, hooksExpected } = await hookStatus()
    .then((status) => ({ hooksInstalled: status.installed, hooksExpected: status.expected }))
    .catch((error) => {
      errors.push(`hook status: ${(error as Error).message}`)
      return { hooksInstalled: 0, hooksExpected: 0 }
    })

  const coverageSnapshots = [await probeHarnessCoverage(projectPath).catch(() => null)]
  const projectId = await configManager.getProjectId(projectPath).catch(() => null)

  const skillPoisoned = await (async () => {
    try {
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      const os = await import('node:os')
      const { skillBodyHasProjectStamp } = await import('./skill-generator')
      const skillPath = path.join(os.homedir(), '.claude', 'skills', 'prjct', 'SKILL.md')
      const body = await fs.readFile(skillPath, 'utf-8').catch(() => null)
      return body ? skillBodyHasProjectStamp(body) : false
    } catch {
      return false
    }
  })()
  const coverage = coverageSnapshots[0]

  const plan = planDoctorHeal({
    hooksInstalled,
    hooksExpected,
    liveCount: coverage?.liveCount ?? 0,
    detectedCount: coverage?.detectedCount ?? 0,
    organicPct: coverage?.organicPct ?? 0,
    hasProject: Boolean(projectId),
    skillPoisoned,
  })

  for (const action of plan.actions) {
    if (!action.needed && action.id !== 'organic-board') {
      skipped.push(action.id)
      continue
    }
    try {
      if (action.id === 'claude-hooks') {
        await installHooks()
        applied.push(action.id)
      } else if (action.id === 'portable-skills') {
        const { skillGenerator } = await import('./skill-generator')
        await skillGenerator.generateAndInstall()
        applied.push(action.id)
      } else if (action.id === 'multi-runtime-wire') {
        // Mirror install.ts: wire every detected host
        const runtimes = await detectAgentRuntimes(projectPath)
        const detected = runtimes.filter((r) => r.detected)
        if (detected.some((r) => r.runtime.id === 'codex')) {
          const { ensureCodexMcpServer } = await import('../utils/codex-mcp')
          const { installCodexHooks } = await import('../utils/codex-hooks')
          await ensureCodexMcpServer()
          await installCodexHooks()
        }
        if (detected.some((r) => r.runtime.id === 'gemini')) {
          const { installGeminiSettings } = await import('../utils/gemini-settings')
          await installGeminiSettings()
        }
        if (detected.some((r) => r.runtime.id === 'cursor')) {
          const { installCursorHooks } = await import('../utils/cursor-hooks')
          await installCursorHooks()
        }
        if (detected.some((r) => r.runtime.id === 'kimi-cli')) {
          const { ensureKimiMcpServer } = await import('../utils/kimi-mcp')
          await ensureKimiMcpServer()
        }
        if (detected.some((r) => r.runtime.id === 'grok')) {
          const { ensureGrokMcpServer } = await import('../utils/grok-mcp')
          const { installGrokSkill } = await import('../infrastructure/grok-skill')
          const { installGrokPlugin } = await import('../utils/grok-plugin')
          await ensureGrokMcpServer()
          await installGrokSkill()
          await installGrokPlugin()
        }
        if (detected.some((r) => r.runtime.id === 'opencode')) {
          const { ensureOpenCodeMcpServer } = await import('../utils/opencode-mcp')
          await ensureOpenCodeMcpServer()
        }
        if (detected.some((r) => r.runtime.id === 'pi')) {
          const { installPiSkill } = await import('../infrastructure/pi-skill')
          await installPiSkill()
        }
        // Always ensure Claude hooks too when multi-runtime runs
        await installHooks()
        applied.push(action.id)
      } else if (action.id === 'agent-surfaces') {
        await writeProjectAgentSurfaces(projectPath, { explicit: true })
        applied.push(action.id)
      } else if (action.id === 'organic-board') {
        coverageSnapshots.push(await probeHarnessCoverage(projectPath))
        applied.push(action.id)
      }
    } catch (e) {
      errors.push(`${action.id}: ${(e as Error).message}`)
    }
  }

  const finalCoverage = coverageSnapshots.at(-1)
  const liveCount = finalCoverage?.liveCount ?? 0
  const detectedCount = finalCoverage?.detectedCount ?? 0
  const organicPct = finalCoverage?.organicPct ?? 0
  const line = `Doctor heal: applied ${applied.length} · skipped ${skipped.length} · errors ${errors.length} · organic ${liveCount}/${detectedCount} (${organicPct}%)`

  return {
    planned: plan.neededCount,
    applied,
    skipped,
    errors,
    organicPct,
    liveCount,
    detectedCount,
    line,
  }
}
