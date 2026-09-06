/**
 * Public A/B surface: weak model + prjct harness vs frontier without harness.
 * Pure scoring — `scripts/demo-weak-vs-frontier.ts` is the CLI entry.
 * Dynasty scorecard embeds `computeHarnessDelta` / `renderHarnessDeltaMd`.
 */

import { Buffer } from 'node:buffer'
import { DEFAULT_MCP_TOOL_TIER, resolveTier } from '../mcp/server'
import { SUPPORTED_PROVIDERS } from '../schemas/model'
import { countTokens } from '../tools/context/token-counter'
import { computeHarnessScore, WORLD_CLASS } from './harness-score'
import { MINIMAL_ROUTING_BODY } from './routing-block'
import { buildPrjctSkill } from './skill-generator/prjct-skill-body'
import { INTENT_FIXTURES } from './weak-model-bench'

export interface DemoRow {
  capability: string
  frontierNoHarness: string
  weakWithPrjct: string
  weakOk: boolean
}

/** Intent A/B + footprint delta — pure, no DB (release-gate + scorecard). */
export interface HarnessDeltaReport {
  fixtureCount: number
  harnessHits: number
  bareHits: number
  harnessRate: number
  bareRate: number
  /** Percentage points: harnessRate − bareRate. */
  intentDeltaPp: number
  skillTokens: number
  routingBytes: number
  mcpTools: number
  /** Absolute SLOs for Dynasty gate. */
  minHarnessRate: number
  minIntentDeltaPp: number
  allGreen: boolean
  /** One scannable line for terminal / score. */
  line: string
  rows: Array<{ metric: string; bare: string; harness: string; ok: boolean }>
}

/** Minimum harness intent accuracy (same as weak-model-bench). */
export const DELTA_MIN_HARNESS_RATE = 0.95
/**
 * Minimum intent accuracy gap vs bare (percentage points).
 * Fixtures yield ~70pp today; floor 40pp keeps the gap "wide".
 */
export const DELTA_MIN_INTENT_PP = 40

/** Deterministic intent router — same contract as bench-weak-model. */
export function routeIntent(signal: string): string {
  const s = signal.toLowerCase()
  if (/\bsync\b/.test(s)) return 'sync'
  if (/\bsearch\b|\bfind\b|\brecall\b/.test(s)) return 'search'
  if (/\bremember\b|\bsave (this|that|a)\b/.test(s)) return 'remember'
  if (/\bship\b|\bopen a pr\b/.test(s)) return 'ship'
  if (/what should i work|what next|\bready\b/.test(s)) return 'next'
  if (/\bfix\b|\bbuild\b|\bimplement\b|\bbug\b|\brefactor\b/.test(s)) return 'work'
  return 'work'
}

/**
 * Naive frontier-without-harness routing: folds bin verbs into "work"
 * (the failure mode that burns tokens and never hits SQLite).
 */
export function routeIntentBare(signal: string): string {
  const s = signal.toLowerCase()
  if (/\bship\b/.test(s)) return 'ship'
  if (/\bfix\b|\bbuild\b|\bimplement\b|\bbug\b/.test(s)) return 'work'
  return 'work'
}

function intentHitCounts(): {
  harnessHits: number
  bareHits: number
  fixtureCount: number
} {
  const harnessHits = INTENT_FIXTURES.filter(
    (fixture) => routeIntent(fixture.signal) === fixture.verb
  ).length
  const bareHits = INTENT_FIXTURES.filter(
    (fixture) => routeIntentBare(fixture.signal) === fixture.verb
  ).length
  return { harnessHits, bareHits, fixtureCount: INTENT_FIXTURES.length }
}

/**
 * Live harness Δ — same 10 intents bare vs harness + footprint SLOs.
 * Pure; exit non-zero when `!allGreen` (wired by demo script + weak bench).
 */
