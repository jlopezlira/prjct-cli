import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  applyRetention,
  evaluateRetentionShared,
  graceDaysFor,
  idleAfterDaysFor,
} from '../../services/retention'
import { DEFAULT_ARCHIVE_PRUNE_DAYS } from '../../services/retention/purge'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const DAY_MS = 86_400_000

const fixture: { tmpRoot: string; projectId: string } = { tmpRoot: '', projectId: '' }

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-retention-confidence-'))
  fixture.projectId = `conf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  patchPathManager(fixture.tmpRoot)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0') // force migrations
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

function remember(content: string, tags: Record<string, string> = {}): string {
  const id = prjctDb.appendEvent(fixture.projectId, 'memory.remember.decision', {
    content,
    tags,
    provenance: 'declared',
  })
  return `mem_${id}`
}

describe('provenance-aware rot policy', () => {
  it('auto-captured knowledge idles and loses grace much sooner than declared', () => {
    expect(idleAfterDaysFor('transcript-auto')).toBeLessThan(idleAfterDaysFor(undefined))
    expect(graceDaysFor('transcript-auto')).toBeLessThan(graceDaysFor(undefined))
    // Pin the decided policy: auto rots at 14d/7d vs human 90d/30d.
    expect(idleAfterDaysFor('transcript-auto')).toBe(14)
    expect(graceDaysFor('transcript-auto')).toBe(7)
    expect(idleAfterDaysFor('declared-whatever')).toBe(90)
    expect(graceDaysFor(undefined)).toBe(30)
  })

  it('flags an unused auto-source entry as idle at an age a declared entry survives', () => {
    const autoId = remember('Transient network error while syncing the vault to cloud endpoint.', {
      source: 'transcript-auto',
    })
    const declaredId = remember('Range predicates beat LIKE scans for memory event queries.')

    const nowPlus20d = Date.now() + 20 * DAY_MS
    const report = evaluateRetentionShared(fixture.projectId, nowPlus20d)

    const auto = report.byId.get(autoId)
    const declared = report.byId.get(declaredId)
    expect(auto).toBeDefined()
    expect(declared).toBeDefined()
    // 20d > auto onset (14d) but < human onset (90d).
    expect(auto?.reasons.some((r) => r.startsWith('idle'))).toBe(true)
    expect(declared?.reasons.some((r) => r.startsWith('idle'))).toBe(false)
  })
})

describe('archive TTL', () => {
  it('hard-deletes archived entries after one repo-week by default', () => {
    expect(DEFAULT_ARCHIVE_PRUNE_DAYS).toBe(7)
  })
})

describe('confidence persistence', () => {
  it('applyRetention writes each entry retention score to memory_entries.confidence', () => {
    const id = remember('Prefer BEGIN IMMEDIATE over optimistic CAS retries for kv updates.')

    const result = applyRetention(fixture.projectId, { dryRun: false })
    expect(result.dryRun).toBe(false)

    const row = prjctDb.get<{ confidence: number | null }>(
      fixture.projectId,
      'SELECT confidence FROM memory_entries WHERE id = ?',
      id
    )
    expect(row?.confidence).not.toBeNull()
    const report = evaluateRetentionShared(fixture.projectId, Date.now())
    const expected = Math.round(report.byId.get(id)?.score ?? -1) / 100
    expect(row?.confidence).toBeCloseTo(expected, 2)
    expect(row?.confidence).toBeGreaterThanOrEqual(0)
    expect(row?.confidence).toBeLessThanOrEqual(1)
  })

  it('dry-run does not write confidence', () => {
    const id = remember('Dry-run must stay observational end to end.')
    applyRetention(fixture.projectId, { dryRun: true })
    const row = prjctDb.get<{ confidence: number | null }>(
      fixture.projectId,
      'SELECT confidence FROM memory_entries WHERE id = ?',
      id
    )
    expect(row?.confidence).toBeNull()
  })
})
