/**
 * Triage → orchestration. The harness (`buildTaskHarness`) classifies each
 * task into a level (H0-H3), kind, and risk. That classification gated
 * EVIDENCE, but nothing routed the *LLM resource* — so a trivial docs edit and
 * a security migration both ran on whatever (often frontier) model the parent
 * agent happened to be on, and any subagents INHERITED that expensive model
 * (mem_3432). That is burning tokens.
 *
 * This module turns the triage into a concrete, correct orchestration plan:
 * which model tier + effort THIS task deserves, whether it needs a spec (SDD),
 * tests-first (TDD), and whether to do it directly or fan out to a group of
 * subagents — and it always reminds the agent to SET each subagent's model
 * (they inherit the parent's otherwise). The project's `sdd`/`tdd` modes are
 * reconciled as a FLOOR over the risk-based default (strict forces the
 * ceremony even on a low-risk task; the triage can only ADD ceremony, never
 * remove what a mode requires).
 *
 * Deterministic + free (no LLM call to decide how to spend the LLM).
 */

import type { HarnessKind, HarnessLevel, HarnessRisk, TaskHarness } from '../schemas/state'
import {
  type AgentCastMember,
  castForFanout,
  formatAgentCastDispatchHint,
  formatAgentCastLine,
} from './agent-codenames'
import { type QualityCeremony, SHIP_USER_ONLY } from './judgment-orchestrator'

/** Rig-agnostic capability tier (see core/schemas/model.ts MODEL_TIERS). */
export type ModelTier = 'fast' | 'balanced' | 'frontier'
export type Effort = 'low' | 'medium' | 'high'
/** none = skip; frame = lightweight `prjct spec`; reviewed = spec + audit panel. */
export type SpecCeremony = 'none' | 'frame' | 'reviewed'
/** none = skip; after = test the change; first = tests before implementation. */
export type TestCeremony = 'none' | 'after' | 'first'
/** direct = do it yourself; parallel = independent subagents; crew = leader + review crew. */
export type FanOut = 'direct' | 'parallel' | 'crew'
/** none = skip judgment; standard/full = auto ledger + inject next card (never auto-ship). */
export type { QualityCeremony }

export type SddMode = 'off' | 'advisory' | 'strict'
export type TddMode = 'off' | 'assist' | 'strict'

export interface OrchestrationPlan {
  model: ModelTier
  effort: Effort
  spec: SpecCeremony
  tests: TestCeremony
  fanout: FanOut
  /** Precision judgment ceremony — orchestrator opens ledger when not none. */
  quality: QualityCeremony
  /**
   * Size estimate in points (1/2/5/8 by harness level). Stored on the task at
   * start and compared against the ACTUAL diff at completion — the estimation
   * loop that teaches velocity the dev's estimation bias.
   */
  expectedPoints: number
  /** Agent-facing one-block directive — how to run THIS task efficiently. */
  directive: string
  /**
   * Cute durable cast for multi-agent fan-out (Codex-style codenames).
   * Empty when fanout is direct.
   */
  cast: AgentCastMember[]
}

const SPEC_RANK: Record<SpecCeremony, number> = { none: 0, frame: 1, reviewed: 2 }
const TEST_RANK: Record<TestCeremony, number> = { none: 0, after: 1, first: 2 }
const maxSpec = (a: SpecCeremony, b: SpecCeremony): SpecCeremony =>
  SPEC_RANK[a] >= SPEC_RANK[b] ? a : b
const maxTest = (a: TestCeremony, b: TestCeremony): TestCeremony =>
  TEST_RANK[a] >= TEST_RANK[b] ? a : b

/** Is this a code-touching task (docs/chore never need spec/tests)? */
function isCodeKind(kind: HarnessKind): boolean {
  return kind !== 'docs' && kind !== 'chore'
}

