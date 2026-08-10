import { describe, expect, test } from 'bun:test'
import {
  buildProjectStyleSnapshot,
  isRichLlmAnalysis,
  isThinLlmAnalysis,
  stableStyleKey,
} from '../../services/project-style-profile'
import type { LLMAnalysis } from '../../types/llm-analysis'

const emptyStack = {
  hasFrontend: false,
  hasBackend: false,
  hasDatabase: false,
  hasDocker: false,
  hasTesting: true,
  frontendType: null as null,
  frameworks: [] as string[],
}

const baseStats = {
  fileCount: 100,
  version: '1.0.0',
  name: 'demo',
  ecosystem: 'JavaScript',
  projectType: 'complex',
  languages: ['TypeScript'],
  frameworks: [] as string[],
}

function richAnalysis(): LLMAnalysis {
  return {
    version: 1,
    commitHash: 'abc',
    analyzedAt: '2026-07-16T00:00:00.000Z',
    architecture: { style: 'modular-monolith', insights: ['cli routes'], domains: [] },
    patterns: [
      {
        name: 'Command registry',
        description: 'One entry in command-data.ts',
        locations: ['core/commands'],
        confidence: 0.9,
        category: 'architecture',
      },
    ],
    antiPatterns: [
      {
        issue: 'Barrel files',
        reasoning: 'breaks tree-shake',
        files: [],
        suggestion: 'import from source',
        severity: 'medium',
        confidence: 0.9,
      },
    ],
    techDebt: [],
    riskAreas: [],
    refactorSuggestions: [],
    projectInsights: [],
    conventions: [{ category: 'imports', rule: 'No barrel files' }],
    stack: { languages: ['TypeScript'], frameworks: ['Hono'] },
  }
}

describe('project-style-profile', () => {
  test('stableStyleKey normalizes', () => {
    expect(stableStyleKey('No Barrel Files!')).toBe('no-barrel-files')
  })

  test('isRichLlmAnalysis / isThinLlmAnalysis', () => {
    expect(isRichLlmAnalysis(richAnalysis())).toBe(true)
    expect(isThinLlmAnalysis(richAnalysis())).toBe(false)
    expect(
      isThinLlmAnalysis({
        ...richAnalysis(),
        architecture: { style: 'unknown', insights: ['note'], domains: [] },
        patterns: [],
        antiPatterns: [],
        conventions: [],
        stack: undefined,
      })
    ).toBe(true)
  })

  test('buildProjectStyleSnapshot merges mechanical stack + rich analysis', () => {
    const snap = buildProjectStyleSnapshot({
      stats: baseStats,
      stack: { ...emptyStack, frameworks: [], hasTesting: true },
      packageDeps: { zod: '^3', 'better-sqlite3': '11', hono: '4' },
      packageManager: 'bun',
      llmAnalysis: richAnalysis(),
      structural: { symbols: 10, files: 100, packages: ['core'] },
      commitHash: 'deadbeef',
    })

    expect(snap.payload.stack.ecosystem).toBe('JavaScript')
    expect(snap.payload.stack.languages).toContain('TypeScript')
    expect(snap.payload.stack.keyLibraries).toContain('Zod')
    expect(snap.payload.stack.packageManager).toBe('bun')
    expect(snap.patternCount).toBe(1)
    expect(snap.conventionCount).toBe(1)
    expect(snap.antiPatternCount).toBe(1)
    expect(snap.summary).toContain('patterns')
    expect(snap.payload.patterns[0]?.name).toBe('Command registry')
  })

  test('thin analysis alone does not invent patterns', () => {
    const thin: LLMAnalysis = {
      version: 1,
      commitHash: null,
      analyzedAt: '2026-07-16T00:00:00.000Z',
      architecture: { style: 'unknown', insights: ['WIP note'], domains: [] },
      patterns: [],
      antiPatterns: [],
      techDebt: [],
      riskAreas: [],
      refactorSuggestions: [],
      projectInsights: ['WIP note'],
      conventions: [],
    }
    const snap = buildProjectStyleSnapshot({
      stats: baseStats,
      stack: emptyStack,
      llmAnalysis: thin,
    })
    expect(snap.patternCount).toBe(0)
    expect(snap.conventionCount).toBe(0)
    expect(snap.payload.stack.ecosystem).toBe('JavaScript')
  })

  test('recognizes split MCP v2 packages without duplicate library labels', () => {
    const snap = buildProjectStyleSnapshot({
      stats: baseStats,
      stack: emptyStack,
      packageDeps: {
        '@modelcontextprotocol/client': '2.0.0',
        '@modelcontextprotocol/server': '2.0.0',
      },
    })

    expect(snap.payload.stack.keyLibraries.filter((name) => name === 'MCP SDK')).toHaveLength(1)
  })
})
