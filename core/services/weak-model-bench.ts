/**
 * Weak-model readiness + A/B vs frontier — release-blocking SLOs.
 *
 * North star: weak model + prjct ≥ frontier without harness on discipline
 * metrics (tokens, routing, intent verbs, structural grade). CI must stay green.
 *
 * Used by:
 *   - scripts/bench-weak-model.ts (CLI exit code)
 *   - core/__tests__/services/weak-model-bench.test.ts (CI gate)
 *   - weak-frontier-demo (public table shares intent fixtures)
 */

import { Buffer } from 'node:buffer'
import { getHarnessSurface, listHarnessSurfaces } from '../infrastructure/harness-surfaces'
import { DEFAULT_MCP_TOOL_TIER, resolveTier } from '../mcp/server'
import { SUPPORTED_PROVIDERS } from '../schemas/model'
import { countTokens } from '../tools/context/token-counter'
import { contentBoundDriftVerdict, stampFromContents } from './content-bound-stamp'
import { buildCycleBudgetCard } from './cycle-budget-card'
import { candidatesFromPreventive } from './decision-conflict'
import { intentGeometryVerdict } from './delivery-geometry'
import { planDoctorHeal } from './doctor-heal'
import { computeHarnessScore, WORLD_CLASS } from './harness-score'
import { rankByFactors, scoreReadyFactors } from './impact-ready'
import { INSTRUCTION_EVAL_THRESHOLDS, runInstructionEval } from './instruction-eval'
import { buildOneBreathReport } from './one-breath-install'
import {
  applyEvidenceTax,
  buildNextAction,
  findingDna,
  judgmentShipVerdict,
} from './precision-judgment'
import { MINIMAL_ROUTING_BODY } from './routing-block'
import { buildPrjctSkill } from './skill-generator/prjct-skill-body'
import { sotBindVerdict } from './sot-bind'
import { formatTrapSurfaceMessage, trapSurfaceSlo } from './trap-surface-slo'
import {
  buildDemoRows,
  computeHarnessDelta,
  routeIntent,
  routeIntentBare,
} from './weak-frontier-demo'

export interface WeakBenchCheck {
  name: string
  ok: boolean
  detail: string
}

export interface WeakBenchReport {
  checks: WeakBenchCheck[]
  passed: number
  total: number
  allGreen: boolean
  summary: string
}

export const INTENT_FIXTURES: ReadonlyArray<{ signal: string; verb: string }> = [
  { signal: 'sync the project', verb: 'sync' },
  { signal: 'search for auth decisions', verb: 'search' },
  { signal: 'remember this decision about caching', verb: 'remember' },
  { signal: 'fix the login bug', verb: 'work' },
  { signal: 'what should I work on next', verb: 'next' },
  { signal: 'ship the feature', verb: 'ship' },
  { signal: 'implement rate limiting', verb: 'work' },
  { signal: 'find gotchas on migrations', verb: 'search' },
  { signal: 'recall package legitimacy rules', verb: 'search' },
  { signal: 'open a pr for the fix', verb: 'ship' },
] as const

/** Absolute minimum checks that must stay green for release. */
export const WEAK_BENCH_MIN_PASS = 15

/**
 * Run every weak-model + A/B structural check (pure, no network, no disk install).
 */
