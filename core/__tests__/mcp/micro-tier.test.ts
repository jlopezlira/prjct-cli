/**
 * Micro tier — ONE dispatch tool for non-caching hosts. The catalog is the
 * dominant per-request tax on Kimi/Codex (re-sent on every API call), so the
 * whole surface collapses to a single `prjct` tool whose handler dispatches
 * to the lean handlers. Also: gated results (repeat → pointer → full:true)
 * and the guard/mem shared ledger scope.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { projectMemory } from '../../memory/project-memory'
import { _resetDeliveredLedgerForTests } from '../../services/session-context-cache'
import { measureListTools } from '../../services/token-cost-bench'
import prjctDb from '../../storage/database'

type Handler = (
  args: unknown,
  extra: unknown
) => Promise<{
  content?: Array<{ type: string; text?: string }>
}>
type RegisteredTools = Record<string, { handler?: Handler }>

const fixture: { projectPath: string; projectId: string } = { projectPath: '', projectId: '' }

async function getTools(tier: string): Promise<RegisteredTools> {
  process.env.PRJCT_MCP_TOOLS = tier
  const { createServer } = await import('../../mcp/server')
  const server = createServer() as unknown as { _registeredTools?: RegisteredTools }
  return server._registeredTools ?? {}
}

function textOf(result: { content?: Array<{ type: string; text?: string }> } | null): string {
  return (result?.content ?? []).map((c) => c.text ?? '').join('\n')
}

beforeEach(async () => {
  _resetDeliveredLedgerForTests()
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-micro-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `micro-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
})

afterEach(async () => {
  delete process.env.PRJCT_MCP_TOOLS
  await fs.rm(fixture.projectPath, { recursive: true, force: true })
  prjctDb.close()
})

describe('micro tier', () => {
  it('registers exactly one tool with a <=800-char catalog', async () => {
    const tools = await getTools('micro')
    expect(Object.keys(tools)).toEqual(['prjct'])
    expect(measureListTools('micro').totalChars).toBeLessThanOrEqual(800)
  })

  it('dispatches each verb to the same handler the lean tool uses', async () => {
    await projectMemory.remember(fixture.projectPath, {
      type: 'gotcha',
      content: 'Micro dispatch must reuse lean handlers verbatim',
      projectId: fixture.projectId,
    })
    const micro = (await getTools('micro')).prjct?.handler
    expect(micro).toBeDefined()
    _resetDeliveredLedgerForTests()
    const viaMicro = textOf(
      await micro!(
        { verb: 'mem_list', args: { projectPath: fixture.projectPath, topic: 'micro dispatch' } },
        {}
      )
    )
    _resetDeliveredLedgerForTests()
    const lean = (await getTools('lean')).prjct_mem_list?.handler
    const viaLean = textOf(
      await lean!({ projectPath: fixture.projectPath, topic: 'micro dispatch' }, {})
    )
    expect(viaMicro).toBe(viaLean)
    expect(viaMicro).toContain('Micro dispatch')
  })

  it('rejects unknown verbs with the valid verb list', async () => {
    const micro = (await getTools('micro')).prjct?.handler
    const out = textOf(await micro!({ verb: 'nonsense' as never, args: {} }, {}))
    expect(out).toContain('Unknown verb')
    expect(out).toContain('mem_list')
  })
})

describe('gated MCP results (repeat → pointer)', () => {
  it('prjct_analysis second identical call collapses to a <=120-char pointer', async () => {
    const llmAnalysisStorage = (await import('../../storage/llm-analysis-storage')).default
    llmAnalysisStorage.save(fixture.projectId, {
      version: 1,
      commitHash: null,
      analyzedAt: new Date().toISOString(),
      projectType: 'cli',
      stack: { languages: ['TypeScript'], frameworks: [] },
      architecture: { style: 'modular', domains: ['auth'], insights: ['insight one'] },
      patterns: [{ name: 'p1', description: 'd1' }],
      antiPatterns: [],
      techDebt: [],
      riskAreas: [],
      refactorSuggestions: [],
      conventions: [{ rule: 'const-only' }],
      commands: { test: 'bun test' },
      projectInsights: [],
    } as unknown as Parameters<typeof llmAnalysisStorage.save>[1])

    const analysis = (await getTools('lean')).prjct_analysis?.handler
    const first = textOf(await analysis!({ projectPath: fixture.projectPath }, {}))
    expect(first).toContain('## Project Analysis')

    const repeat = textOf(await analysis!({ projectPath: fixture.projectPath }, {}))
    expect(repeat.length).toBeLessThanOrEqual(120)
    expect(repeat).toContain('unchanged')
    expect(repeat).toContain('full:true')

    const forced = textOf(await analysis!({ projectPath: fixture.projectPath, full: true }, {}))
    expect(forced).toContain('## Project Analysis')
  })

  it('bounds the relational analysis findings (full:true unbounds)', async () => {
    const llmAnalysisStorage = (await import('../../storage/llm-analysis-storage')).default
    llmAnalysisStorage.save(fixture.projectId, {
      version: 1,
      commitHash: null,
      analyzedAt: new Date().toISOString(),
      projectType: 'cli',
      stack: { languages: ['TypeScript'], frameworks: [] },
      architecture: { style: 'modular', domains: [], insights: [] },
      patterns: Array.from({ length: 30 }, (_, i) => ({ name: `pat-${i}`, description: `d${i}` })),
      antiPatterns: [],
      techDebt: [],
      riskAreas: [],
      refactorSuggestions: [],
      conventions: [],
      commands: {},
      projectInsights: [],
    } as unknown as Parameters<typeof llmAnalysisStorage.save>[1])

    const analysis = (await getTools('lean')).prjct_analysis?.handler
    const bounded = textOf(await analysis!({ projectPath: fixture.projectPath }, {}))
    expect(bounded).toContain('pat-7')
    expect(bounded).not.toContain('pat-8**')
    expect(bounded).toContain('+22 more (full:true)')

    const full = textOf(await analysis!({ projectPath: fixture.projectPath, full: true }, {}))
    expect(full).toContain('pat-29')
  })

  it('guard shares the mem ledger scope — entries delivered by mem_list collapse', async () => {
    await fs.writeFile(path.join(fixture.projectPath, 'auth.ts'), 'export const auth = 1\n')
    await projectMemory.remember(fixture.projectPath, {
      type: 'gotcha',
      content: 'auth.ts token refresh must retry once before failing',
      tags: { file: 'auth.ts' },
      projectId: fixture.projectId,
    })
    const tools = await getTools('lean')
    const first = textOf(
      await tools.prjct_guard!.handler!({ projectPath: fixture.projectPath, file: 'auth.ts' }, {})
    )
    const second = textOf(
      await tools.prjct_guard!.handler!({ projectPath: fixture.projectPath, file: 'auth.ts' }, {})
    )
    if (first.includes('token refresh')) {
      expect(second).toContain('Already in your context this session')
      expect(second.length).toBeLessThan(first.length)
    }
  })
})
