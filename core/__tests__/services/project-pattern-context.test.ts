import { describe, expect, it } from 'bun:test'
import {
  formatRelevantProjectPatterns,
  projectPatternAlignmentEntries,
  selectRelevantProjectPatterns,
} from '../../services/project-pattern-context'
import { buildProjectStyleSnapshot } from '../../services/project-style-profile'
import type { LLMAnalysis } from '../../types/llm-analysis'

const analysis: LLMAnalysis = {
  version: 1,
  commitHash: 'abc',
  analyzedAt: '2026-08-27T00:00:00.000Z',
  architecture: {
    style: 'modular-monolith',
    insights: ['Commands delegate to services.'],
    domains: ['commands', 'storage'],
  },
  patterns: [
    {
      name: 'Transactional storage boundary',
      description: 'Storage services own database transactions; commands only orchestrate.',
      locations: ['core/storage', 'core/services/sync/persistence.ts'],
      confidence: 0.96,
      category: 'persistence',
    },
    {
      name: 'Component composition',
      description: 'Compose UI from small view components.',
      locations: ['src/components'],
      confidence: 0.9,
      category: 'frontend',
    },
  ],
  antiPatterns: [
    {
      issue: 'SQL inside command handlers',
      reasoning: 'It bypasses the storage boundary.',
      files: ['core/commands'],
      suggestion: 'Move the transaction into the matching storage service.',
      severity: 'high',
      confidence: 0.98,
    },
  ],
  techDebt: [],
  riskAreas: [],
  refactorSuggestions: [],
  projectInsights: [],
  conventions: [
    {
      category: 'errors',
      rule: 'Return CommandResult at command boundaries.',
      example: 'return { success: false, error: message }',
    },
  ],
}

const snapshot = buildProjectStyleSnapshot({
  stats: {
    fileCount: 100,
    version: '1.0.0',
    name: 'demo',
    ecosystem: 'JavaScript',
    projectType: 'complex',
    languages: ['TypeScript'],
    frameworks: [],
  },
  stack: {
    hasFrontend: false,
    hasBackend: true,
    hasDatabase: true,
    hasDocker: false,
    hasTesting: true,
    frontendType: null,
    frameworks: [],
  },
  llmAnalysis: analysis,
})

describe('task-relevant project pattern context', () => {
  it('selects by task terms and canonical path without leaking unrelated style', () => {
    const selected = selectRelevantProjectPatterns(snapshot, 'fix database transaction handling', {
      targetFiles: ['core/commands/sync.ts'],
    })

    expect(selected?.patterns.map((pattern) => pattern.name)).toContain(
      'Transactional storage boundary'
    )
    expect(selected?.patterns.map((pattern) => pattern.name)).not.toContain('Component composition')
    expect(selected?.antiPatterns[0]?.issue).toBe('SQL inside command handlers')
  })

  it('renders the actual rule, example, and canonical evidence under a hard budget', () => {
    const selected = selectRelevantProjectPatterns(snapshot, 'storage command errors', {
      targetFiles: ['core/commands/sync.ts'],
    })
    const rendered = formatRelevantProjectPatterns(selected, { maxChars: 600 })

    expect(rendered).toContain('Storage services own database transactions')
    expect(rendered).toContain('core/storage')
    expect(rendered).toContain('Return CommandResult')
    expect(rendered).toContain('return { success: false')
    expect(rendered!.length).toBeLessThanOrEqual(600)
  })

  it('adapts selected evidence to the work alignment surface without dropping content', () => {
    const selected = selectRelevantProjectPatterns(snapshot, 'transaction storage', {
      targetFiles: ['core/storage/database.ts'],
    })
    const entries = projectPatternAlignmentEntries(selected)

    expect(entries.patterns[0]?.content).toContain('commands only orchestrate')
    expect(entries.patterns[0]?.content).toContain('canonical')
  })

  it('skips one oversized evidence line without hiding shorter applicable rules', () => {
    const selected = selectRelevantProjectPatterns(snapshot, 'storage command errors', {
      targetFiles: ['core/commands/sync.ts'],
    })
    selected!.patterns[0] = {
      ...selected!.patterns[0],
      locations: [`core/${'very-long-segment/'.repeat(30)}storage.ts`],
    }

    const rendered = formatRelevantProjectPatterns(selected, { maxChars: 260 })

    expect(rendered).toContain('SQL inside command handlers')
    expect(rendered!.length).toBeLessThanOrEqual(260)
  })
})