/** Risk-based defaults per harness level (before SDD/TDD mode floors). */
function baseline(level: HarnessLevel, kind: HarnessKind, risk: HarnessRisk): OrchestrationPlan {
  const code = isCodeKind(kind)
  // Research is the parallel case regardless of level: independent sweep
  // angles (per source/subsystem/competitor) are exactly what subagent
  // fan-out is for — one context reading everything serially wastes both
  // wall-clock and quality. Meta-finding from the 2026-07 harness research:
  // our own triage classified a 3-way competitive investigation as 'direct'.
  if (kind === 'research') {
    return {
      model: 'balanced',
      effort: 'medium',
      spec: 'none',
      tests: 'none',
      fanout: 'parallel',
      quality: 'none',
      expectedPoints: 2,
      directive: '',
      cast: [],
    }
  }
  switch (level) {
    case 'H0':
      // Trivial (docs/chore). Do NOT spend a frontier model on this.
      return {
        model: 'fast',
        effort: 'low',
        spec: 'none',
        tests: 'none',
        fanout: 'direct',
        quality: 'none',
        expectedPoints: 1,
        directive: '',
        cast: [],
      }
    case 'H1':
      // Simple bug/change. Fix directly on a balanced model; leave a test behind.
      return {
        model: 'balanced',
        effort: 'medium',
        spec: 'none',
        tests: code ? 'after' : 'none',
        fanout: 'direct',
        quality: code ? 'standard' : 'none',
        expectedPoints: 2,
        directive: '',
        cast: [],
      }
    case 'H2':
      // Substantial feature/refactor. Frame a lightweight spec, tests first,
      // frontier for the implementation; fan out only if scope is separable.
      return {
        model: 'frontier',
        effort: 'medium',
        spec: code ? 'frame' : 'none',
        tests: code ? 'first' : 'none',
        fanout: 'parallel',
        quality: code ? 'standard' : 'none',
        expectedPoints: 5,
        directive: '',
        cast: [],
      }
    default:
      // H3 — high-risk (security / architecture / migration). Full ceremony.
      return {
        model: 'frontier',
        effort: risk === 'high' ? 'high' : 'medium',
        spec: code ? 'reviewed' : 'none',
        tests: code ? 'first' : 'none',
        fanout: 'crew',
        // Security / high-risk always full dual-blind quality.
        quality: kind === 'security' || risk === 'high' || code ? 'full' : 'none',
        expectedPoints: 8,
        directive: '',
        cast: [],
      }
  }
}

/** SDD/TDD project modes are a FLOOR: they can only ADD ceremony. */
function applyModeFloors(
  plan: OrchestrationPlan,
  kind: HarnessKind,
  sdd: SddMode,
  tdd: TddMode
): OrchestrationPlan {
  if (!isCodeKind(kind)) return plan
  const spec =
    sdd === 'strict'
      ? maxSpec(plan.spec, 'reviewed')
      : maxSpec(plan.spec, sdd === 'advisory' ? 'frame' : 'none')
  const tests =
    tdd === 'strict'
      ? maxTest(plan.tests, 'first')
      : maxTest(plan.tests, tdd === 'assist' ? 'after' : 'none')
  return { ...plan, spec, tests }
}

const SPEC_TEXT: Record<SpecCeremony, string> = {
  none: 'no spec',
  frame: 'frame a lightweight spec (`prjct spec "<title>"`)',
  reviewed: 'reviewed spec + audit panel (`prjct spec "<title>"` → `prjct spec audit <id>`)',
}
const TEST_TEXT: Record<TestCeremony, string> = {
  none: 'no test ceremony',
  after: 'leave a regression test behind',
  first: 'tests BEFORE implementation',
}
const FANOUT_TEXT: Record<FanOut, string> = {
  direct: 'do it yourself — no subagents',
  parallel:
    'DEFAULT multi-agent geometry: explore (fast) → implement (frontier) → review (balanced dual-blind); set EACH subagent model explicitly (they inherit yours otherwise: mem_3432). Stay single-thread only for a truly atomic one-file fix',
  crew: 'DEFAULT crew geometry (`prjct crew`): leader + implementer + review lenses. Set EACH subagent model (Explore→fast, implementer→frontier, reviewers→balanced) — they inherit your expensive model unless you fix it',
}
const QUALITY_TEXT: Record<QualityCeremony, string> = {
  none: 'no judgment tax (trivial)',
  standard:
    'quality auto: ledger opened; follow injected `prjct judgment next` card (one review + batch challenge)',
  full: 'quality auto: ledger opened; follow injected next card (RED+BLUE dual-blind + batch refuters)',
}
const MODEL_HINT: Record<ModelTier, string> = {
  fast: 'fast/cheap model (e.g. haiku)',
  balanced: 'balanced model (e.g. sonnet)',
  frontier: 'frontier model (e.g. opus)',
}

/**
 * Review-workload forecast: reviewability is a PRE-implementation constraint,
 * not a post-hoc apology. Substantial work must estimate its diff size and
 * pick a delivery strategy BEFORE writing code (the harness separately warns
 * when an actual diff crosses 400 changed lines).
 */
const FORECAST_TEXT =
  'Before implementing, forecast the diff size: if it will exceed ~400 changed lines, decide the delivery strategy NOW (split into stacked PRs / ship a first slice) instead of producing one unreviewable diff.'