export function computeHarnessDelta(): HarnessDeltaReport {
  const { harnessHits, bareHits, fixtureCount } = intentHitCounts()
  const harnessRate = harnessHits / fixtureCount
  const bareRate = bareHits / fixtureCount
  const intentDeltaPp = Math.round((harnessRate - bareRate) * 1000) / 10
  const skillTokens = countTokens(buildPrjctSkill())
  const routingBytes = Buffer.byteLength(MINIMAL_ROUTING_BODY, 'utf-8')
  const score = computeHarnessScore()
  const mcpTools = score.defaults.mcpToolCountDefault

  const intentOk =
    harnessRate >= DELTA_MIN_HARNESS_RATE &&
    harnessHits > bareHits &&
    intentDeltaPp >= DELTA_MIN_INTENT_PP
  const skillOk = skillTokens <= WORLD_CLASS.skillTokensMax
  const routingOk = routingBytes <= WORLD_CLASS.routingBodyBytesMax
  const mcpOk =
    resolveTier(undefined) === WORLD_CLASS.mcpDefaultTier &&
    DEFAULT_MCP_TOOL_TIER === WORLD_CLASS.mcpDefaultTier &&
    mcpTools <= WORLD_CLASS.mcpToolsCoreMax

  const rows: HarnessDeltaReport['rows'] = [
    {
      metric: 'Intent routing accuracy',
      bare: `${Math.round(bareRate * 100)}% (wraps bin verbs as work)`,
      harness: `${Math.round(harnessRate * 100)}% (verb map)`,
      ok: intentOk,
    },
    {
      metric: 'Intent Δ (pp)',
      bare: '—',
      harness: `+${intentDeltaPp} pp (min +${DELTA_MIN_INTENT_PP})`,
      ok: intentDeltaPp >= DELTA_MIN_INTENT_PP && harnessHits > bareHits,
    },
    {
      metric: 'Always-on skill tokens',
      bare: 'Unbounded host dump',
      harness: `${skillTokens} tok (≤${WORLD_CLASS.skillTokensMax})`,
      ok: skillOk,
    },
    {
      metric: 'Routing body bytes',
      bare: 'Methodology every turn',
      harness: `${routingBytes} B (≤${WORLD_CLASS.routingBodyBytesMax})`,
      ok: routingOk,
    },
    {
      metric: 'MCP default tools',
      bare: 'All tools loaded',
      harness: `${mcpTools} tools @ ${resolveTier(undefined)} (≤${WORLD_CLASS.mcpToolsCoreMax})`,
      ok: mcpOk,
    },
  ]

  const allGreen = rows.every((r) => r.ok)
  const line = `Harness Δ: intent ${Math.round(bareRate * 100)}%→${Math.round(harnessRate * 100)}% (+${intentDeltaPp}pp) · skill ${skillTokens}tok · MCP ${mcpTools} · ${allGreen ? 'PASS' : 'FAIL'}`

  return {
    fixtureCount,
    harnessHits,
    bareHits,
    harnessRate,
    bareRate,
    intentDeltaPp,
    skillTokens,
    routingBytes,
    mcpTools,
    minHarnessRate: DELTA_MIN_HARNESS_RATE,
    minIntentDeltaPp: DELTA_MIN_INTENT_PP,
    allGreen,
    line,
    rows,
  }
}

/** Compact markdown table for `prjct harness score` (Dynasty public proof). */
export function renderHarnessDeltaMd(delta: HarnessDeltaReport = computeHarnessDelta()): string {
  const body = delta.rows.map(
    (r) => `| ${r.metric} | ${r.bare} | ${r.harness} | ${r.ok ? '✓' : '✗'} |`
  )
  return [
    '## Harness Δ (bare vs prjct)',
    '',
    'Synthetic regex-routing fixture comparison. No model was executed; these results do not measure model quality or token savings.',
    '',
    '| Metric | Bare (no harness) | With prjct | Pass |',
    '|---|---|---|:---:|',
    ...body,
    '',
    `**${delta.line}**`,
    '',
    '_Reproduce: `bun run demo:weak-vs-frontier` · `bun run bench:weak-model` · `bun run gate:dominance`_',
    '',
  ].join('\n')
}