export function runWeakModelBench(): WeakBenchReport {
  const checks: WeakBenchCheck[] = []
  const push = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail })
  }

  const skillTok = countTokens(buildPrjctSkill())
  push(
    'skill always-on',
    skillTok <= WORLD_CLASS.skillTokensMax,
    `${skillTok} tok (max ${WORLD_CLASS.skillTokensMax})`
  )

  const routingB = Buffer.byteLength(MINIMAL_ROUTING_BODY, 'utf-8')
  push(
    'routing body',
    routingB <= WORLD_CLASS.routingBodyBytesMax,
    `${routingB} bytes (max ${WORLD_CLASS.routingBodyBytesMax})`
  )

  push(
    'MCP default',
    resolveTier(undefined) === 'core' && DEFAULT_MCP_TOOL_TIER === 'core',
    `tier=${resolveTier(undefined)}`
  )

  const providers = SUPPORTED_PROVIDERS.length
  push(
    'provider maps',
    providers >= WORLD_CLASS.providerMapsMin,
    `${providers} providers (min ${WORLD_CLASS.providerMapsMin})`
  )

  const score = computeHarnessScore()
  push(
    'harness score',
    score.structuralReady && score.grade >= 4.5,
    `structural grade ${score.grade}/5; outcome evidence=${score.outcomeEvidence.status}`
  )

  push(
    'MCP tool surface',
    score.defaults.mcpToolCountDefault <= WORLD_CLASS.mcpToolsCoreMax,
    `${score.defaults.mcpToolCountDefault} tools at default`
  )

  const intentResults = INTENT_FIXTURES.map((fixture) => ({
    fixture,
    routed: routeIntent(fixture.signal),
    bare: routeIntentBare(fixture.signal),
  }))
  for (const result of intentResults) {
    const ok = result.routed === result.fixture.verb
    push(`intent:${result.fixture.verb}`, ok, `"${result.fixture.signal}" → ${result.routed}`)
  }
  const harnessHits = intentResults.filter((result) => result.routed === result.fixture.verb).length
  const bareHits = intentResults.filter((result) => result.bare === result.fixture.verb).length

  const harnessRate = harnessHits / INTENT_FIXTURES.length
  const bareRate = bareHits / INTENT_FIXTURES.length
  push(
    'intent routing accuracy',
    harnessRate >= 0.95,
    `${Math.round(harnessRate * 100)}% (need ≥95%)`
  )
  push(
    'intent A/B beats bare',
    harnessHits > bareHits,
    `harness ${harnessHits}/${INTENT_FIXTURES.length} vs bare ${bareHits}/${INTENT_FIXTURES.length} (${Math.round(bareRate * 100)}%)`
  )

  const instructionEval = runInstructionEval()
  push(
    'instruction replay evidence',
    instructionEval.evidenceKind === 'deterministic-structural-replay' &&
      instructionEval.liveModelEvidence === false &&
      instructionEval.fixtureCount === 48,
    `${instructionEval.fixtureCount} frozen sanitized cases (${instructionEval.productionSeamCases} production-seam, ${instructionEval.structuralContractCases} structural-contract) — deterministic structural evidence, not live-model evidence`
  )
  push(
    'instruction replay adherence delta',
    instructionEval.adherenceDeltaPp >= INSTRUCTION_EVAL_THRESHOLDS.adherenceDeltaPpMin,
    `+${instructionEval.adherenceDeltaPp}pp (min +${INSTRUCTION_EVAL_THRESHOLDS.adherenceDeltaPpMin}pp)`
  )
  push(
    'instruction replay runtime regressions',
    instructionEval.maxRuntimeRegressionPp <= INSTRUCTION_EVAL_THRESHOLDS.runtimeRegressionPpMax,
    `${Object.entries(instructionEval.byRuntime)
      .map(([runtime, result]) => `${runtime}=${result.regressionPp}pp`)
      .join(' · ')} (max ${INSTRUCTION_EVAL_THRESHOLDS.runtimeRegressionPpMax}pp)`
  )
  push(
    'instruction replay false triggers',
    instructionEval.falseTriggerRate < INSTRUCTION_EVAL_THRESHOLDS.falseTriggerRateMaxExclusive,
    `${instructionEval.falsePositives}/${instructionEval.guidanceActivations} activations (${(
      instructionEval.falseTriggerRate * 100
    ).toFixed(1)}%, need <${INSTRUCTION_EVAL_THRESHOLDS.falseTriggerRateMaxExclusive * 100}%)`
  )
  push(
    'instruction replay attribution',
    instructionEval.attributionRate >= INSTRUCTION_EVAL_THRESHOLDS.attributionRateMin,
    `${instructionEval.attributedCases}/${instructionEval.attributableCases} attributable cases (${(
      instructionEval.attributionRate * 100
    ).toFixed(
      1
    )}%, need ≥${INSTRUCTION_EVAL_THRESHOLDS.attributionRateMin * 100}%) through production runtime/model attribution`
  )

  const demo = buildDemoRows()
  const demoFail = demo.filter((r) => !r.weakOk)
  push(
    'weak-vs-frontier demo',
    demoFail.length === 0,
    `${demo.length - demoFail.length}/${demo.length} demo SLOs`
  )

  // Dynasty public proof weapon — same Δ table as `prjct harness score`
  const delta = computeHarnessDelta()
  push('harness delta all-green', delta.allGreen, delta.line)
  push(
    'harness delta intent gap',
    delta.intentDeltaPp >= delta.minIntentDeltaPp && delta.harnessHits > delta.bareHits,
    `+${delta.intentDeltaPp}pp (min +${delta.minIntentDeltaPp}) harness ${delta.harnessHits}/${delta.fixtureCount} vs bare ${delta.bareHits}/${delta.fixtureCount}`
  )

  // Multi-runtime wire is structural (adapters exist) — not live disk probe
  // (CI runners don't install Claude/Codex). Proves the moat ship surface.
  const codex = getHarnessSurface('codex')
  const gemini = getHarnessSurface('gemini')
  const cursor = getHarnessSurface('cursor')
  const grok = getHarnessSurface('grok')
  push(
    'codex hooks+MCP native',
    codex?.hooks.prjct === 'native' && codex?.mcp.prjct === 'native',
    `hooks=${codex?.hooks.prjct} mcp=${codex?.mcp.prjct}`
  )
  push(
    'gemini hooks+MCP native',
    gemini?.hooks.prjct === 'native' && gemini?.mcp.prjct === 'native',
    `hooks=${gemini?.hooks.prjct} mcp=${gemini?.mcp.prjct}`
  )
  push('cursor hooks native', cursor?.hooks.prjct === 'native', `hooks=${cursor?.hooks.prjct}`)
  push(
    'grok mcp+skills native',
    grok?.mcp.prjct === 'native' && grok?.skills.prjct === 'native',
    `mcp=${grok?.mcp.prjct} skills=${grok?.skills.prjct}`
  )
  push(
    'grok hooks inherits-claude',
    grok?.hooks.prjct === 'inherits-claude',
    `hooks=${grok?.hooks.prjct}`
  )

  const surfaceIds = new Set(listHarnessSurfaces().map((s) => s.runtimeId))
  push(
    'benchmark surface matrix',
    ['claude', 'codex', 'gemini', 'grok', 'cursor'].every((id) => surfaceIds.has(id as never)),
    `${surfaceIds.size} surfaces in matrix`
  )

  // Precision judgment v2 — structural dominance vs gentle-ai 4R prose
  {
    const tax = applyEvidenceTax({
      id: 't',
      severity: 'blocker',
      status: 'candidate',
      title: 'vibes only',
    })
    push(
      'judgment evidence tax',
      tax.severity === 'critical',
      `blocker-without-locus → ${tax.severity}`
    )
    const ship = judgmentShipVerdict({
      codeStrict: true,
      intensity: 'full',
      ledger: null,
      override: false,
    })
    push(
      'judgment ship teeth',
      ship.blocked && ship.mode === 'hard',
      `code-strict full without ledger blocked=${ship.blocked}`
    )
    const next = buildNextAction(null, 'full')
    push(
      'judgment next card',
      next.kind === 'open_ledger' && Boolean(next.judgeCharters?.red),
      `kind=${next.kind} has RED charter`
    )
    const dnaA = findingDna({ title: 'Auth hole', file: 'a.ts', line: 10 })
    const dnaB = findingDna({ title: 'auth hole!', file: 'a.ts', line: 12 })
    push('judgment DNA stable', dnaA === dnaB, dnaA)
  }

  // Content-bound approve stamp (Dynasty D2 / gentle-ai v2 residual)
  {
    const s = stampFromContents(
      [
        { path: 'core/a.ts', content: 'export const a = 1\n' },
        { path: 'core/b.ts', content: 'export const b = 2\n' },
      ],
      { stampedAt: 't0' }
    )
    const s2 = stampFromContents(
      [
        { path: 'core/b.ts', content: 'export const b = 2\n' },
        { path: 'core/a.ts', content: 'export const a = 1\n' },
      ],
      { stampedAt: 't1' }
    )
    push('content-bound tree stable', s.treeHash === s2.treeHash, s.treeHash.slice(0, 12))
    const drift = contentBoundDriftVerdict({
      stamp: s,
      currentTreeHash: stampFromContents([{ path: 'core/a.ts', content: 'CHANGED' }], {
        stampedAt: 't2',
      }).treeHash,
      hard: true,
    })
    push(
      'content-bound drift blocks',
      drift.blocked && drift.reason === 'drift',
      `reason=${drift.reason}`
    )
  }

  // SoT hard-bind + trap-before-edit SLO (Dynasty D3)
  {
    const sotCand = candidatesFromPreventive([
      {
        id: 'mem_sot_bench',
        type: 'gotcha',
        content: 'Never delete worktree with unpushed commits without check',
      },
    ])
    const h2 = sotBindVerdict({ harnessLevel: 'H2', candidates: sotCand })
    push(
      'sot-bind H2 denies',
      h2.action === 'deny' && h2.reason === 'h2-sot-deny',
      `action=${h2.action}`
    )
    const h0 = sotBindVerdict({ harnessLevel: 'H0', candidates: sotCand })
    push('sot-bind H0 open', h0.action === 'none', `action=${h0.action}`)
    const trapMsg = formatTrapSurfaceMessage('x.ts', [
      { id: 'mem_t1', type: 'gotcha', title: 'trap one' },
      { id: 'mem_t2', type: 'decision', title: 'trap two' },
    ])
    const slo = trapSurfaceSlo({ trapIds: ['mem_t1', 'mem_t2'], message: trapMsg })
    push('trap-surface SLO 100%', slo.ok && slo.rate === 1, slo.line)
  }

  // Impact-ranked next + geometry-at-intent (Dynasty D4)
  {
    const high = scoreReadyFactors({
      unblocks: 2,
      priorityPts: 25,
      ageDays: 1,
      impactNeighbors: 2,
      impactTraps: 1,
      sotPressure: 1,
    })
    const low = scoreReadyFactors({
      unblocks: 0,
      priorityPts: 50,
      ageDays: 10,
      impactNeighbors: 0,
      impactTraps: 0,
      sotPressure: 0,
    })
    push('impact-rank unblocks wins', high > low, `high=${high} low=${low}`)
    const ranked = rankByFactors([
      {
        id: 'low',
        description: 'low',
        type: null,
        priority: 'high',
        section: null,
        claimedBy: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        unblocks: 0,
        factors: {
          unblocks: 0,
          priorityPts: 50,
          ageDays: 10,
          impactNeighbors: 0,
          impactTraps: 0,
          sotPressure: 0,
        },
      },
      {
        id: 'high',
        description: 'high',
        type: null,
        priority: 'medium',
        section: null,
        claimedBy: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        unblocks: 3,
        factors: {
          unblocks: 3,
          priorityPts: 25,
          ageDays: 1,
          impactNeighbors: 1,
          impactTraps: 0,
          sotPressure: 0,
        },
      },
    ])
    push('impact-rank order', ranked[0]?.id === 'high', `top=${ranked[0]?.id}`)
    push(
      'impact-rank why line',
      Boolean(ranked[0]?.why?.startsWith('why next:')),
      ranked[0]?.why ?? ''
    )
    const ig = intentGeometryVerdict({
      harnessLevel: 'H3',
      harnessRisk: 'high',
      mode: 'strict',
      explicitGeometry: null,
    })
    push(
      'intent-geometry H3 strict blocks',
      ig.blocked && ig.reason === 'h2-intent-strict',
      `reason=${ig.reason}`
    )
    const igOk = intentGeometryVerdict({
      harnessLevel: 'H3',
      mode: 'strict',
      explicitGeometry: 'split',
    })
    push('intent-geometry override', !igOk.blocked && igOk.reason === 'has-geometry', igOk.reason)
  }

  // Skill floor + cycle budget (Dynasty D5)
  {
    push('skill diet ≤900', skillTok <= 900, `${skillTok} tok (Dynasty floor ≤900)`)
    const card = buildCycleBudgetCard({
      turns: 0,
      turnLimit: 15,
      tokensSpent: 0,
      tokenBudget: 50_000,
      pressureLevel: 'ok',
    })
    push(
      'cycle budget card',
      card.line.includes('Cycle budget') && card.line.includes('turns 0/15'),
      card.line
    )
  }

  // One-breath install + doctor heal plan (Dynasty D6)
  {
    const ritual = buildOneBreathReport({
      claudeHooksNew: 1,
      claudeHooksPresent: 10,
      runtimesWired: ['claude', 'codex'],
      liveCount: 2,
      detectedCount: 2,
      organicPct: 100,
      deltaLine: 'Harness Δ: PASS',
    })
    push(
      'one-breath install PASS',
      ritual.organicOk && ritual.line.includes('One-breath'),
      ritual.line
    )
    const heal = planDoctorHeal({
      hooksInstalled: 5,
      hooksExpected: 12,
      liveCount: 1,
      detectedCount: 3,
      organicPct: 33,
    })
    push(
      'doctor heal plans repairs',
      heal.neededCount >= 2 && heal.actions.some((a) => a.id === 'claude-hooks' && a.needed),
      heal.line
    )
  }

  const passed = checks.filter((c) => c.ok).length
  const total = checks.length
  const allGreen = passed === total && total >= WEAK_BENCH_MIN_PASS
  const summary = allGreen
    ? `Weak-model A/B PASS (${passed}/${total}) — release gate green`
    : `Weak-model A/B FAIL (${passed}/${total}) — red: ${checks
        .filter((c) => !c.ok)
        .map((c) => c.name)
        .join(', ')}`

  return { checks, passed, total, allGreen, summary }
}

export function formatWeakBenchMarkdown(report: WeakBenchReport): string {
  const lines = [
    '# Weak-model A/B (release gate)',
    '',
    report.summary,
    '',
    '| Check | Detail | Pass |',
    '|---|---|:---:|',
  ]
  for (const c of report.checks) {
    lines.push(`| ${c.name} | ${c.detail} | ${c.ok ? '✓' : '✗'} |`)
  }
  lines.push('')
  lines.push('Reproduce: `bun run bench:weak-model` · `bun run demo:weak-vs-frontier`')
  return lines.join('\n')
}
