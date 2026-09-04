/**
 * QA gate — pure verdicts, all I/O in the callers (like `gauntletShipVerdict`
 * and `contradictoryReviewGate`).
 *
 * Invariants:
 *   - `author` evidence (the implementing agent's own word) never satisfies
 *     `strict`; only a machine probe or the blind QA subagent does.
 *   - A RED receipt still bound to HEAD blocks ship at every mode.
 *   - A stale receipt (HEAD moved / >30 min) means the probes verified
 *     something else — strict re-runs, advisory warns.
 */

import type { QaCriterion, QaFlow, QaMode, QaPlan, QaReceipt } from '../schemas/qa'
import type { HarnessLevel } from '../schemas/state'
import type { LocalConfig } from '../types/config'
import { isReceiptFresh } from './gauntlet'
import { QA_PLAN_JSON_HINT, qaPlanSummary } from './qa-plan'
import type { VerificationBinding } from './verification-binding'

const QA_MODE_VALUES: readonly QaMode[] = ['off', 'advisory', 'strict']

/**
 * config → env → pack → off. Pack-gated when unset (like `judgment.conflictMode`)
 * so projects that activated `code` before this existed still get it.
 */
export function effectiveQaMode(config: LocalConfig | null): QaMode {
  const fromConfig = config?.qa?.mode
  if (fromConfig && QA_MODE_VALUES.includes(fromConfig)) return fromConfig
  const fromEnv = process.env.PRJCT_QA_MODE?.toLowerCase()
  if (fromEnv && (QA_MODE_VALUES as readonly string[]).includes(fromEnv)) return fromEnv as QaMode
  const packs = config?.persona?.packs ?? []
  if (packs.includes('code-strict')) return 'strict'
  if (packs.includes('code')) return 'advisory'
  return 'off'
}

/** H0 (smoke/trivial) never carries a QA phase. Unknown level ⇒ applies. */
export function qaAppliesTo(level: HarnessLevel | undefined, mode: QaMode): boolean {
  return mode !== 'off' && level !== 'H0'
}

export function flowVerified(flow: QaFlow, mode: QaMode): boolean {
  if (flow.status !== 'passed') return false
  if (flow.verifiedBy === 'machine' || flow.verifiedBy === 'agent') return true
  return flow.verifiedBy === 'author' && mode !== 'strict'
}

export function criterionMet(criterion: QaCriterion, mode: QaMode): boolean {
  if (criterion.status !== 'met') return false
  if (criterion.verifiedBy === 'machine' || criterion.verifiedBy === 'agent') return true
  return criterion.verifiedBy === 'author' && mode !== 'strict'
}

export interface QaGateInput {
  verification?: VerificationBinding | null
  mode: QaMode
  harnessLevel?: HarnessLevel
  plan: QaPlan | null
  receipt: QaReceipt | null
  headSha: string | null
  nowMs: number
  /** prjct's own headless browser is installed on this machine (card wording only). */
  browserInstalled?: boolean
}

export interface QaGateVerdict {
  blocked: boolean
  message: string | null
}

export interface QaShipGateVerdict extends QaGateVerdict {
  checklist: string[]
}

export type QaNextKind =
  | 'write_plan'
  | 'run_probes'
  | 'dispatch_qa_agent'
  | 'fix_failures'
  | 'approve'
  | 'idle'

export interface QaNextCard {
  kind: QaNextKind
  directive: string
  steps: string[]
}

function probesFresh(input: QaGateInput): boolean {
  const plan = input.plan
  if (!plan || !plan.flows.some((f) => f.probe)) return true
  if (!input.receipt || input.receipt.taskId !== plan.taskId) return false
  return isReceiptFresh(input.receipt, input.nowMs, input.headSha, input.verification)
}

/** Why the plan is not done yet, in the words the unblock message uses. */
function gaps(input: QaGateInput): string[] {
  const plan = input.plan
  if (!plan) return ['no QA plan (`prjct qa plan --json …`)']
  const out: string[] = []
  const unmetCriteria = plan.criteria.filter((c) => !criterionMet(c, input.mode))
  if (unmetCriteria.length > 0) {
    out.push(`${unmetCriteria.length}/${plan.criteria.length} criteria not met`)
  }
  const unverified = plan.flows.filter((f) => !flowVerified(f, input.mode))
  if (unverified.length > 0) {
    const authorOnly = unverified.filter((f) => f.status === 'passed' && f.verifiedBy === 'author')
    out.push(
      `${unverified.length}/${plan.flows.length} flows not verified` +
        (authorOnly.length > 0
          ? ` (${authorOnly.length} author-only — strict needs a probe or the QA subagent)`
          : '')
    )
  }
  if (!probesFresh(input)) out.push('probe receipt missing or stale for this HEAD (`prjct qa run`)')
  if (plan.criteria.length === 0 && plan.flows.length === 0) out.push('plan is empty')
  return out
}

