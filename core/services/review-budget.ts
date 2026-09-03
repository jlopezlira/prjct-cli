import type { ReviewIntensity } from '../schemas/judgment'

export const MAX_REVIEW_AGENTS_PER_STAGE = 2 as const

export interface ReviewExecutionBudget {
  initialReviewers: 0 | 1 | 2
  challengeReviewers: 0 | 1
  rejudgeReviewers: 0 | 1
  maxFindings: number
  maxOutputTokensPerAgent: number
  maxTotalAgentPasses: number
  maxFixRejudgeRounds: number
  contextRule: string
}

export type ReviewPassStage = 'initial' | 'challenge' | 'rejudge'

export interface ReviewPassUsage {
  initial: number
  challenge: number
  rejudge: number
}

interface ReviewPassState {
  intensity: ReviewIntensity
  reviewPasses?: ReviewPassUsage
  findings?: ReadonlyArray<{ status: string; refuteVotes?: readonly unknown[] }>
  merge?: unknown
}

const SKIP_BUDGET: ReviewExecutionBudget = {
  initialReviewers: 0,
  challengeReviewers: 0,
  rejudgeReviewers: 0,
  maxFindings: 0,
  maxOutputTokensPerAgent: 0,
  maxTotalAgentPasses: 0,
  maxFixRejudgeRounds: 0,
  contextRule: 'no review context',
}

const STANDARD_BUDGET: ReviewExecutionBudget = {
  initialReviewers: 1,
  challengeReviewers: 1,
  rejudgeReviewers: 1,
  maxFindings: 6,
  maxOutputTokensPerAgent: 1_200,
  maxTotalAgentPasses: 3,
  maxFixRejudgeRounds: 1,
  contextRule: 'changed hunks + direct dependencies only; never scan the whole repository',
}

const FULL_BUDGET: ReviewExecutionBudget = {
  initialReviewers: 2,
  challengeReviewers: 1,
  rejudgeReviewers: 1,
  maxFindings: 8,
  maxOutputTokensPerAgent: 1_600,
  maxTotalAgentPasses: 4,
  maxFixRejudgeRounds: 1,
  contextRule:
    'changed hunks + direct dependencies only; RED and BLUE use complementary charters, never a repository-wide scan',
}

export function reviewBudgetFor(intensity: ReviewIntensity): ReviewExecutionBudget {
  if (intensity === 'skip') return SKIP_BUDGET
  if (intensity === 'standard') return STANDARD_BUDGET
  return FULL_BUDGET
}

export function initialFindingBudgetFor(intensity: ReviewIntensity): number {
  const budget = reviewBudgetFor(intensity)
  return budget.initialReviewers * budget.maxFindings
}

/** Infer old ledgers once, then persist exact counters on their next mutation. */
export function reviewPassUsage(state: ReviewPassState): ReviewPassUsage {
  if (state.reviewPasses) return { ...state.reviewPasses }
  const budget = reviewBudgetFor(state.intensity)
  const findings = state.findings ?? []
  const challenged = findings.some(
    (finding) =>
      (finding.refuteVotes?.length ?? 0) > 0 ||
      ['stands', 'fixed', 'verified', 'open'].includes(finding.status)
  )
  return {
    initial:
      findings.length > 0 || state.merge
        ? state.merge
          ? budget.initialReviewers
          : Math.min(1, budget.initialReviewers)
        : 0,
    challenge: challenged ? Math.min(1, budget.challengeReviewers) : 0,
    rejudge: findings.some((finding) => finding.status === 'verified')
      ? Math.min(1, budget.rejudgeReviewers)
      : 0,
  }
}

export function canConsumeReviewPass(
  state: ReviewPassState,
  stage: ReviewPassStage
): { ok: true } | { ok: false; reason: string } {
  const budget = reviewBudgetFor(state.intensity)
  const usage = reviewPassUsage(state)
  const stageCap =
    stage === 'initial'
      ? budget.initialReviewers
      : stage === 'challenge'
        ? budget.challengeReviewers
        : budget.rejudgeReviewers
  const total = usage.initial + usage.challenge + usage.rejudge
  if (usage[stage] >= stageCap) {
    return {
      ok: false,
      reason: `${stage} review pass budget exhausted (${usage[stage]}/${stageCap})`,
    }
  }
  if (total >= budget.maxTotalAgentPasses) {
    return {
      ok: false,
      reason: `total review pass budget exhausted (${total}/${budget.maxTotalAgentPasses})`,
    }
  }
  return { ok: true }
}

export function consumeReviewPass(state: ReviewPassState, stage: ReviewPassStage): ReviewPassUsage {
  const usage = reviewPassUsage(state)
  return { ...usage, [stage]: usage[stage] + 1 }
}

export function recordInitialReviewPasses(state: ReviewPassState, count: number): ReviewPassUsage {
  const usage = reviewPassUsage(state)
  const cap = reviewBudgetFor(state.intensity).initialReviewers
  return { ...usage, initial: Math.max(usage.initial, Math.min(cap, Math.max(0, count))) }
}

/** Keep every lens, but amortize the shared spec/code read across at most two agents. */
export function groupReviewLenses(
  lenses: readonly string[],
  agentCap: number = MAX_REVIEW_AGENTS_PER_STAGE
): string[][] {
  const cap = Math.max(1, Math.min(MAX_REVIEW_AGENTS_PER_STAGE, Math.floor(agentCap)))
  const groupCount = Math.min(cap, lenses.length)
  if (groupCount === 0) return []
  const groups = Array.from({ length: groupCount }, () => [] as string[])
  lenses.forEach((lens, index) => {
    groups[index % groupCount]!.push(lens)
  })
  return groups
}

export function formatReviewBudget(budget: ReviewExecutionBudget): string {
  return `Hard cap: ${budget.maxTotalAgentPasses} total agent pass(es) — ${budget.initialReviewers} initial reviewer(s), ${budget.challengeReviewers} batched challenger, ${budget.rejudgeReviewers} scoped re-judge; max ${budget.maxFindings} findings and ~${budget.maxOutputTokensPerAgent} output tokens per agent. Context: ${budget.contextRule}. One bounded pass per stage; stop when the required verdict is recorded.`
}
