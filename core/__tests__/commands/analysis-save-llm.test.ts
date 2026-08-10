import { afterEach, beforeEach, describe, expect, type spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { saveLlmAnalysis } from '../../commands/analysis/llm'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import llmAnalysisStorage from '../../storage/llm-analysis-storage'

async function freshProject(): Promise<{ projectPath: string; projectId: string }> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-llm-analysis-'))
  await fs.mkdir(path.join(projectPath, '.prjct'), { recursive: true })
  const projectId = `test-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(projectPath, {
    projectId,
    dataPath: path.join(projectPath, '.prjct-data'),
  })
  await pathManager.ensureProjectStructure(projectId)
  return { projectPath, projectId }
}

const MINIMAL_VALID = {
  version: 1 as const,
  commitHash: null,
  analyzedAt: '2026-06-22T00:00:00.000Z',
  architecture: {
    style: 'modular-monolith',
    insights: ['commands route through services'],
    domains: [],
  },
  patterns: [],
  antiPatterns: [],
  techDebt: [],
  riskAreas: [],
  refactorSuggestions: [],
  projectInsights: ['Use direct imports.'],
  conventions: [],
}

describe('analysis-save-llm', () => {
  const fixture: {
    projectPath: string
    projectId: string
    spies: Array<ReturnType<typeof spyOn>>
  } = {
    projectPath: '',
    projectId: '',
    spies: [],
  }

  beforeEach(async () => {
    ;({ projectPath: fixture.projectPath, projectId: fixture.projectId } = await freshProject())
  })

  afterEach(async () => {
    for (const s of fixture.spies) s.mockRestore()
    fixture.spies = []
    if (fixture.projectPath) await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('saves freeform Markdown notes as safe LLM analysis', async () => {
    const notes = [
      '# Project notes',
      '- current work',
      '- WIP',
      '- Commands should route through the manifest.',
      '- ---',
      '- AGENTS.md is the universal agent surface.',
    ].join('\n')

    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }
    try {
      const result = await saveLlmAnalysis(notes, fixture.projectPath, { md: true })
      expect(result.success).toBe(true)
    } finally {
      console.log = origLog
    }
    const out = logs.join('\n')
    expect(out).toMatch(/thin/i)
    expect(out).toMatch(/schema v1 JSON/i)

    const saved = llmAnalysisStorage.getActive(fixture.projectId)
    expect(saved?.architecture.style).toBe('unknown')
    expect(saved?.projectInsights).toContain('Commands should route through the manifest.')
    expect(saved?.projectInsights).toContain('AGENTS.md is the universal agent surface.')
    expect(saved?.projectInsights).not.toContain('current work')
    expect(saved?.projectInsights).not.toContain('WIP')
  })

  test('thin markdown notes do not clobber a rich house-style analysis', async () => {
    const rich = {
      ...MINIMAL_VALID,
      architecture: {
        style: 'modular-monolith',
        insights: ['commands route through services'],
        domains: ['core'],
      },
      patterns: [
        {
          name: 'Command registry',
          description: 'command-data.ts is the wire',
          locations: ['core/commands'],
          confidence: 0.95,
          category: 'architecture',
        },
      ],
      conventions: [
        { category: 'imports', rule: 'No barrel files', example: 'import from source' },
      ],
    }
    const first = await saveLlmAnalysis(JSON.stringify(rich), fixture.projectPath, { md: true })
    expect(first.success).toBe(true)

    const notes = ['# Notes', '- Extra insight about ship gates.', '- WIP'].join('\n')
    const second = await saveLlmAnalysis(notes, fixture.projectPath, { md: true })
    expect(second.success).toBe(true)

    const saved = llmAnalysisStorage.getActive(fixture.projectId)
    expect(saved?.architecture.style).toBe('modular-monolith')
    expect(saved?.patterns).toHaveLength(1)
    expect(saved?.patterns[0]?.name).toBe('Command registry')
    expect(saved?.conventions).toHaveLength(1)
    expect(saved?.projectInsights?.some((i) => i.includes('Extra insight'))).toBe(true)
  })

  test('reads a JSON analysis file path instead of parsing the path string as JSON', async () => {
    const file = path.join(fixture.projectPath, 'analysis.json')
    await fs.writeFile(file, JSON.stringify(MINIMAL_VALID), 'utf-8')

    const result = await saveLlmAnalysis(file, fixture.projectPath, { md: true })

    expect(result.success).toBe(true)
    const saved = llmAnalysisStorage.getActive(fixture.projectId)
    expect(saved?.architecture.style).toBe('modular-monolith')
    expect(saved?.projectInsights).toContain('Use direct imports.')
  })
})
