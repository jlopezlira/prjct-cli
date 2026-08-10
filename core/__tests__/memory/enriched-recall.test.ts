/**
 * enrichedRecall — the ONE retrieval pipeline every agent surface uses
 * (CLI `prjct context memory`, MCP `prjct_mem_list` / `prjct_mem_similar`).
 *
 * Pins the parity contract introduced when the MCP tools stopped using
 * plain recency recall: filters (types/tags) apply across legs, the FTS
 * leg feeds relevance, and link expansion can be disabled.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import { enrichedRecall } from '../../memory/enriched-recall'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: {
  tmpRoot: string
  projectPath: string
  projectId: string
} = {
  tmpRoot: '',
  projectPath: '',
  projectId: '',
}

function write(type: string, content: string, tags: Record<string, string> = {}): void {
  prjctDb.appendEvent(fixture.projectId, `memory.remember.${type}`, {
    content,
    tags,
    provenance: 'declared',
  })
}

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-enriched-'))
  fixture.projectPath = path.join(fixture.tmpRoot, 'repo')
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `test-enr-${Math.random().toString(36).slice(2, 8)}`
  patchPathManager(path.join(fixture.tmpRoot, 'global'))
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
})

afterEach(async () => {
  prjctDb.close()
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe('enrichedRecall', () => {
  it('returns recent entries without a topic (recall backfill leg)', async () => {
    write('decision', 'use bun for everything')
    write('gotcha', 'daemon caches stale code')
    const got = await enrichedRecall(fixture.projectPath, fixture.projectId, { limit: 10 })
    expect(got.length).toBe(2)
  })

  it('drops machine-telemetry noise from the RAG (clean recall, 12k retrocompat)', async () => {
    write('decision', 'use bun for everything')
    write('improvement-signal', 'no, not that way')
    write('learning', 'file churns a lot', { pattern: 'hot-file' })
    const got = await enrichedRecall(fixture.projectPath, fixture.projectId, { limit: 10 })
    const types = got.map((e) => e.type)
    expect(types).toContain('decision')
    expect(types).not.toContain('improvement-signal')
    expect(got.some((e) => e.tags?.pattern === 'hot-file')).toBe(false)
  })

  it('still returns noise when the caller EXPLICITLY asks for that type', async () => {
    write('improvement-signal', 'no, not that way')
    const got = await enrichedRecall(fixture.projectPath, fixture.projectId, {
      types: ['improvement-signal'],
      limit: 10,
    })
    expect(got.map((e) => e.type)).toContain('improvement-signal')
  })

  it('applies a types filter across legs', async () => {
    write('decision', 'use bun for everything')
    write('gotcha', 'daemon caches stale code')
    const got = await enrichedRecall(fixture.projectPath, fixture.projectId, {
      types: ['gotcha'],
      limit: 10,
    })
    expect(got.length).toBe(1)
    expect(got[0].type).toBe('gotcha')
  })

  it('applies a tags filter across legs', async () => {
    write('decision', 'auth uses oauth', { domain: 'auth' })
    write('decision', 'billing uses stripe', { domain: 'billing' })
    const got = await enrichedRecall(fixture.projectPath, fixture.projectId, {
      tags: { domain: 'auth' },
      limit: 10,
    })
    expect(got.length).toBe(1)
    expect(got[0].tags.domain).toBe('auth')
  })

  it('does not pad a healthy FTS result set with off-topic recency (P3 selectivity)', async () => {
    write('decision', 'token efficiency: compact the work surface')
    write('decision', 'token budget for the pull verbs')
    // Off-topic but MORE RECENT — the recency backfill would have dragged
    // these in to fill the limit before the selectivity fix.
    write('gotcha', 'daemon caches stale code')
    write('decision', 'cloud sync uses three tiers')
    write('learning', 'biome handles formatting')
    const got = await enrichedRecall(fixture.projectPath, fixture.projectId, {
      topic: 'token efficiency',
      limit: 10,
      expandLinks: false,
    })
    const contents = got.map((e) => e.content)
    expect(contents).toContain('token efficiency: compact the work surface')
    expect(contents).not.toContain('cloud sync uses three tiers')
    expect(contents.every((c) => c.toLowerCase().includes('token'))).toBe(true)
  })

  it('still backfills via substring recall when FTS tokenization misses (zero-FTS fallback)', async () => {
    // 'factor' is a substring of 'refactoring' but not a separate FTS token,
    // so the FTS leg returns nothing and the backfill must still rescue it.
    write('decision', 'refactoring the recall pipeline')
    const got = await enrichedRecall(fixture.projectPath, fixture.projectId, {
      topic: 'factor',
      limit: 10,
      expandLinks: false,
    })
    expect(got.length).toBeGreaterThanOrEqual(1)
  })

  it('expandLinks:false returns only the direct matches', async () => {
    write('decision', 'standalone decision with no relations')
    const got = await enrichedRecall(fixture.projectPath, fixture.projectId, {
      topic: 'standalone',
      limit: 10,
      expandLinks: false,
    })
    expect(got.length).toBeGreaterThanOrEqual(1)
  })
})
