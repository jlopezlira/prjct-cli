import { describe, expect, it } from 'bun:test'
import {
  groupReviewLenses,
  MAX_REVIEW_AGENTS_PER_STAGE,
  reviewBudgetFor,
} from '../../services/review-budget'

describe('review execution budgets', () => {
  it('caps full judgment at two initial judges and one batched challenger', () => {
    const budget = reviewBudgetFor('full')

    expect(budget.initialReviewers).toBe(2)
    expect(budget.challengeReviewers).toBe(1)
    expect(budget.rejudgeReviewers).toBe(1)
    expect(budget.maxFindings).toBeLessThanOrEqual(8)
    expect(budget.maxOutputTokensPerAgent).toBeLessThanOrEqual(1_600)
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
