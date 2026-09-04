/**
 * Absolute harness scorecard for `prjct harness score`.
 *
 * Structural grade 0–5; outcome readiness requires independently graded paired runs.
 */

import { Buffer } from 'node:buffer'
import { createServer, DEFAULT_MCP_TOOL_TIER, resolveTier } from '../mcp/server'
import { SUPPORTED_PROVIDERS } from '../schemas/model'
import { countTokens } from '../tools/context/token-counter'
import {
  CONTEXT_TIERS,
  L0_ROUTING_BYTES_MAX,
  L0_SKILL_TOKENS_MAX,
  MCP_TOOLS_CORE_MAX,
  measureL0Budget,
} from './context-tiers'
import { evaluateOutcomeEvidence, type OutcomeEvidenceReport } from './outcome-evidence'
import { MINIMAL_ROUTING_BODY } from './routing-block'
import { buildPrjctSkill } from './skill-generator/prjct-skill-body'

export interface HarnessCriterion {
  id: string
  name: string
  score: number
  slo: string
  measured: string
  status: 'green' | 'amber' | 'red'
}

export interface HarnessScoreReport {
  structuralReady: boolean
  outcomeEvidence: OutcomeEvidenceReport
  grade: number
  programDone: boolean
  criteria: HarnessCriterion[]
  summary: string
  defaults: {
    mcpTier: string
    skillTokens: number
    routingBytes: number
    providerCount: number
    mcpToolCountDefault: number
  }
}

/** Absolute budgets the harness must hold. */
export const WORLD_CLASS = {
  /** Dynasty D5 floor — always-on skill diet (was 1500). Lockstep with L0_* in context-tiers. */
  skillTokensMax: L0_SKILL_TOKENS_MAX,
  skillTokensAmber: 1200,
  routingBodyBytesMax: L0_ROUTING_BYTES_MAX,
  routingBodyBytesAmber: 600,
  mcpDefaultTier: 'core' as const,
  /** Core ListTools budget after MCP schema slim (was 20). */
  mcpToolsCoreMax: MCP_TOOLS_CORE_MAX,
  providerMapsMin: 6,
  meanGreen: 4.5,
  minCriterionGreen: 4,
} as const

function gradeRatio(value: number, green: number, amber: number, lowerIsBetter: boolean): number {
  if (lowerIsBetter) {
    if (value <= green) return 5
    if (value <= amber) return 3.5
    if (value <= amber * 1.5) return 2
    return 1
  }
  if (value >= green) return 5
  if (value >= amber) return 3.5
  if (value >= amber * 0.5) return 2
  return 1
}

function statusOf(score: number): HarnessCriterion['status'] {
  if (score >= 4) return 'green'
  if (score >= 3) return 'amber'
  return 'red'
}

function criterion(
  id: string,
  name: string,
  score: number,
  slo: string,
  measured: string
): HarnessCriterion {
  return { id, name, score, slo, measured, status: statusOf(score) }
}

function countDefaultTools(): number {
  const prev = process.env.PRJCT_MCP_TOOLS
  try {
    delete process.env.PRJCT_MCP_TOOLS
    const server = createServer() as unknown as { _registeredTools?: Record<string, unknown> }
    return Object.keys(server._registeredTools ?? {}).length
  } finally {
    if (prev === undefined) delete process.env.PRJCT_MCP_TOOLS
    else process.env.PRJCT_MCP_TOOLS = prev
  }
}

