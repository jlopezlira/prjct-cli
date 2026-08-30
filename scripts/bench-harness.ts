/**
 * Harness benchmark — runs the REAL harness functions over the current code and
 * prints token footprint, model-routing cost, and specialist-selection numbers.
 *
 *   Run from the repo root:  bun scripts/bench-harness.ts
 *
 * This covers the DETERMINISTIC, importable measurements. Two environment-timed
 * numbers are measured separately (they depend on the machine, not the code):
 *   - per-turn hook latency:  echo '{"prompt":"x"}' | bun bin/prjct.ts hook prompt
 *   - gate perf:              time bun test / npx tsc -p core/tsconfig.json / node scripts/build.js
 */

import fs from 'node:fs'
import {
  MINIMAL_ROUTING_BODY,
  ROUTING_END_MARKER,
  ROUTING_START_MARKER,
} from '../core/services/routing-block'
import { selectReviewers } from '../core/services/spec-audit-dispatch'
import { countTokens } from '../core/tools/context/token-counter'
import { emptySpecContent } from '../core/types/spec'
import type { DomainDefinition } from '../core/types/storage/extended'

const line = (s = '') => console.log(s)
const usd = (n: number) => `$${n.toFixed(5)}`
const FULL_BLOCK = `${ROUTING_START_MARKER}\n${MINIMAL_ROUTING_BODY}\n${ROUTING_END_MARKER}\n`
/** "N× cheaper" when ratio>1, "N× pricier" when <1 — never the confusing "0.2× cheaper". */
const factor = (base: number, c: number) =>
  c <= base
    ? `${(base / c).toFixed(1)}× cheaper than sonnet`
    : `${(c / base).toFixed(1)}× pricier than sonnet`

// ── 1. TOKEN FOOTPRINT (always-loaded harness surfaces) ──────────────────────
line('## 1. Token footprint — recurring harness cost')
const skill = fs.readFileSync('templates/skills/prjct/SKILL.md', 'utf8')
const skillTok = countTokens(skill)
const mapTok = countTokens(FULL_BLOCK)
// Representative per-turn state block (active cycle + git + queue). The loop
// discipline cue is cadenced (every 10 turns), not per-turn, so it's excluded.
const stateBlock = [
  '# prjct: project state',
  '- Active work cycle: "implement rate limiting on the auth endpoints" (2h ago) [main]',
  '- Pending: 2 · Next: "wire the redis client"',
  '- Branch: feat/x — working tree 3 modified, 1 staged',
  '- Last shipped: v3.9.0 (today)',
].join('\n')
const stateTok = countTokens(stateBlock)
line(`SKILL.md (loaded once/session):     ${skillTok} tok  (${skill.length} bytes)`)
line(`AGENTS/CLAUDE map (once/session):   ${mapTok} tok  (${FULL_BLOCK.length} bytes)`)
line(`Per-turn state block (every turn):  ${stateTok} tok  (${stateBlock.length} bytes)`)
line(
  `→ Cold-start fixed cost: ${skillTok + mapTok} tok. Per-turn marginal: ${stateTok} tok (10-turn session ≈ ${skillTok + mapTok + stateTok * 10} tok total harness overhead).`
)
line()

// ── 2. GAP-2 model routing — cost per review ─────────────────────────────────
line('## 2. Model routing (GAP 2) — $/review by capability class')
// Public pricing per 1000 tokens (mirrors token-counter.ts MODEL_PRICING).
const P = {
  'opus-4 (legacy frontier)': { in: 0.015, out: 0.075 },
  'opus-4.5 (frontier)': { in: 0.005, out: 0.025 },
  'sonnet (balanced/default)': { in: 0.003, out: 0.015 },
  'haiku (fast)': { in: 0.001, out: 0.005 },
  'gpt-4o-mini (cross-rig SLM)': { in: 0.00015, out: 0.0006 },
}
// One reviewer: reads spec (~500 tok) + code (~3500) = 4000 in; verdict+notes = 400 out.
const IN = 4000
const OUT = 400
const cost = (p: { in: number; out: number }) => (IN / 1000) * p.in + (OUT / 1000) * p.out
const base = cost(P['sonnet (balanced/default)'])
for (const [name, p] of Object.entries(P)) {
  line(`  ${name.padEnd(28)} ${usd(cost(p))}  (${factor(base, cost(p))})`)
}
const opusLegacy = cost(P['opus-4 (legacy frontier)'])
const slm = cost(P['gpt-4o-mini (cross-rig SLM)'])
line(
  `→ Intra-Claude: a narrow lens sonnet→haiku = ${(base / cost(P['haiku (fast)'])).toFixed(1)}× cheaper. Cross-rig SLM ceiling (frontier→gpt-4o-mini): ${(opusLegacy / slm).toFixed(0)}× cheaper — the "137x" regime.`
)
line(
  `→ A 5-reviewer audit: all-sonnet ${usd(base * 5)} vs routing 2 narrow lenses to haiku ${usd(base * 3 + cost(P['haiku (fast)']) * 2)} (${(((base * 5 - (base * 3 + cost(P['haiku (fast)']) * 2)) / (base * 5)) * 100).toFixed(0)}% saved on that audit).`
)
line()

// ── 3. Specialist selection quality (GAP 1 + dynamic lenses) ─────────────────
line('## 3. Specialist selection — selectReviewers over a battery of specs')
const domains: DomainDefinition[] = [
  {
    name: 'auth',
    description: 'Authentication + sessions',
    keywords: ['login', 'session', 'token'],
    filePatterns: ['**/auth/**'],
    fileCount: 12,
  },
  {
    name: 'billing',
    description: 'Stripe billing + invoices',
    keywords: ['stripe', 'invoice', 'charge'],
    filePatterns: ['**/billing/**'],
    fileCount: 8,
  },
]
const specs: Array<[string, ReturnType<typeof emptySpecContent>]> = [
  ['trivial typo fix', emptySpecContent('Fix a typo in the README')],
  ['auth + migration', emptySpecContent('Add token auth with a DB schema migration')],
  ['CLI surface', emptySpecContent('New CLI command with --flag output')],
  ['perf hot path', emptySpecContent('Cache the hot path to cut latency')],
]
const bigRefactor = emptySpecContent('Big risky refactor of the stripe invoice charge flow')
bigRefactor.scope = ['core/billing/charge.ts', 'a', 'b', 'c']
bigRefactor.stakes = 'breaks revenue if wrong'
specs.push(['billing refactor (domain)', bigRefactor])

for (const [name, c] of specs) {
  const fn = selectReviewers(c)
  const added = selectReviewers(c, domains).filter((l) => !fn.includes(l))
  line(
    `  ${name.padEnd(26)} fn-lenses: [${fn.join(', ')}]${added.length ? `  +domain: [${added.join(', ')}]` : ''}`
  )
}
line(
  '→ architecture is always the floor; lenses scale with risk; domain experts attach only when the change touches them.'
)