export function qaNextAction(input: QaGateInput): QaNextCard {
  if (!qaAppliesTo(input.harnessLevel, input.mode)) {
    return { kind: 'idle', directive: 'QA phase not active for this cycle.', steps: [] }
  }
  const plan = input.plan
  if (!plan || (plan.criteria.length === 0 && plan.flows.length === 0)) {
    return {
      kind: 'write_plan',
      directive:
        'Before implementing, write the acceptance criteria (each names how it is checked) and the flows to verify — one per user-visible path plus 2-3 edge cases; attach an http/cli/file probe wherever prjct can run it.',
      steps: [`prjct qa plan --json '${QA_PLAN_JSON_HINT}'`],
    }
  }
  const failed = plan.flows.filter((f) => f.status === 'failed')
  const unmet = plan.criteria.filter((c) => c.status === 'unmet')
  if (failed.length > 0 || unmet.length > 0) {
    return {
      kind: 'fix_failures',
      directive: `${failed.length} flow(s) failed / ${unmet.length} criteria unmet — fix atomically (one \`fix:\` commit per bug, regression test alongside, max 3 attempts per bug), then re-verify.`,
      steps: [
        ...failed.map(
          (f) => `fix \`${f.id}\` ${f.name}${f.evidence ? ` — ${f.evidence.slice(0, 120)}` : ''}`
        ),
        'prjct qa run  (probes)  ·  re-dispatch the QA subagent for agent-verified flows',
      ],
    }
  }
  const probeFlowsPending = plan.flows.some((f) => f.probe && f.status === 'pending')
  if (probeFlowsPending || !probesFresh(input)) {
    const needsBrowser =
      input.browserInstalled === false && plan.flows.some((f) => f.probe?.type === 'browser')
    return {
      kind: 'run_probes',
      directive:
        'Run the machine probes against the app (prjct starts it from `qa.app.start` when configured).',
      steps: [
        ...(needsBrowser
          ? [
              'prjct qa browser install   (one-time, a few hundred MB under the prjct cache — browser probes need it)',
            ]
          : []),
        'prjct qa run',
      ],
    }
  }
  const needsAgent =
    plan.flows.some((f) => !flowVerified(f, input.mode)) ||
    plan.criteria.some((c) => !criterionMet(c, input.mode))
  if (needsAgent) {
    return {
      kind: 'dispatch_qa_agent',
      directive:
        'Dispatch a FRESH QA subagent (blind: it gets the brief only, never your transcript or diff). It drives the pending flows with its browser tool and reports back.',
      steps: [
        'prjct qa brief --md   → paste as the ONLY input of a general-purpose subagent',
        input.browserInstalled === false
          ? 'no browser MCP on this rig? one-time `prjct qa browser install`, then the subagent drives `prjct qa browser goto|fill|click|text|screenshot`'
          : 'the subagent drives flows with its browser MCP or `prjct qa browser goto|fill|click|text|screenshot`',
        'subagent verifies each pending flow, then: prjct qa report --json \'[{"id":"fl-…","verdict":"passed|failed|blocked","evidence":"…"}]\'',
        'prjct qa next',
      ],
    }
  }
  return {
    kind: 'approve',
    directive: 'QA complete — every criterion met and every flow verified for this HEAD.',
    steps: ['prjct status done', 'prjct ship (only after the user confirms in text)'],
  }
}

/** One bounded line for the per-turn prompt hook. */
export function formatQaInject(card: QaNextCard): string | null {
  if (card.kind === 'idle' || card.kind === 'approve') return null
  const step = card.steps[0] ? ` → ${card.steps[0]}` : ''
  const line = `↳ QA ${card.kind}: ${card.directive}${step}`
  return line.length > 320 ? `${line.slice(0, 317)}…` : line
}

export interface QaWorkCueInput {
  mode: QaMode
  harnessLevel?: HarnessLevel
  plan: QaPlan | null
  seeded: boolean
}

