/**
 * C3: LLM synthesis is stored as relational records (analysis_finding +
 * convention/stack/command/domain), not only a JSON blob — queryable
 * field-by-field, archive = WHERE status='superseded'.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { prjctDb } from '../../storage/database'
import llmAnalysisStorage from '../../storage/llm-analysis-storage'
import type { LLMAnalysis } from '../../types/llm-analysis'

const fixture: {
  tmpRoot: string
  projectId: string
} = {
  tmpRoot: '',
  projectId: '',
}

const original = pathManager.getGlobalProjectPath.bind(pathManager)

function makeAnalysis(): LLMAnalysis {
  return {
    version: 1,
    commitHash: 'abc1234',
    analyzedAt: new Date().toISOString(),
    architecture: { style: 'modular-monolith', insights: ['layered'], domains: ['memory', 'sync'] },
    patterns: [
      {
        name: 'repository',
        description: 'data access',
        locations: [],
        confidence: 0.9,
        category: 'architecture',
      },
    ],
    antiPatterns: [
      {
        issue: 'god object',
        reasoning: 'x',
        files: [],
        suggestion: 'split',
        severity: 'high',
        confidence: 0.8,
      },
    ],
    techDebt: [
      {
        description: 'flaky tests',
        area: 'ci',
        effort: 'medium',
        impact: 'slows ship',
        priority: 'high',
      },
    ],
    riskAreas: [{ path: 'auth.ts', reason: 'complex', risk: 'breakage', severity: 'medium' }],
    refactorSuggestions: [
      { description: 'extract module', files: [], benefit: 'clarity', effort: 'small' },
    ],
    projectInsights: ['insight one'],
    conventions: [{ category: 'naming', rule: 'kebab-case files' }],
    commands: { build: 'bun run build', test: 'bun test' },
    stack: { languages: ['TypeScript'], frameworks: ['Bun'], packageManager: 'bun' },
  }
}

describe('llm_analysis relational children (C3)', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-llm-v2-'))
    fixture.projectId = `llmv2-${Math.random().toString(36).slice(2, 10)}`
    pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
    prjctDb.getDb(fixture.projectId)
  })
  afterEach(async () => {
    prjctDb.close()
    pathManager.getGlobalProjectPath = original
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
  })

  it('writes findings/conventions/stack/commands/domains as rows', () => {
    llmAnalysisStorage.save(fixture.projectId, makeAnalysis())

    const kinds = prjctDb.query<{ kind: string; n: number }>(
      fixture.projectId,
      'SELECT kind, COUNT(*) AS n FROM analysis_finding GROUP BY kind'
    )
    const byKind = new Map(kinds.map((k) => [k.kind, k.n]))
    expect(byKind.get('pattern')).toBe(1)
    expect(byKind.get('anti_pattern')).toBe(1)
    expect(byKind.get('tech_debt')).toBe(1)
    expect(byKind.get('risk_area')).toBe(1)
    expect(byKind.get('refactor')).toBe(1)
    expect(byKind.get('insight')).toBe(2) // projectInsights + architecture.insights

    expect(prjctDb.query(fixture.projectId, 'SELECT id FROM analysis_convention').length).toBe(1)
    expect(prjctDb.query(fixture.projectId, 'SELECT id FROM analysis_stack_item').length).toBe(2)
    expect(prjctDb.query(fixture.projectId, 'SELECT id FROM analysis_command').length).toBe(2)
    expect(prjctDb.query(fixture.projectId, 'SELECT id FROM analysis_domain').length).toBe(2)
  })

  it('getActiveRelational reads findings/conventions/stack from child tables', () => {
    llmAnalysisStorage.save(fixture.projectId, makeAnalysis())
    const rel = llmAnalysisStorage.getActiveRelational(fixture.projectId)
    expect(rel).not.toBeNull()
    expect(rel?.findings.some((f) => f.kind === 'pattern')).toBe(true)
    expect(rel?.findings.some((f) => f.kind === 'tech_debt')).toBe(true)
    expect(rel?.conventions).toContain('kebab-case files')
    expect(rel?.stack.some((s) => s.kind === 'language' && s.name === 'TypeScript')).toBe(true)
    expect(rel?.domains).toContain('memory')
  })

  it('keeps superseded analyses queryable (archive = WHERE status)', () => {
    llmAnalysisStorage.save(fixture.projectId, makeAnalysis())
    llmAnalysisStorage.save(fixture.projectId, makeAnalysis())
    const statuses = prjctDb.query<{ status: string; n: number }>(
      fixture.projectId,
      'SELECT status, COUNT(*) AS n FROM llm_analysis GROUP BY status'
    )
    const byStatus = new Map(statuses.map((s) => [s.status, s.n]))
    expect(byStatus.get('active')).toBe(1)
    expect(byStatus.get('superseded')).toBe(1)
    // Each analysis kept its own finding rows.
    const totalFindings = prjctDb.query<{ n: number }>(
      fixture.projectId,
      'SELECT COUNT(*) AS n FROM analysis_finding'
    )[0].n
    expect(totalFindings).toBe(14) // 7 findings × 2 analyses
  })
})
