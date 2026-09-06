/**
 * A/B report: rows → OutcomeRun[] (schema-valid, arm-independent config hash so
 * pairs match), the live evaluation reaches `provisional` on a small multi-model
 * multi-class sample, and grader disagreements are counted, not hidden.
 */

import { describe, expect, it } from 'bun:test'
import { type AbRow, renderAbMd, rowDisagreement, toOutcomeRuns } from '../../eval/ab-report'
import { loadTasks } from '../../eval/ab-tasks'
import { evaluateLiveOutcome } from '../../services/outcome-evidence'

const tasks = loadTasks()

function row(over: Partial<AbRow>): AbRow {
  return {
    model: 'haiku',
    task: 'T2-decision',
    arm: 'with',
    rep: 1,
    head: 'abc123',
    wall_ms: 1000,
    input_tokens: 50,
    output_tokens: 20,
    sum_context: 200,
    tool_calls: 4,
    is_error: false,
    det: { parts: {}, correct: true },
    llm: { verdict: 'correct' },
    ...over,
  }
}

/** A small but real corpus: 2 models × 3 classes × both arms × 1 rep. */
function fixtureRows(): AbRow[] {
  const rows: AbRow[] = []
  for (const model of ['haiku', 'sonnet']) {
    for (const task of ['T1-lookup', 'T2-decision', 'T4-trap']) {
      // harness wins on the knowledge/trap tasks, ties on lookup.
      const harnessCorrect = task !== 'T1-lookup'
      rows.push(
        row({
          model,
          task,
          arm: 'with',
          det: { parts: {}, correct: harnessCorrect || task === 'T1-lookup' },
          llm: { verdict: harnessCorrect || task === 'T1-lookup' ? 'correct' : 'wrong' },
        })
      )
      rows.push(
        row({
          model,
          task,
          arm: 'without',
          det: { parts: {}, correct: task === 'T1-lookup' },
          llm: { verdict: task === 'T1-lookup' ? 'correct' : 'wrong' },
        })
      )
    }
  }
  return rows
}

describe('toOutcomeRuns', () => {
  it('produces schema-valid runs with arm-independent config hashes', () => {
    const runs = toOutcomeRuns(fixtureRows(), tasks)
    expect(runs.length).toBe(12)
    const t2 = runs.filter((r) => r.taskId === 'T2-decision' && r.model === 'haiku')
    // baseline + harness twin share configurationHash + taskHash + category.
    expect(new Set(t2.map((r) => r.configurationHash)).size).toBe(1)
    expect(new Set(t2.map((r) => r.category)).size).toBe(1)
    expect(new Set(t2.map((r) => r.arm))).toEqual(new Set(['baseline', 'harness']))
    expect(runs.every((r) => r.category === r.taskClass)).toBe(true)
  })
})

describe('evaluateLiveOutcome', () => {
  it('reaches provisional and slices Δ by class and model', () => {
    const runs = toOutcomeRuns(fixtureRows(), tasks)
    const live = evaluateLiveOutcome(runs)
    expect(live.status).toBe('provisional')
    expect(live.pairs).toBe(6)
    expect(live.models).toEqual(['haiku', 'sonnet'])
    expect(live.classes.length).toBeGreaterThanOrEqual(3)
    const knowledge = live.byClass.find((s) => s.key === 'PROJECT_KNOWLEDGE')!
    expect(knowledge.harnessAccuracy).toBe(1)
    expect(knowledge.baselineAccuracy).toBe(0)
    expect(knowledge.deltaAccuracy).toBe(1)
  })

  it('stays insufficient below the provisional bar', () => {
    const oneModel = fixtureRows().filter((r) => r.model === 'haiku')
    const live = evaluateLiveOutcome(toOutcomeRuns(oneModel, tasks))
    expect(live.status).toBe('insufficient')
  })

  it('is missing on empty input', () => {
    expect(evaluateLiveOutcome(undefined).status).toBe('missing')
    expect(evaluateLiveOutcome([]).status).toBe('missing')
  })
})

describe('disagreements', () => {
  it('counts det-vs-llm disagreements in the report', () => {
    const rows = [
      row({ det: { parts: {}, correct: true }, llm: { verdict: 'wrong' } }),
      row({ det: { parts: {}, correct: false }, llm: { verdict: 'correct' } }),
      row({ det: { parts: {}, correct: true }, llm: { verdict: 'correct' } }),
    ]
    expect(rows.map(rowDisagreement)).toEqual([true, true, false])
    const md = renderAbMd(rows, tasks)
    expect(md).toContain('Grader disagreements (det vs llm):** 2/3')
  })
})
