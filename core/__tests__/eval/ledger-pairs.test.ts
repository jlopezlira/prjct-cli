import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  exportLedgerPairs,
  groupQueryPairs,
  type LabeledPair,
  temporalSplit,
  toQueryText,
} from '../../eval/ledger-pairs'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

function pair(anchorId: string, anchorDate: string): LabeledPair {
  return {
    anchorId,
    queryText: `query ${anchorId}`,
    positives: [`positive-${anchorId}`],
    anchorDate,
  }
}

const fixture: {
  tmpRoot: string
  projectId: string
} = {
  tmpRoot: '',
  projectId: '',
}

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-ledger-pairs-'))
  fixture.projectId = `ledger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  patchPathManager(fixture.tmpRoot)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0') // force migrations
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

describe('toQueryText', () => {
  it('strips mem ids so eval queries cannot leak the target id', () => {
    expect(toQueryText('Fix follows mem_123 and MEM-456 with context')).toBe(
      'Fix follows and with context'
    )
  })

  it('normalizes whitespace after stripping references', () => {
    expect(toQueryText('  mem_1\n\nuseful   context\tmem-2  ')).toBe('useful context')
  })
})

describe('temporalSplit', () => {
  it('groups repeated queries with all positives and prevents citing-anchor leakage', () => {
    const grouped = groupQueryPairs([
      {
        ...pair('anchor-new', '2026-01-05'),
        queryText: 'same query',
        positives: ['target-a', 'anchor-old'],
      },
      { ...pair('anchor-old', '2026-01-01'), queryText: 'same  query', positives: ['target-b'] },
      {
        ...pair('proxy', '2026-01-06'),
        queryText: 'same query',
        source: 'ship-surfaced',
        positives: ['target-c'],
      },
    ])
    expect(grouped).toHaveLength(2)
    expect(grouped[0]).toMatchObject({
      anchorId: 'anchor-old',
      anchorDate: '2026-01-01',
      positives: ['target-a', 'target-b'],
      excludeIds: ['anchor-new', 'anchor-old'],
    })
    expect(grouped[1]?.source).toBe('ship-surfaced')
    expect(groupQueryPairs([{ ...pair('self', '2026-01-01'), positives: ['self'] }])).toEqual([])
  })
  it('keeps the newest pairs in eval and older pairs in train', () => {
    const split = temporalSplit(
      [
        pair('newest', '2026-01-05T00:00:00.000Z'),
        pair('oldest', '2026-01-01T00:00:00.000Z'),
        pair('middle', '2026-01-03T00:00:00.000Z'),
      ],
      1 / 3
    )

    expect(split.cutoff).toBe('2026-01-05T00:00:00.000Z')
    expect(split.train.map((p) => p.anchorId)).toEqual(['oldest', 'middle'])
    expect(split.evalSet.map((p) => p.anchorId)).toEqual(['newest'])
  })

  it('returns an empty split for no pairs', () => {
    expect(temporalSplit([])).toEqual({ cutoff: '', train: [], evalSet: [] })
  })
})

describe('exportLedgerPairs', () => {
  it('includes durable ship-surfaced labels when the positive exists in the corpus', () => {
    const id = prjctDb.appendEvent(fixture.projectId, 'memory.remember.decision', {
      content: 'Use range predicates instead of LIKE for memory event scans.',
      tags: {},
      provenance: 'declared',
    })
    const positiveId = `mem_${id}`
    prjctDb.run(
      fixture.projectId,
      `INSERT INTO retrieval_eval_labels
         (query_text, positive_id, source, source_task_id, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'memory event scan performance',
      positiveId,
      'ship-surfaced',
      'task-1',
      '2026-01-01T00:00:00.000Z',
      '{}'
    )

    const corpus = exportLedgerPairs(fixture.projectId)
    const label = corpus.pairs.find((p) => p.source === 'ship-surfaced')

    expect(label).toMatchObject({
      queryText: 'memory event scan performance',
      positives: [positiveId],
      source: 'ship-surfaced',
    })
  })
})
