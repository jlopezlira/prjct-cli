/**
 * Demo A/B weak vs frontier — pure scoring + markdown shape.
 * Dynasty harness Δ is release-gated (wide intent gap vs bare).
 */

import { describe, expect, test } from 'bun:test'
import {
  buildDemoRows,
  computeHarnessDelta,
  DELTA_MIN_INTENT_PP,
  formatDemoMarkdown,
  renderHarnessDeltaMd,
  routeIntent,
  routeIntentBare,
} from '../../services/weak-frontier-demo'

describe('weak-frontier-demo', () => {
  test('harness intent router beats bare wrap-as-work on bin verbs', () => {
    expect(routeIntent('sync the project')).toBe('sync')
    expect(routeIntentBare('sync the project')).toBe('work')
    expect(routeIntent('search for auth')).toBe('search')
    expect(routeIntentBare('search for auth')).toBe('work')
  })

  test('buildDemoRows marks every weak+prjct SLO', () => {
    const rows = buildDemoRows()
    expect(rows.length).toBeGreaterThanOrEqual(6)
    const failed = rows.filter((r) => !r.weakOk)
    expect(failed).toEqual([])
  })

  test('markdown table is public-demo shaped', () => {
    const md = formatDemoMarkdown(buildDemoRows())
    expect(md).toContain('synthetic routing fixtures')
    expect(md).toContain('No live model comparison')
    expect(md).not.toContain('Structural proof')
    expect(md).not.toContain('Frontier (no harness)')
    expect(md).toContain('demo:weak-vs-frontier')
  })

  test('computeHarnessDelta is all-green with wide intent gap', () => {
    const d = computeHarnessDelta()
    expect(d.allGreen).toBe(true)
    expect(d.harnessHits).toBeGreaterThan(d.bareHits)
    expect(d.intentDeltaPp).toBeGreaterThanOrEqual(DELTA_MIN_INTENT_PP)
    expect(d.harnessRate).toBeGreaterThanOrEqual(0.95)
    expect(d.line).toMatch(/Harness Δ/)
    expect(d.line).toMatch(/PASS/)
  })

  test('renderHarnessDeltaMd is scorecard-shaped', () => {
    const md = renderHarnessDeltaMd()
    expect(md).toContain('Harness Δ')
    expect(md).toContain('bare vs prjct')
    expect(md).toContain('Intent routing accuracy')
    expect(md).toContain('gate:dominance')
  })
})