export function buildDemoRows(): DemoRow[] {
  const skillTok = countTokens(buildPrjctSkill())
  const routingB = Buffer.byteLength(MINIMAL_ROUTING_BODY, 'utf-8')
  const score = computeHarnessScore()
  const providers = SUPPORTED_PROVIDERS.length
  const delta = computeHarnessDelta()
  const harnessRate = delta.harnessRate
  const bareRate = delta.bareRate
  const harnessHits = delta.harnessHits
  const bareHits = delta.bareHits

  const mcpDefault =
    resolveTier(undefined) === WORLD_CLASS.mcpDefaultTier &&
    DEFAULT_MCP_TOOL_TIER === WORLD_CLASS.mcpDefaultTier
  const mcpCount = score.defaults.mcpToolCountDefault

  return [
    {
      capability: 'Always-on skill size',
      frontierNoHarness: 'Not measured',
      weakWithPrjct: `${skillTok} tok (SLO ≤${WORLD_CLASS.skillTokensMax})`,
      weakOk: skillTok <= WORLD_CLASS.skillTokensMax,
    },
    {
      capability: 'Routing body (AGENTS map)',
      frontierNoHarness: 'Not measured',
      weakWithPrjct: `${routingB} B (SLO ≤${WORLD_CLASS.routingBodyBytesMax})`,
      weakOk: routingB <= WORLD_CLASS.routingBodyBytesMax,
    },
    {
      capability: 'MCP default surface',
      frontierNoHarness: 'Not measured',
      weakWithPrjct: `tier=${resolveTier(undefined)} · ${mcpCount} tools`,
      weakOk: mcpDefault && mcpCount <= WORLD_CLASS.mcpToolsCoreMax,
    },
    {
      capability: 'Multi-provider model maps',
      frontierNoHarness: 'Not measured',
      weakWithPrjct: `${providers} providers (min ${WORLD_CLASS.providerMapsMin})`,
      weakOk: providers >= WORLD_CLASS.providerMapsMin,
    },
    {
      capability: 'Harness scorecard',
      frontierNoHarness: 'Not measured',
      weakWithPrjct: `grade ${score.grade}/5 · programDone=${score.programDone}`,
      weakOk: score.structuralReady && score.grade >= 4.5,
    },
    {
      capability: 'Intent routing accuracy',
      frontierNoHarness: `${Math.round(bareRate * 100)}% bare (wraps bin verbs as work)`,
      weakWithPrjct: `${Math.round(harnessRate * 100)}% with verb map (need ≥95%)`,
      weakOk: harnessRate >= DELTA_MIN_HARNESS_RATE,
    },
    {
      capability: 'Intent A/B vs bare',
      frontierNoHarness: `${Math.round(bareRate * 100)}% bare accuracy`,
      weakWithPrjct: `${Math.round(harnessRate * 100)}% harness (+${delta.intentDeltaPp}pp, min +${DELTA_MIN_INTENT_PP})`,
      weakOk: harnessHits > bareHits && harnessRate >= DELTA_MIN_HARNESS_RATE && delta.allGreen,
    },
  ]
}

export function formatDemoMarkdown(rows: DemoRow[]): string {
  const delta = computeHarnessDelta()
  const lines = [
    '# Structural harness and synthetic routing fixtures',
    '',
    'Structural budgets and synthetic regex-routing fixtures only. No live model comparison was performed.',
    '',
    '| Capability | Baseline evidence | prjct measurement | Pass |',
    '|---|---|---|:---:|',
  ]
  for (const r of rows) {
    lines.push(
      `| ${r.capability} | ${r.frontierNoHarness} | ${r.weakWithPrjct} | ${r.weakOk ? '✓' : '✗'} |`
    )
  }
  const pass = rows.filter((r) => r.weakOk).length
  lines.push('')
  lines.push(`**Structural fixtures: ${pass}/${rows.length} SLOs**`)
  lines.push('')
  lines.push(delta.line)
  lines.push('')
  lines.push('Reproduce: `bun run demo:weak-vs-frontier` · also `bun run bench:weak-model`')
  return lines.join('\n')
}