/** Compose the agent-facing directive block from the resolved plan. */
function renderDirective(level: HarnessLevel, kind: HarnessKind, plan: OrchestrationPlan): string {
  const effortNote =
    plan.effort === 'high' ? ', HIGH effort' : plan.effort === 'low' ? ', low effort' : ''
  if (level === 'H0') {
    return `Orchestrate (${level} ${kind}): trivial — do it directly on a ${MODEL_HINT[plan.model]}${effortNote}. ${SPEC_TEXT[plan.spec]}, ${TEST_TEXT[plan.tests]}, ${FANOUT_TEXT[plan.fanout]}. ${QUALITY_TEXT[plan.quality]}. Don’t burn frontier tokens on this. ${SHIP_USER_ONLY}`
  }
  const forecast = level === 'H2' || level === 'H3' ? ` ${FORECAST_TEXT}` : ''
  const multi =
    plan.fanout === 'parallel' || plan.fanout === 'crew'
      ? ' Multi-agent is the DEFAULT geometry for this harness class — do not collapse to a single-thread monologue unless the change is truly atomic.'
      : ''
  const castLine =
    plan.cast.length > 0
      ? ` ${formatAgentCastLine(plan.cast)}. ${formatAgentCastDispatchHint(plan.cast)}`
      : ''
  return `Orchestrate (${level} ${kind}/${plan.model}${effortNote}): ${SPEC_TEXT[plan.spec]}; ${TEST_TEXT[plan.tests]}; ${FANOUT_TEXT[plan.fanout]}; ${QUALITY_TEXT[plan.quality]}.${forecast}${multi}${castLine} ${SHIP_USER_ONLY}`
}

/**
 * Actual size in points from the completed diff's changed-line count — the
 * same scale expectedPoints uses, so accuracy is a like-for-like comparison.
 */
export function pointsFromDiffLines(changedLines: number): number {
  if (changedLines < 50) return 1
  if (changedLines < 150) return 2
  if (changedLines < 400) return 5
  return 8
}

/**
 * Delegation trigger — the multi-file write reminder, shared by the Claude
 * per-turn hook (event-counted) and the rig-agnostic `prjct work`/`status`
 * surfaces (git-counted). Returns null under threshold.
 *
 * The text deliberately names the BAND, not the live file count. Callers gate
 * re-delivery on content, so embedding the running count (…20 files, …21
 * files) made the string change every turn and defeated the gate: the notice
 * re-fired on every single turn for the rest of the cycle.
 *
 * It also states the fact and the check, never the verdict. A wide file count
 * is normal for a rename, a codemod, or removing a policy — "this is no longer
 * one change" is a guess prjct cannot make from a count, and repeating it at a
 * working agent is noise.
 */
export function renderDelegationTrigger(filesTouched: number): string | null {
  if (filesTouched >= 8) {
    return '⚠ Delegation trigger: 8+ files edited this cycle. Wide edits hide cross-file breaks — review the full diff with fresh eyes before `prjct status done`. If the remainder is genuinely separate work, split it into its own cycle/PR; if it is one coherent change, carry on.'
  }
  if (filesTouched >= 4) {
    return '↳ Delegation trigger: 4+ files edited this cycle. Keep ONE writer thread; before closing, review the full diff with fresh eyes — multi-file changes hide cross-file breaks.'
  }
  return null
}

/**
 * The public entrypoint: given the triage harness and the project's SDD/TDD
 * modes, produce the orchestration plan + its agent-facing directive.
 * Optional weakModelMode elevates quality ceremony (product mode).
 */
export function orchestrationFor(
  harness: Pick<TaskHarness, 'level' | 'kind' | 'risk'>,
  sdd: SddMode = 'off',
  tdd: TddMode = 'off',
  weakModelMode: 'off' | 'on' = 'off',
  /**
   * Seed for durable agent cast names (description + cycle id). Defaults to
   * kind+level so plans stay deterministic in tests without a description.
   */
  castSeed?: string
): OrchestrationPlan {
  const base = baseline(harness.level, harness.kind, harness.risk)
  const withFloors = applyModeFloors(base, harness.kind, sdd, tdd)
  const quality =
    weakModelMode === 'on' && withFloors.quality === 'none'
      ? 'standard'
      : weakModelMode === 'on' && withFloors.quality === 'standard'
        ? 'full'
        : withFloors.quality
  const seed = (castSeed ?? `${harness.level}:${harness.kind}:${harness.risk}`).trim()
  const cast = castForFanout(withFloors.fanout, seed)
  const plan: OrchestrationPlan = { ...withFloors, quality, cast }
  return { ...plan, directive: renderDirective(harness.level, harness.kind, plan) }
}
