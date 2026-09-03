import { describe, expect, it } from 'bun:test'
import {
  canConsumeReviewPass,
  groupReviewLenses,
  initialFindingBudgetFor,
  MAX_REVIEW_AGENTS_PER_STAGE,
  reviewBudgetFor,
} from '../../services/review-budget'

describe('review execution budgets', () => {
  it('enforces persisted stage counters and total pass caps', () => {
    const spent = {
      intensity: 'standard' as const,
      reviewPasses: { initial: 1, challenge: 1, rejudge: 1 },
    }

    expect(canConsumeReviewPass(spent, 'rejudge').ok).toBe(false)
    expect(canConsumeReviewPass(spent, 'challenge').ok).toBe(false)
  })

  it('caps initial findings across every allowed initial reviewer', () => {
    expect(initialFindingBudgetFor('standard')).toBe(6)
    expect(initialFindingBudgetFor('full')).toBe(16)
  })

  it('caps full judgment at two initial judges and one batched challenger', () => {
    const budget = reviewBudgetFor('full')

    expect(budget.initialReviewers).toBe(2)
    expect(budget.challengeReviewers).toBe(1)
    expect(budget.rejudgeReviewers).toBe(1)
    expect(budget.maxFindings).toBeLessThanOrEqual(8)
    expect(budget.maxOutputTokensPerAgent).toBeLessThanOrEqual(1_600)
    expect(budget.maxTotalAgentPasses).toBe(4)
    expect(budget.maxFixRejudgeRounds).toBe(1)
  })

  it('hard-caps standard review at three total agent passes', () => {
    const budget = reviewBudgetFor('standard')

    expect(budget.maxTotalAgentPasses).toBe(3)
    expect(budget.maxFixRejudgeRounds).toBe(1)
  })

  it('keeps every requested lens while using at most two reviewer agents', () => {
    const groups = groupReviewLenses([
      'architecture',
      'strategic',
      'design',
      'security',
      'data',
      'performance',
    ])

    expect(groups.length).toBe(MAX_REVIEW_AGENTS_PER_STAGE)
    expect(groups.flat().sort()).toEqual(
      ['architecture', 'data', 'design', 'performance', 'security', 'strategic'].sort()
    )
  })
})
