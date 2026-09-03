import type { ReviewIntensity } from '../schemas/judgment'

export const MAX_REVIEW_AGENTS_PER_STAGE = 2 as const

export interface ReviewExecutionBudget {
  initialReviewers: 0 | 1 | 2
  challengeReviewers: 0 | 1
  rejudgeReviewers: 0 | 1
  maxFindings: number
  maxOutputTokensPerAgent: number
  contextRule: string
}

const SKIP_BUDGET: ReviewExecutionBudget = {
  initialReviewers: 0,
  challengeReviewers: 0,
  rejudgeReviewers: 0,
  maxFindings: 0,
  maxOutputTokensPerAgent: 0,
  contextRule: 'no review context',
}

const STANDARD_BUDGET: ReviewExecutionBudget = {
  initialReviewers: 1,
  challengeReviewers: 1,
  rejudgeReviewers: 1,
  maxFindings: 6,
  maxOutputTokensPerAgent: 1_200,
  contextRule: 'changed hunks + direct dependencies only; never scan the whole repository',
}

const FULL_BUDGET: ReviewExecutionBudget = {
  initialReviewers: 2,
  challengeReviewers: 1,
  rejudgeReviewers: 1,
  maxFindings: 8,
  maxOutputTokensPerAgent: 1_600,
  contextRule:
    'changed hunks + direct dependencies only; RED and BLUE use complementary charters, never a repository-wide scan',
}

export function reviewBudgetFor(intensity: ReviewIntensity): ReviewExecutionBudget {
  if (intensity === 'skip') return SKIP_BUDGET
  if (intensity === 'standard') return STANDARD_BUDGET
  return FULL_BUDGET
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
  return `Budget: ${budget.initialReviewers} initial reviewer(s), ${budget.challengeReviewers} batched challenger, ${budget.rejudgeReviewers} scoped re-judge; max ${budget.maxFindings} findings and ~${budget.maxOutputTokensPerAgent} output tokens per agent. Context: ${budget.contextRule}. One bounded pass per stage; stop when the required verdict is recorded.`
}