/** Work-start section + one-line directive (null when the phase is off). */
export function qaWorkCue(input: QaWorkCueInput): {
  section: string | null
  directive: string | null
} {
  if (!qaAppliesTo(input.harnessLevel, input.mode)) return { section: null, directive: null }
  const plan = input.plan
  if (!plan || (plan.criteria.length === 0 && plan.flows.length === 0)) {
    const directive =
      'Write the QA plan BEFORE implementing: acceptance criteria (each names its check) + flows (one per user-visible path, 2-3 edge cases, http/cli/file/browser probe when prjct can run it). Verified before done/ship.'
    // Compact on purpose: this rides the 2000-char work surface. The full
    // JSON shape lives in `prjct qa next` / `prjct qa plan`.
    return {
      section: `${directive}\nWrite it: \`prjct qa plan --json '{"criteria":[…],"flows":[…]}'\` · shape + card: \`prjct qa next\``,
      directive,
    }
  }
  const s = qaPlanSummary(plan)
  const directive = input.seeded
    ? `QA plan seeded from spec ${plan.specId?.slice(0, 8) ?? ''}: ${s.criteria.total} criteria · ${s.flows.total} flows. Review it, add edge-case flows and probes (\`prjct qa plan --json\`), then \`prjct qa next\`.`
    : `QA plan: ${s.criteria.total} criteria · ${s.flows.total} flows (${s.flows.withProbe} with probes). Follow \`prjct qa next\`.`
  return { section: directive, directive }
}

export function qaDoneVerdict(input: QaGateInput): QaGateVerdict {
  if (!qaAppliesTo(input.harnessLevel, input.mode)) return { blocked: false, message: null }
  const missing = gaps(input)
  if (missing.length === 0) return { blocked: false, message: '✓ QA plan verified for this HEAD.' }
  const detail = missing.join('; ')
  if (input.mode === 'strict') {
    return {
      blocked: true,
      message: `QA gate (strict): ${detail}. Run \`prjct qa next\` for the exact step, or override at ship with --no-qa-gate.`,
    }
  }
  return { blocked: false, message: `⚠ QA: ${detail} — run \`prjct qa next\`.` }
}

export function qaShipVerdict(input: QaGateInput & { override: boolean }): QaShipGateVerdict {
  const checklist = input.plan ? checklistLines(input.plan) : []
  if (input.override) {
    return { blocked: false, message: 'QA gate overridden (--no-qa-gate) — recorded.', checklist }
  }
  if (!qaAppliesTo(input.harnessLevel, input.mode)) {
    return { blocked: false, message: null, checklist }
  }
  const receipt = input.receipt
  if (
    receipt &&
    !receipt.vacuous &&
    !receipt.passed &&
    isReceiptFresh(receipt, input.nowMs, input.headSha, input.verification) &&
    (!input.plan || receipt.taskId === input.plan.taskId)
  ) {
    const red = receipt.probes.filter((p) => !p.ok && !p.unavailable).map((p) => p.flowId ?? p.type)
    const redChecks = receipt.checks.filter((c) => !c.ok && !c.unavailable).map((c) => c.kind)
    return {
      blocked: true,
      message: `QA probes are RED for this HEAD (${[...redChecks, ...red].join(', ')}). Fix and re-run \`prjct qa run\`, or override explicitly with --no-qa-gate.`,
      checklist,
    }
  }
  const missing = gaps(input)
  if (missing.length === 0) {
    return {
      blocked: false,
      message: '✓ QA verified — criteria met, flows verified for HEAD.',
      checklist,
    }
  }
  const detail = missing.join('; ')
  if (input.mode === 'strict') {
    return {
      blocked: true,
      message: `QA gate (strict): ${detail}. Run \`prjct qa next\`, or override explicitly with --no-qa-gate.`,
      checklist,
    }
  }
  return {
    blocked: false,
    message: `⚠ QA: ${detail} — this ship is not QA-verified. Run \`prjct qa next\` before shipping.`,
    checklist,
  }
}

function checklistLines(plan: QaPlan): string[] {
  const lines: string[] = []
  for (const c of plan.criteria) {
    lines.push(
      `- [${c.status === 'met' ? 'x' : ' '}] ${c.text}${c.verifiedBy ? ` (${c.verifiedBy})` : ''}`
    )
  }
  for (const f of plan.flows) {
    const state = f.status === 'passed' ? 'x' : ' '
    const by = f.verifiedBy ? ` (${f.verifiedBy})` : ''
    lines.push(
      `- [${state}] flow: ${f.name}${f.status !== 'passed' && f.status !== 'pending' ? ` — ${f.status}` : ''}${by}`
    )
  }
  return lines
}
