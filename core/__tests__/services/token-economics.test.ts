import { describe, expect, test } from 'bun:test'
import { buildTokenEconomics } from '../../services/token-economics'

const PROJECT = '00000000-0000-0000-0000-000000000000'

describe('buildTokenEconomics', () => {
  test('reports measurement only when no cycle budget is configured', () => {
    const e = buildTokenEconomics(PROJECT)
    expect(e.line).toContain('Token economics')
    expect(e.score).toBeNull()
    expect(e.line).toContain('no cycle budget set')
  })

  // The score used to be raw spend: <50k scored 90, >500k scored 35. That
  // grades "did you do less work" — a day that shipped nothing outscored a day
  // that shipped three PRs, and 100 was reachable only by stopping work.
  test('does not score raw spend when there is no budget to adhere to', () => {
    const light = buildTokenEconomics(PROJECT, { cycleTokensIn: 1_000, cycleTokensOut: 0 })
    const heavy = buildTokenEconomics(PROJECT, { cycleTokensIn: 900_000, cycleTokensOut: 500_000 })
    expect(light.score).toBeNull()
    expect(heavy.score).toBeNull()
  })

  test('scores adherence against a configured budget', () => {
    const under = buildTokenEconomics(PROJECT, {
      cycleTokensIn: 100,
      cycleTokensOut: 100,
      maxTokensPerCycle: 1000,
    })
    const over = buildTokenEconomics(PROJECT, {
      cycleTokensIn: 900,
      cycleTokensOut: 900,
      maxTokensPerCycle: 1000,
    })
    expect(under.score).toBe(100)
    expect(over.score).toBeLessThan(under.score as number)
    expect(over.line).toContain('cycle=1800/1000')
    expect(under.line).toContain('budget adherence')
  })
})
