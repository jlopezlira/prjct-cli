/**
 * Consent gate for contradictory review — the first step of `prjct ship`.
 *
 * The load-bearing property: the question keeps coming back until the judges
 * agree ON THE TREE BEING SHIPPED. Everything else is ordering.
 */

import { describe, expect, test } from 'bun:test'
import {
  type ContradictoryGateInput,
  choiceFromIntent,
  contradictoryReviewGate,
} from '../../services/contradictory-review'

function gate(over: Partial<ContradictoryGateInput> = {}) {
  return contradictoryReviewGate({
    choice: null,
    ledgerVerdict: null,
    stampValid: false,
    hasChangeset: true,
    registerOnly: false,
    ...over,
  })
}

describe('choiceFromIntent', () => {
  test('maps the review intents and nothing else', () => {
    expect(choiceFromIntent('review-full')).toBe('full')
    expect(choiceFromIntent('review-standard')).toBe('standard')
    expect(choiceFromIntent('review-skip')).toBe('skip')
    expect(choiceFromIntent('proceed')).toBeNull()
    expect(choiceFromIntent(undefined)).toBeNull()
    expect(choiceFromIntent(null)).toBeNull()
  })
})

describe('contradictoryReviewGate — asks first', () => {
  test('no ledger → asks, offering all four answers', () => {
    const v = gate()
    expect(v.kind).toBe('ask')
    if (v.kind !== 'ask') throw new Error('expected ask')
    expect(v.reason).toBe('no-ledger')
    expect(v.clarification.options).toEqual([
      'review-full',
      'review-standard',
      'review-skip',
      'abort',
    ])
    expect(v.clarification.question).toMatch(/RED \(attack\) \+ BLUE \(defense\)/)
  })

  test('an unfinished ledger names its verdict instead of asking cold', () => {
    const v = gate({ ledgerVerdict: 'blocked', ledgerId: 'abcdef1234567890' })
    expect(v.kind).toBe('ask')
    if (v.kind !== 'ask') throw new Error('expected ask')
    expect(v.reason).toBe('unfinished-ledger')
    expect(v.clarification.question).toContain('abcdef12')
    expect(v.clarification.question).toMatch(/blocked/)
    expect(v.clarification.question).toMatch(/survived refutation/)
  })

  test('escalated says the judges contradict each other', () => {
    const v = gate({ ledgerVerdict: 'escalated' })
    if (v.kind !== 'ask') throw new Error('expected ask')
    expect(v.clarification.question).toMatch(/contradict each other/)
  })

  test('in_progress says the reviewers have not reported', () => {
    const v = gate({ ledgerVerdict: 'in_progress' })
    if (v.kind !== 'ask') throw new Error('expected ask')
    expect(v.clarification.question).toMatch(/not reported yet/)
  })
})

describe('contradictoryReviewGate — the only way past the question', () => {
  test('approved AND still bound to this tree proceeds, binding', () => {
    const v = gate({ ledgerVerdict: 'approved', stampValid: true, ledgerId: 'ledger-01' })
    expect(v.kind).toBe('proceed')
    if (v.kind !== 'proceed') throw new Error('expected proceed')
    expect(v.binding).toBe(true)
    expect(v.reason).toBe('approved')
    expect(v.message).toMatch(/judges agree/)
  })

  test('approved but the code moved after approval asks again', () => {
    const v = gate({ ledgerVerdict: 'approved', stampValid: false })
    expect(v.kind).toBe('ask')
    if (v.kind !== 'ask') throw new Error('expected ask')
    expect(v.reason).toBe('stamp-drift')
    expect(v.clarification.question).toMatch(/no longer matches the tree/)
  })
})

describe('contradictoryReviewGate — answers', () => {
  test('review-full opens the dual-blind review and does not ship', () => {
    const v = gate({ choice: 'full' })
    expect(v.kind).toBe('open-review')
    if (v.kind !== 'open-review') throw new Error('expected open-review')
    expect(v.intensity).toBe('full')
    expect(v.message).toMatch(/dual-blind RED \+ BLUE/)
  })

  test('review-standard opens the single-reviewer pass', () => {
    const v = gate({ choice: 'standard' })
    if (v.kind !== 'open-review') throw new Error('expected open-review')
    expect(v.intensity).toBe('standard')
  })

  test('a decline proceeds, unbound, and announces that ship asks again', () => {
    const v = gate({ choice: 'skip' })
    expect(v.kind).toBe('proceed')
    if (v.kind !== 'proceed') throw new Error('expected proceed')
    expect(v.binding).toBe(false)
    expect(v.reason).toBe('declined')
    expect(v.message).toMatch(/DECLINED/)
    expect(v.message).toMatch(/asks again/)
  })

  test('a decline is not an input — the gate cannot be told one happened before', () => {
    // Structural guarantee: no field carries a past decline, so the next ship
    // asks from scratch. Same state, no answer → ask.
    const v = gate({ choice: null })
    expect(v.kind).toBe('ask')
  })

  test('an explicit answer outranks an approved ledger', () => {
    const v = gate({ choice: 'full', ledgerVerdict: 'approved', stampValid: true })
    expect(v.kind).toBe('open-review')
  })
})

describe('contradictoryReviewGate — nothing to contradict', () => {
  test('register-only ships a row, not a diff', () => {
    const v = gate({ registerOnly: true, hasChangeset: true })
    expect(v.kind).toBe('proceed')
    if (v.kind !== 'proceed') throw new Error('expected proceed')
    expect(v.reason).toBe('register-only')
    expect(v.binding).toBe(false)
  })

  test('an empty changeset never asks', () => {
    const v = gate({ hasChangeset: false })
    expect(v.kind).toBe('proceed')
    if (v.kind !== 'proceed') throw new Error('expected proceed')
    expect(v.reason).toBe('empty-changeset')
  })

  test('register-only outranks an unfinished ledger', () => {
    const v = gate({ registerOnly: true, ledgerVerdict: 'blocked' })
    expect(v.kind).toBe('proceed')
  })
})
