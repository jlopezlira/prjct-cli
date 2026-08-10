/**
 * Context cache tiers (Claude "Context Window Cache" pattern, model-agnostic).
 *
 * Named layers so agents stop stuffing L2/L3 into always-on L0.
 * Progressive disclosure already enforces L0 budgets (skill ≤900 tok,
 * routing ≤400B); this module is the **contract** agents can read and
 * harness-score can grade.
 *
 * | Tier | Load when | Content |
 * |------|-----------|---------|
 * | L0   | every turn | skill + routing block |
 * | L1   | SessionStart / prime | active work, pressure, land hand-off |
 * | L2   | on demand | search / guard / MCP recall |
 * | L3   | explicit | archive / distill / cold history |
 */

import { Buffer } from 'node:buffer'
import { countTokens } from '../tools/context/token-counter'
import { MINIMAL_ROUTING_BODY } from './routing-block'
import { buildPrjctSkill } from './skill-generator/prjct-skill-body'

/**
 * L0 budgets — keep in lockstep with WORLD_CLASS in harness-score.ts.
 * Duplicated here to avoid a circular import (harness-score → context-tiers).
 */
export const L0_SKILL_TOKENS_MAX = 1000
export const L0_ROUTING_BYTES_MAX = 400
/** Default MCP ListTools surface (core tier) — schema tokens every session. */
export const MCP_TOOLS_CORE_MAX = 12

export type ContextTierId = 'L0' | 'L1' | 'L2' | 'L3'

export interface ContextTierSpec {
  id: ContextTierId
  name: string
  /** When this tier is loaded into the model context. */
  load: string
  /** What belongs here. */
  contents: string[]
  /** How agents should pull (commands / tools). */
  pull: string
  /** Never put this tier's content into lower tiers. */
  antiPattern: string
}

/** Canonical four-tier contract (stable API for MCP + CLI). */
export const CONTEXT_TIERS: readonly ContextTierSpec[] = [
  {
    id: 'L0',
    name: 'always-on',
    load: 'every turn (skill + AGENTS/CLAUDE routing)',
    contents: ['prjct skill body', 'minimal routing map (work/ship/pull verbs)'],
    pull: 'installed skill + `AGENTS.md` / `CLAUDE.md` routing block',
    antiPattern: 'Do NOT paste memory dumps, full specs, or search results into L0.',
  },
  {
    id: 'L1',
    name: 'session',
    load: 'SessionStart / cold prime / `prjct prime`',
    contents: [
      'active work cycle',
      'context-pressure / loop cues',
      'last land hand-off (when present)',
      'persona + cold-start knowledge digest',
    ],
    pull: '`prjct work --md` · `prjct context --md` · SessionStart hook',
    antiPattern: 'Do NOT re-inject L1 on every UserPromptSubmit (cache thrash).',
  },
  {
    id: 'L2',
    name: 'pull',
    load: 'on demand when the turn needs prior knowledge',
    contents: [
      'memory search / topic recall',
      'file guard traps',
      'MCP prjct_* tools',
      'spec show / relevant files',
    ],
    pull: '`prjct search` · `prjct context memory <topic>` · `prjct guard <file>` · MCP',
    antiPattern: 'Do NOT copy L2 bodies into skill, routing, or always-on prompts.',
  },
  {
    id: 'L3',
    name: 'cold',
    load: 'explicit archive / distill / historical query only',
    contents: [
      'soft-deleted / archived memory',
      'distilled retention tails',
      'old ships beyond recent window',
      'checkpoint files under checkpoints/',
    ],
    pull: '`prjct land` Rho · archive surfaces · `prjct context-restore`',
    antiPattern: 'Do NOT load L3 wholesale into the hot window.',
  },
] as const

export interface L0BudgetMeasurement {
  skillTokens: number
  skillMax: number
  routingBytes: number
  routingMax: number
  skillOk: boolean
  routingOk: boolean
  /** Both L0 budgets within WORLD_CLASS SLOs. */
  ok: boolean
}

/** Measure live L0 footprint (skill + routing) against harness SLOs. */
export function measureL0Budget(): L0BudgetMeasurement {
  const skill = buildPrjctSkill()
  const skillTokens = countTokens(skill)
  const routingBytes = Buffer.byteLength(MINIMAL_ROUTING_BODY, 'utf-8')
  const skillOk = skillTokens <= L0_SKILL_TOKENS_MAX
  const routingOk = routingBytes <= L0_ROUTING_BYTES_MAX
  return {
    skillTokens,
    skillMax: L0_SKILL_TOKENS_MAX,
    routingBytes,
    routingMax: L0_ROUTING_BYTES_MAX,
    skillOk,
    routingOk,
    ok: skillOk && routingOk,
  }
}

export interface ContextTiersReport {
  tiers: readonly ContextTierSpec[]
  l0: L0BudgetMeasurement
  /** One-line rule agents must internalize. */
  rule: string
}

export function buildContextTiersReport(): ContextTiersReport {
  return {
    tiers: CONTEXT_TIERS,
    l0: measureL0Budget(),
    rule: 'Never stuff L2/L3 into L0. Pull L2 on demand; L3 only explicitly.',
  }
}

/** Compact one-liner for session/prime cues (≤120 chars ideal). */
export function contextTiersOneLiner(): string {
  return 'Context tiers: L0 always · L1 session/prime · L2 pull (search/guard/MCP) · L3 cold — never stuff L2 into L0.'
}

/** Markdown for `prjct context tiers --md` / MCP. */
export function formatContextTiersMd(
  report: ContextTiersReport = buildContextTiersReport()
): string {
  const lines: string[] = [
    '# prjct context cache tiers',
    '',
    report.rule,
    '',
    '| Tier | Name | Load | Pull |',
    '|---|---|---|---|',
  ]
  for (const t of report.tiers) {
    // No wrapping backticks: pull strings already contain `code` spans.
    const pull = t.pull.replace(/\|/g, '\\|')
    lines.push(`| **${t.id}** | ${t.name} | ${t.load} | ${pull} |`)
  }
  lines.push('')
  lines.push('## L0 budget (enforced)')
  lines.push('')
  lines.push(
    `- Skill: **${report.l0.skillTokens}** / ${report.l0.skillMax} tok ${report.l0.skillOk ? '✓' : '✗'}`
  )
  lines.push(
    `- Routing: **${report.l0.routingBytes}** / ${report.l0.routingMax} B ${report.l0.routingOk ? '✓' : '✗'}`
  )
  lines.push('')
  lines.push('## Anti-patterns')
  lines.push('')
  for (const t2 of report.tiers) {
    lines.push(`- **${t2.id}**: ${t2.antiPattern}`)
  }
  lines.push('')
  lines.push('## Contents by tier')
  lines.push('')
  for (const t3 of report.tiers) {
    lines.push(`### ${t3.id} — ${t3.name}`)
    for (const c of t3.contents) lines.push(`- ${c}`)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** Machine-readable payload (JSON CLI / MCP). */
export function formatContextTiersJson(
  report: ContextTiersReport = buildContextTiersReport()
): Record<string, unknown> {
  return {
    rule: report.rule,
    l0: report.l0,
    tiers: report.tiers.map((t) => ({
      id: t.id,
      name: t.name,
      load: t.load,
      contents: t.contents,
      pull: t.pull,
      antiPattern: t.antiPattern,
    })),
  }
}