export function computeHarnessScore(
  options: {
    /** Live multi-runtime organic grade from probeHarnessCoverage (0–5). */
    pairedRuns?: unknown
    multiRuntimeOrganicGrade?: number
    multiRuntimeOrganicMeasured?: string
  } = {}
): HarnessScoreReport {
  const skill = buildPrjctSkill()
  const skillTokens = countTokens(skill)
  const routingBytes = Buffer.byteLength(MINIMAL_ROUTING_BODY, 'utf-8')
  const providerNames = [...SUPPORTED_PROVIDERS]
  const providerCount = providerNames.length
  const mcpTier = resolveTier(undefined)
  const mcpTools = countDefaultTools()
  const hasWorkflowsPointer = skill.includes('workflows.md')

  const criteria: HarnessCriterion[] = [
    criterion(
      'skill-tokens',
      'Always-on skill tokens',
      gradeRatio(skillTokens, WORLD_CLASS.skillTokensMax, WORLD_CLASS.skillTokensAmber, true),
      `≤ ${WORLD_CLASS.skillTokensMax} tok`,
      `${skillTokens} tok`
    ),
    criterion(
      'routing-bytes',
      'AGENTS/CLAUDE routing body',
      gradeRatio(
        routingBytes,
        WORLD_CLASS.routingBodyBytesMax,
        WORLD_CLASS.routingBodyBytesAmber,
        true
      ),
      `≤ ${WORLD_CLASS.routingBodyBytesMax} bytes`,
      `${routingBytes} bytes`
    ),
    criterion(
      'mcp-default',
      'MCP default tool tier',
      mcpTier === WORLD_CLASS.mcpDefaultTier ? 5 : mcpTier === 'standard' ? 3 : 1,
      `default = ${WORLD_CLASS.mcpDefaultTier}`,
      `${mcpTier} (${mcpTools} tools)`
    ),
    criterion(
      'mcp-tool-count',
      'MCP tools at default tier',
      gradeRatio(mcpTools, WORLD_CLASS.mcpToolsCoreMax, 30, true),
      `≤ ${WORLD_CLASS.mcpToolsCoreMax} tools`,
      `${mcpTools} tools`
    ),
    criterion(
      'provider-maps',
      'Provider capability maps',
      gradeRatio(providerCount, WORLD_CLASS.providerMapsMin, 4, false),
      `≥ ${WORLD_CLASS.providerMapsMin} providers`,
      `${providerCount}: ${providerNames.join(', ')}`
    ),
    criterion(
      'progressive-disclosure',
      'Progressive disclosure',
      hasWorkflowsPointer ? 5 : 1,
      'skill points at workflows.md',
      hasWorkflowsPointer ? 'skill → workflows.md' : 'missing pointer'
    ),
    (() => {
      const l0 = measureL0Budget()
      const tierCount = CONTEXT_TIERS.length
      const score = l0.ok && tierCount === 4 ? 5 : l0.ok ? 4 : tierCount === 4 ? 2 : 1
      return criterion(
        'context-tiers',
        'Context cache tiers L0–L3',
        score,
        '4 named tiers + L0 skill/routing SLOs',
        `${tierCount} tiers; L0 skill=${l0.skillTokens}tok routing=${l0.routingBytes}B ${l0.ok ? 'ok' : 'OVER'}`
      )
    })(),
    (() => {
      // Was "Model policy SSOT — capability classes across ≥6 providers",
      // which kept scoring 5/5 after that policy was deleted: it had quietly
      // degraded into a provider head-count under a stale label. The property
      // worth grading now is the opposite one — that prjct emits no model or
      // effort directive, so every subagent inherits the user's model.
      const capping = [
        'model: "opus"',
        'model: "sonnet"',
        'model: "haiku"',
        'over-deliberate',
        'not exhaustive',
        'max-tier',
        'mid-tier',
      ].filter((needle) => skill.includes(needle))
      return criterion(
        'model-agnostic',
        'Model-agnostic dispatch',
        capping.length === 0 ? 5 : 1,
        'names no model or effort tier',
        capping.length === 0 ? 'inherits the session model' : `caps: ${capping.join(', ')}`
      )
    })(),
    criterion(
      'enforced-defaults',
      'Code-enforced lean defaults',
      DEFAULT_MCP_TOOL_TIER === 'core' && WORLD_CLASS.skillTokensMax <= 1000 ? 5 : 2,
      'MCP core default + skill budget in code',
      `tier=${DEFAULT_MCP_TOOL_TIER}; skillMax=${WORLD_CLASS.skillTokensMax}`
    ),
    (() => {
      // Multi-project isolation: L0 skill must never carry project identity.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { skillBodyHasProjectStamp } =
        require('./skill-generator') as typeof import('./skill-generator')
      const portable = !skillBodyHasProjectStamp(skill)
      const hasBaseline =
        skill.includes('cwd-scoped') || skill.includes('Portable L0') || skill.includes('portable')
      const score = portable && hasBaseline ? 5 : portable ? 3 : 1
      return criterion(
        'skill-isolation',
        'Multi-project skill isolation',
        score,
        'global L0 skill project-agnostic',
        portable ? 'portable L0 (no project stamp)' : 'PROJECT-STAMPED (poison risk)'
      )
    })(),
  ]

  // Optional: live organic multi-runtime board (probed by harness score / install).
  // Structural tests omit this so CI stays deterministic without real CLI installs.
  if (options.multiRuntimeOrganicGrade !== undefined) {
    criteria.push(
      criterion(
        'multi-runtime-organic',
        'Multi-runtime organic board',
        options.multiRuntimeOrganicGrade,
        '≥2 live full/inherited on detected CLIs (4+ = dominance)',
        options.multiRuntimeOrganicMeasured ?? `${options.multiRuntimeOrganicGrade}/5`
      )
    )
  }

  const grade =
    Math.round((criteria.reduce((sum, c) => sum + c.score, 0) / criteria.length) * 10) / 10
  const structuralReady =
    grade >= WORLD_CLASS.meanGreen &&
    criteria.every((c) => c.score >= WORLD_CLASS.minCriterionGreen)

  const outcomeEvidence = evaluateOutcomeEvidence(options.pairedRuns)
  const programDone = structuralReady && outcomeEvidence.qualified
  const summary = `Structural grade ${grade}/5 (${structuralReady ? 'meets structural budgets' : 'incomplete'}). Outcome evidence: ${outcomeEvidence.status}. ${outcomeEvidence.reason}`

  return {
    grade,
    structuralReady,
    outcomeEvidence,
    programDone,
    criteria,
    summary,
    defaults: {
      mcpTier,
      skillTokens,
      routingBytes,
      providerCount,
      mcpToolCountDefault: mcpTools,
    },
  }
}

export function renderHarnessScoreMd(
  report: HarnessScoreReport,
  options: {
    coverageMd?: string
    /** Pure bare-vs-harness Δ table (from computeHarnessDelta). */
    deltaMd?: string
    /** Project-scoped closed-loop / retention / tokens (optional). */
    outcomesMd?: string
  } = {}
): string {
  const rows = report.criteria.map(
    (c) => `| ${c.name} | ${c.score} | ${c.status} | ${c.slo} | ${c.measured} |`
  )
  return [
    '# Harness score',
    '',
    `**Structural grade:** ${report.grade}/5 · **Outcome quality:** ${report.outcomeEvidence.status}`,
    '',
    report.summary,
    '',
    '| Criterion | Score | Status | SLO | Measured |',
    '|---|---:|---|---|---|',
    ...rows,
    '',
    '## Defaults',
    '',
    `- MCP: \`${report.defaults.mcpTier}\` (${report.defaults.mcpToolCountDefault} tools)`,
    `- Skill tokens: ${report.defaults.skillTokens}`,
    `- Routing body: ${report.defaults.routingBytes} bytes`,
    `- Providers: ${report.defaults.providerCount}`,
    '',
    options.deltaMd ?? '',
    options.outcomesMd ?? '',
    options.coverageMd ?? '',
  ].join('\n')
}

export { buildPrjctSkill }
