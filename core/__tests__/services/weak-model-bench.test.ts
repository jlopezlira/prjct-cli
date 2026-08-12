/**
 * Release-blocking weak-model A/B gate.
 *
 * CI quality job runs this file — red = no merge / no release.
 * North star: weak + prjct beats bare frontier on discipline SLOs.
 */

import { describe, expect, it } from 'bun:test'
import { buildDemoRows, routeIntent, routeIntentBare } from '../../services/weak-frontier-demo'
import {
  formatWeakBenchMarkdown,
  INTENT_FIXTURES,
  runWeakModelBench,
  WEAK_BENCH_MIN_PASS,
} from '../../services/weak-model-bench'

describe('weak-model A/B release gate', () => {
  it('passes every structural SLO (allGreen)', () => {
    const report = runWeakModelBench()
    expect(report.total).toBeGreaterThanOrEqual(WEAK_BENCH_MIN_PASS)
    expect(report.allGreen).toBe(true)
    expect(report.passed).toBe(report.total)
    const failed = report.checks.filter((c) => !c.ok)
    expect(failed).toEqual([])
  })

  it('harness intent router beats bare wrap-as-work', () => {
    const fixture: {
      harness: number
      bare: number
    } = {
      harness: 0,
      bare: 0,
    }

    for (const f of INTENT_FIXTURES) {
      if (routeIntent(f.signal) === f.verb) fixture.harness++
      if (routeIntentBare(f.signal) === f.verb) fixture.bare++
    }
    expect(fixture.harness).toBeGreaterThan(fixture.bare)
    expect(fixture.harness / INTENT_FIXTURES.length).toBeGreaterThanOrEqual(0.95)
  })

  it('public demo rows stay fully green', () => {
    const rows = buildDemoRows()
    expect(rows.every((r) => r.weakOk)).toBe(true)
  })

  it('markdown gate report is CI-legible', () => {
    const md = formatWeakBenchMarkdown(runWeakModelBench())
    expect(md).toContain('Weak-model A/B')
    expect(md).toContain('PASS')
    expect(md).toContain('intent A/B beats bare')
    expect(md).toContain('codex hooks+MCP native')
    expect(md).toContain('gemini hooks+MCP native')
    expect(md).toContain('cursor hooks native')
    expect(md).toContain('grok mcp+skills native')
    expect(md).toContain('grok hooks inherits-claude')
    expect(md).toContain('instruction replay adherence delta')
    expect(md).toContain('instruction replay runtime regressions')
    expect(md).toContain('instruction replay false triggers')
    expect(md).toContain('instruction replay attribution')
    expect(md).toContain('deterministic structural evidence, not live-model evidence')
  })
})
