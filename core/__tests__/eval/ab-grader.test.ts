/**
 * A/B graders: the deterministic grader matches the corpus golds and rejects
 * wrong answers; the LLM grader parses both structured_output and result-text
 * shapes; and disagreement is flagged only when both verdicts are definite and
 * opposite.
 */

import { describe, expect, it } from 'bun:test'
import { detGrade, gradersDisagree, type LlmResult, parseGraderOutput } from '../../eval/ab-grader'
import { loadTasks } from '../../eval/ab-tasks'

const tasks = loadTasks()
const byId = new Map(tasks.map((t) => [t.id, t]))

describe('detGrade', () => {
  it('marks each corpus gold as correct', () => {
    for (const task of tasks) {
      const res = detGrade(task.det, task.gold)
      expect(res.correct).toBe(true)
    }
  })

  it('fails when a required part is missing', () => {
    const t1 = byId.get('T1-lookup')!
    // Drop the 700 fact → q1 part fails.
    const res = detGrade(
      t1.det,
      'Q1: some chars. Q2: evaluateWorkflowRuleExecutable trust-boundary. Q3: 0.45 0.2 0.15'
    )
    expect(res.parts.q1).toBe(false)
    expect(res.correct).toBe(false)
  })

  it('honours OR-of-clauses (locator via either phrasing)', () => {
    const t2 = byId.get('T2-decision')!
    const viaLocator = detGrade(
      t2.det,
      'PERSIST global .prjct-cli. NOT prjct.config.json which is only a locator. MODULE config-manager.'
    )
    expect(viaLocator.parts.locator).toBe(true)
    const viaFields = detGrade(
      t2.det,
      'PERSIST global .prjct-cli. NOT prjct.config.json holding projectId and dataPath. MODULE config-manager.'
    )
    expect(viaFields.parts.locator).toBe(true)
  })

  it('is case-insensitive on needles and applies regex flags', () => {
    const t1 = byId.get('T1-lookup')!
    const res = detGrade(
      t1.det,
      'Q1: 700 chars. Q2: EVALUATEWORKFLOWRULEEXECUTABLE in TRUST-BOUNDARY. Q3: 0.45, 0.2, 0.15'
    )
    expect(res.correct).toBe(true)
  })
})

describe('parseGraderOutput', () => {
  it('reads structured_output', () => {
    const out = parseGraderOutput(
      JSON.stringify({
        structured_output: { verdict: 'correct', reason: 'match' },
        total_cost_usd: 0.01,
      })
    )
    expect(out.verdict).toBe('correct')
    expect(out.cost).toBe(0.01)
  })

  it('falls back to a verdict embedded in result text', () => {
    const out = parseGraderOutput(JSON.stringify({ result: 'the "verdict": "partial" here' }))
    expect(out.verdict).toBe('partial')
  })

  it('reports unparsed / error shapes without throwing', () => {
    expect(parseGraderOutput(JSON.stringify({ result: 'no verdict' })).verdict).toBe('unparsed')
    expect(parseGraderOutput('not json').verdict).toBe('error')
    expect(parseGraderOutput('').verdict).toBe('error')
  })
})

describe('gradersDisagree', () => {
  const llm = (verdict: LlmResult['verdict']): LlmResult => ({ verdict, reason: '', cost: null })

  it('flags det-correct vs llm-wrong and the reverse', () => {
    expect(gradersDisagree({ parts: {}, correct: true }, llm('wrong'))).toBe(true)
    expect(gradersDisagree({ parts: {}, correct: false }, llm('correct'))).toBe(true)
  })

  it('agrees when both say correct or both say not-correct', () => {
    expect(gradersDisagree({ parts: {}, correct: true }, llm('correct'))).toBe(false)
    expect(gradersDisagree({ parts: {}, correct: false }, llm('partial'))).toBe(false)
    expect(gradersDisagree({ parts: {}, correct: false }, llm('wrong'))).toBe(false)
  })

  it('never counts an indefinite LLM verdict as disagreement', () => {
    expect(gradersDisagree({ parts: {}, correct: true }, llm('unparsed'))).toBe(false)
    expect(gradersDisagree({ parts: {}, correct: true }, llm('error'))).toBe(false)
  })
})
