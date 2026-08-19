/**
 * Archive reads are bounded by construction: the superseded-analysis history
 * grows with project age, so the MCP archive path takes a SQL LIMIT and
 * reports the elided remainder instead of dumping every historical body.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { boundedLimit } from '../../mcp/resolve'
import { prjctDb } from '../../storage/database'
import llmAnalysisStorage from '../../storage/llm-analysis-storage'

const fixture: { tmpRoot: string; projectId: string } = { tmpRoot: '', projectId: '' }
const original = pathManager.getGlobalProjectPath.bind(pathManager)

describe('llm-analysis archive bounds', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-archive-'))
    fixture.projectId = `archive-${Math.random().toString(36).slice(2, 10)}`
    pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
    prjctDb.getDb(fixture.projectId)
  })
  afterEach(async () => {
    prjctDb.close()
    pathManager.getGlobalProjectPath = original
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
  })

  it('getArchiveSummaries caps entries and reports the true total', () => {
    for (const i of Array.from({ length: 50 }, (_, n) => n)) {
      prjctDb.run(
        fixture.projectId,
        'INSERT INTO llm_analysis (commit_hash, status, analysis, analyzed_at, superseded_at) VALUES (?, ?, ?, ?, ?)',
        `commit${i}`,
        'superseded',
        JSON.stringify({ version: 1, patterns: [], antiPatterns: [], techDebt: [] }),
        new Date(2026, 0, 1 + i).toISOString(),
        new Date(2026, 0, 2 + i).toISOString()
      )
    }
    const archive = llmAnalysisStorage.getArchiveSummaries(fixture.projectId, 20)
    expect(archive.total).toBe(50)
    expect(archive.entries.length).toBe(20)
    // Newest first
    expect(archive.entries[0]!.commitHash).toBe('commit49')
  })

  it('boundedLimit rejects oversized client limits at the schema layer', () => {
    const schema = boundedLimit(25, 50)
    expect(schema.safeParse(5000).success).toBe(false)
    expect(schema.safeParse(0).success).toBe(false)
    expect(schema.safeParse(50).success).toBe(true)
    expect(schema.parse(undefined)).toBe(25)
  })
})
