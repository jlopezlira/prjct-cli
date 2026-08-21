import { describe, expect, it } from 'bun:test'
import { DEFAULT_MCP_TOOL_TIER } from '../../mcp/server'
import { SUPPORTED_PROVIDERS } from '../../schemas/model'
import {
  computeHarnessScore,
  renderHarnessScoreMd,
  WORLD_CLASS,
} from '../../services/harness-score'
import { MINIMAL_ROUTING_BODY } from '../../services/routing-block'
import { buildPrjctSkill } from '../../services/skill-generator/prjct-skill-body'
import { countTokens } from '../../tools/context/token-counter'

describe('harness score', () => {
  it('defaults MCP tier to core', () => {
    expect(DEFAULT_MCP_TOOL_TIER).toBe('core')
  })

  it('keeps always-on skill under the token SLO', () => {
    expect(countTokens(buildPrjctSkill())).toBeLessThanOrEqual(WORLD_CLASS.skillTokensMax)
  })

  it('keeps routing body under the byte SLO', () => {
    expect(Buffer.byteLength(MINIMAL_ROUTING_BODY, 'utf-8')).toBeLessThanOrEqual(
      WORLD_CLASS.routingBodyBytesMax
    )
  })

  it('supports at least 6 provider rigs', () => {
    expect(SUPPORTED_PROVIDERS.length).toBeGreaterThanOrEqual(WORLD_CLASS.providerMapsMin)
  })

  it('scores green on structural criteria', () => {
    const report = computeHarnessScore()
    expect(report.grade).toBeGreaterThanOrEqual(4)
    expect(report.criteria.every((c) => c.score >= 3)).toBe(true)
    expect(report.criteria.find((c) => c.id === 'skill-tokens')?.status).toBe('green')
    expect(report.criteria.find((c) => c.id === 'mcp-default')?.status).toBe('green')
    expect(report.criteria.find((c) => c.id === 'context-tiers')?.status).toBe('green')
    expect(report.programDone).toBe(true)
  })

  it('renders markdown scorecard', () => {
    const md = renderHarnessScoreMd(computeHarnessScore())
    expect(md).toContain('# Harness score')
    expect(md).toContain('Always-on skill tokens')
    expect(md).toMatch(/done|in progress/)
  })

  it('renders competitive dust table vs gentle-ai and open-GSD', () => {
    const md = renderHarnessScoreMd(computeHarnessScore())
    expect(md).toContain('Competitive dust')
    expect(md).toContain('gentle-ai')
    expect(md).toContain('open-GSD')
    expect(md).toContain('discuss-lock')
    expect(md).toContain('SQLite')
    expect(md).toContain('Multi-runtime wire')
    expect(md).toContain('Organic feel')
    expect(md).toContain('Public harness Δ')
    expect(md).toContain('Content-bound approve')
    expect(md).toContain('SoT hard-bind')
    expect(md).toContain('Trap-before-edit')
    expect(md).toContain('Impact-ranked next')
    expect(md).toContain('Geometry-at-intent')
    expect(md).toContain('Always-on skill diet')
    expect(md).toContain('Land Rho loop')
    expect(md).toContain('One-breath install')
    expect(md).toContain('Context cache tiers')
  })

  it('embeds Dynasty delta + outcomes sections when provided', () => {
    const md = renderHarnessScoreMd(computeHarnessScore(), {
      deltaMd: '## Harness Δ (bare vs prjct)\n\n| Metric | Bare | With prjct | Pass |\n',
      outcomesMd: '## Dynasty outcomes (project)\n\n| Signal | Measured | Note |\n',
    })
    expect(md).toContain('Harness Δ (bare vs prjct)')
    expect(md).toContain('Dynasty outcomes (project)')
    // Δ appears before competitive dust
    expect(md.indexOf('Harness Δ')).toBeLessThan(md.indexOf('Competitive dust'))
  })

  it('can include multi-runtime organic criterion when probed', () => {
    const report = computeHarnessScore({
      multiRuntimeOrganicGrade: 5,
      multiRuntimeOrganicMeasured: '4/4 live (100%)',
    })
    const c = report.criteria.find((x) => x.id === 'multi-runtime-organic')
    expect(c?.score).toBe(5)
    expect(c?.measured).toContain('4/4')
  })
})
