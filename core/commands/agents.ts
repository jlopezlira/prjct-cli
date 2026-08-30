/**
 * `prjct agents` — auditable compatibility matrix for coding-agent runtimes.
 *
 * The command is intentionally derived from `agent-runtime-registry.ts` plus
 * `harness-surfaces.ts` (benchmark-tier hooks/MCP/skills integration map).
 */

import {
  type AgentRuntimeStatus,
  detectAgentRuntimes,
} from '../infrastructure/agent-runtime-registry'
import { formatHarnessSurfacesMarkdown } from '../infrastructure/harness-surfaces'
import { applyDoctorHeal } from '../services/doctor-heal'
import { probeHarnessCoverage, renderHarnessCoverageMd } from '../services/harness-coverage'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { failHard } from '../utils/md-aware'
import { PrjctCommandsBase } from './base'
import { requireProject } from './guards'

interface AgentsOptions extends MdOption {
  fix?: boolean
}

interface AgentRepairResult {
  success: true
  repoSurfaces: 'skipped'
  globalWiring: string[]
  errors: string[]
}

export class AgentsCommands extends PrjctCommandsBase {
  async agents(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: AgentsOptions = {}
  ): Promise<CommandResult> {
    const parts = (input ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    const sub = parts[0] ?? 'doctor'
    if (sub !== 'doctor' && sub !== 'status' && sub !== 'list' && sub !== 'surfaces') {
      return failHard(
        'Unknown agents subcommand. Use: prjct agents doctor | surfaces [--detail]',
        options
      )
    }

    try {
      if (sub === 'surfaces') {
        const detail = parts.includes('--detail') || parts.includes('detail') || options.md
        const body = formatHarnessSurfacesMarkdown({ detail: Boolean(detail) })
        console.log(options.md ? body : body.replace(/^## /gm, '').replace(/^### /gm, ''))
        return { success: true, surfaces: true }
      }

      const statuses = await detectAgentRuntimes(projectPath)
      const fixes = options.fix ? await repairAgentSurfaces(projectPath, options) : null
      if (fixes && !isAgentRepairResult(fixes)) return fixes

      const coverage = await probeHarnessCoverage(projectPath)
      if (options.md) {
        console.log(
          [formatMarkdown(statuses, fixes), '', renderHarnessCoverageMd(coverage)].join('\n')
        )
      } else {
        console.log(formatText(statuses, fixes))
        console.log(
          `organic: ${coverage.liveCount}/${coverage.detectedCount} live (${coverage.organicPct}%) — ${coverage.summary}`
        )
      }
      // A failed global repair must not exit 0 — `doctor --fix` already
      // returns 1 when applyDoctorHeal reports errors (doctor-service.ts
      // heal()), and CI cannot tell a no-op from a failure otherwise. The
      // errors are printed above either way.
      const healFailed = fixes !== null && fixes.errors.length > 0
      return {
        success: !healFailed,
        runtimes: statuses.length,
        detected: statuses.filter((status) => status.detected).length,
        fixed: Boolean(fixes),
        healErrors: fixes === null ? 0 : fixes.errors.length,
        organicPct: coverage.organicPct,
        liveRuntimes: coverage.liveCount,
      }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }
}

async function repairAgentSurfaces(
  projectPath: string,
  options: AgentsOptions
): Promise<CommandResult | AgentRepairResult> {
  const guard = await requireProject(projectPath, options)
  if (!guard.ok) return guard.result

  // prjct never writes AGENTS.md / CLAUDE.md / PRJCT.md / IDE rule files into
  // the client's repository. `agents doctor --fix` repairs the user's global
  // agent configuration (hooks, MCP, skills) exactly like `doctor --fix`.
  const heal = await applyDoctorHeal(projectPath)
  return {
    success: true,
    repoSurfaces: 'skipped',
    globalWiring: heal.applied,
    errors: heal.errors,
  }
}

function isAgentRepairResult(
  result: CommandResult | AgentRepairResult
): result is AgentRepairResult {
  return (
    result.success === true &&
    result.repoSurfaces === 'skipped' &&
    Array.isArray(result.globalWiring) &&
    Array.isArray(result.errors)
  )
}

function formatMarkdown(
  statuses: AgentRuntimeStatus[],
  fixes: AgentRepairResult | null = null
): string {
  const lines = [
    '# Agent Compatibility',
    '',
    '| Agent | Detected | Level | AGENTS.md | MCP | Skills | Hooks | ACP | Rules | Evidence |',
    '|---|---:|---|---:|---:|---:|---:|---:|---:|---|',
  ]

  for (const status of statuses) {
    const { runtime } = status
    const cells = [
      runtime.displayName,
      status.detected ? 'yes' : 'no',
      status.supportLevel,
      yes(runtime.supports.agentsMd),
      yes(runtime.supports.mcp),
      yes(runtime.supports.skills),
      yes(runtime.supports.hooks),
      yes(runtime.supports.acp),
      yes(runtime.supports.projectRules),
      status.detectedSignals.join(', ') || runtime.notes,
    ].join(' | ')
    lines.push(`| ${cells} |`)
  }

  if (fixes?.success) {
    lines.push(
      '',
      '## Repair',
      '',
      '- Repo surfaces: skipped (prjct never writes AGENTS.md / CLAUDE.md / PRJCT.md / IDE rules into the client repository)',
      `- Global wiring repaired: ${fixes.globalWiring.length > 0 ? fixes.globalWiring.join(', ') : 'nothing needed'}`,
      ...(fixes.errors.length > 0
        ? [`- Errors: ${fixes.errors.map((e) => `\`${e}\``).join(', ')}`]
        : [])
    )
  }

  lines.push(
    '',
    'Support levels:',
    '- `full`: benchmark-tier investment (Claude/Codex/Gemini/OpenCode/Cursor/Cline/Grok).',
    '- `good`: AGENTS.md plus MCP-capable runtime.',
    '- `baseline`: repo instructions only; agents can still run `prjct --md`.',
    '- `hosted`: repo instructions are the portable layer; external platform config may be manual.',
    '- `manual`: a portable standard exists, but prjct cannot configure it automatically.',
    '',
    formatHarnessSurfacesMarkdown({
      only: statuses
        .filter((s) => s.detected && s.supportLevel === 'full')
        .map((s) => s.runtime.id),
      detail: false,
    }),
    '',
    'Deep surface map (hooks events, MCP paths, wire status): `prjct agents surfaces --md`',
    'Grok Build inherits Claude Code hooks/MCP/skills — `prjct install` covers Grok without a second adapter.'
  )

  return lines.join('\n')
}

function formatText(
  statuses: AgentRuntimeStatus[],
  fixes: AgentRepairResult | null = null
): string {
  const detected = statuses.filter((status) => status.detected)
  const lines = ['Agent compatibility', '']

  if (fixes?.success) {
    lines.push(
      `repair: repo surfaces skipped; global wiring [${fixes.globalWiring.join(', ') || 'nothing needed'}]`,
      ...(fixes.errors.length > 0 ? [`errors: ${fixes.errors.join('; ')}`, ''] : [''])
    )
  }

  for (const status of statuses) {
    const marker = status.detected ? 'yes' : 'no '
    const caps = [
      status.runtime.supports.agentsMd ? 'AGENTS.md' : null,
      status.runtime.supports.mcp ? 'MCP' : null,
      status.runtime.supports.skills ? 'skills' : null,
      status.runtime.supports.hooks ? 'hooks' : null,
      status.runtime.supports.acp ? 'ACP' : null,
      status.runtime.supports.projectRules ? 'rules' : null,
    ]
      .filter(Boolean)
      .join(', ')

    lines.push(
      `${marker}  ${status.runtime.displayName}  [${status.supportLevel}]  ${caps || 'manual'}`
    )
    if (status.detectedSignals.length > 0) {
      lines.push(`     evidence: ${status.detectedSignals.join(', ')}`)
    }
  }

  lines.push('', `${detected.length}/${statuses.length} runtimes detected.`)
  return lines.join('\n')
}

function yes(value: boolean): string {
  return value ? 'yes' : 'no'
}
