import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRetrievalReport } from '../../eval/report'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: { tmpRoot: string; projectId: string } = { tmpRoot: '', projectId: '' }

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-retrieval-baseline-'))
  fixture.projectId = `retrieval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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

describe('retrieval baseline report', () => {
  it('BM25 retrieves an author-cited entry for the citing query (committed floor)', async () => {
    // Older entry with distinctive tokens — the relevant target.
    const target = remember(
      'The daemon caches prepared statements per connection using a WeakMap keyed by SQL text.'
    )
    // Distractors sharing no distinctive tokens with the target.
    remember('Statusline renders from a two-second cache to avoid forking on every prompt.')
    remember('The onboarding wizard detects installed agents by probing home directories.')
    // Newer entry that cites the target — becomes the labeled pair (query = its text).
    remember(
      `Prepared statement caching in the daemon connection pool builds on ${target} and its WeakMap.`
    )

    const report = await buildRetrievalReport(fixture.projectId, 10)

    expect(report.corpusSize).toBe(4)
    expect(report.pairCount).toBeGreaterThanOrEqual(1)

    const leg = report.all
    expect(leg).not.toBeNull()
    if (!leg) return

    // Committed baseline: BM25 over the real FTS5 index MUST retrieve an
    // obviously-relevant, author-cited entry. A regression here means the
    // primary lexical leg stopped working.
    expect(leg.bm25.recallAtK).toBe(1)

    // Every metric stays a probability in [0, 1] for both retrievers.
    for (const m of [leg.bm25, leg.hashing]) {
      for (const v of [m.recallAtK, m.mrr, m.ndcgAtK]) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }

    // The improvement gate is wired and refuses to fire below decision-grade
    // volume (needs >= 100 labeled pairs).
    expect(leg.gate.sampleOk).toBe(false)
  })

  it('returns null legs and zero pairs for an empty corpus', async () => {
    const report = await buildRetrievalReport(fixture.projectId, 10)
    expect(report.pairCount).toBe(0)
    expect(report.all).toBeNull()
    expect(report.heldOut).toBeNull()
  })
})
