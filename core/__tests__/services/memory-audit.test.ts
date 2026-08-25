import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildMemoryAudit } from '../../services/memory-audit'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: { tmpRoot: string; projectId: string } = { tmpRoot: '', projectId: '' }

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-memory-audit-'))
  fixture.projectId = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  patchPathManager(fixture.tmpRoot)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0') // force migrations
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

function remember(content: string): string {
  const id = prjctDb.appendEvent(fixture.projectId, 'memory.remember.decision', {
    content,
    tags: {},
    provenance: 'declared',
  })
  return `mem_${id}`
}

describe('buildMemoryAudit', () => {
  it('fails the gate when a decision-grade corpus is mostly never read', () => {
    for (const i of Array.from({ length: 22 }, (_, k) => k)) {
      remember(`Decision ${i}: prefer a range predicate over LIKE for scan ${i}.`)
    }

    const audit = buildMemoryAudit(fixture.projectId)

    expect(audit.total).toBe(22)
    expect(audit.gated).toBe(true)
    // None have a usefulness row → all never read.
    expect(audit.neverRead).toBe(22)
    expect(audit.neverReadPct).toBe(100)
    expect(audit.passed).toBe(false)
    expect(audit.failures.some((f) => f.includes('never-read'))).toBe(true)

    // Structural sanity on the surfaced numbers.
    expect(audit.signalRatio).toBeGreaterThanOrEqual(0)
    expect(audit.signalRatio).toBeLessThanOrEqual(1)
    expect(audit.wouldDelete).toBeGreaterThanOrEqual(0)
    expect(audit.wouldArchive).toBeGreaterThanOrEqual(0)
  })

  it('reports but never fails below decision-grade volume', () => {
    remember('A single lonely decision that has never been cited.')
    const audit = buildMemoryAudit(fixture.projectId)
    expect(audit.total).toBe(1)
    expect(audit.gated).toBe(false)
    expect(audit.passed).toBe(true) // informational, not gated
  })

  it('counts an entry with usefulness engagement as read', () => {
    const ids = Array.from({ length: 21 }, (_, i) =>
      remember(`Decision ${i} about the sync pipeline stage ${i}.`)
    )
    // Engage exactly one entry (a real citation would set ref_count).
    prjctDb.run(
      fixture.projectId,
      'INSERT INTO memory_usefulness (memory_id, score, ref_count, last_used_at) VALUES (?, ?, ?, ?)',
      ids[0],
      1,
      1,
      new Date(0).toISOString()
    )

    const audit = buildMemoryAudit(fixture.projectId)
    expect(audit.engaged).toBe(1)
    expect(audit.neverRead).toBe(20)
  })
})
