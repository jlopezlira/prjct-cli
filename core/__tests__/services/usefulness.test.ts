/**
 * Memory reinforcement ledger — "smarter with use".
 *
 * Pins: reference/fetch signals accumulate a score, scores TIME-DECAY by
 * half-life, and recall re-ranking gives a BOUNDED usefulness boost (a
 * proven entry climbs, but relevance still leads and unscored entries keep
 * their order). Time is injected so decay is deterministic.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { MemoryEntry } from '../../memory/entries'
import { extractRefIds, usefulnessService } from '../../services/usefulness'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: {
  tmpRoot: string
  projectId: string
} = {
  tmpRoot: '',
  projectId: '',
}

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const T0_ISO = new Date(T0).toISOString()
const DAY = 86_400_000

const fakeEntry = (id: string): MemoryEntry =>
  ({
    id,
    type: 'decision',
    content: id,
    tags: {},
    rememberedAt: T0_ISO,
    provenance: 'declared',
  }) as MemoryEntry

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-useful-'))
  fixture.projectId = `test-useful-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  patchPathManager(fixture.tmpRoot)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0') // force migrations
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe('extractRefIds', () => {
  it('pulls ids from relationship tags and inline mentions', () => {
    const ids = extractRefIds('builds on mem_7 and mem_8', { resolves: 'mem_3', other: 'x' })
    expect(new Set(ids)).toEqual(new Set(['mem_3', 'mem_7', 'mem_8']))
  })
  it('returns [] when there are no refs', () => {
    expect(extractRefIds('no references here', {})).toHaveLength(0)
  })
})

describe('usefulnessService — accumulation + decay', () => {
  it('credits referenced ids and exposes their score', () => {
    usefulnessService.recordReferences(fixture.projectId, 'see mem_5', {}, T0_ISO)
    const scores = usefulnessService.decayedScores(fixture.projectId, T0)
    expect(scores.get('mem_5')).toBeCloseTo(1.0, 5)
  })

  it('a reference outweighs a fetch', () => {
    usefulnessService.recordReferences(fixture.projectId, 'mem_1', {}, T0_ISO)
    usefulnessService.recordFetch(fixture.projectId, 'mem_2', T0_ISO)
    const s = usefulnessService.decayedScores(fixture.projectId, T0)
    expect(s.get('mem_1')!).toBeGreaterThan(s.get('mem_2')!)
  })

  it('decays to ~half after one half-life (45d)', () => {
    usefulnessService.recordReferences(fixture.projectId, 'mem_9', {}, T0_ISO)
    const decayed = usefulnessService.decayedScores(fixture.projectId, T0 + 45 * DAY)
    expect(decayed.get('mem_9')).toBeCloseTo(0.5, 2)
  })

  it('accumulates repeated references', () => {
    usefulnessService.recordReferences(fixture.projectId, 'mem_4', {}, T0_ISO)
    usefulnessService.recordReferences(fixture.projectId, 'mem_4 again', {}, T0_ISO)
    expect(usefulnessService.decayedScores(fixture.projectId, T0).get('mem_4')).toBeCloseTo(2.0, 5)
  })
})

describe('usefulnessService.rerank', () => {
  it('lifts a proven entry above an unused one ranked just ahead of it', () => {
    // Give mem_2 a strong score; it starts BELOW mem_1 in relevance order.
    for (const _ of Array.from({ length: 5 }))
      usefulnessService.recordReferences(fixture.projectId, 'mem_2', {}, T0_ISO)
    const ordered = [fakeEntry('mem_1'), fakeEntry('mem_2'), fakeEntry('mem_3')]
    const reranked = usefulnessService.rerank(fixture.projectId, ordered, T0)
    expect(reranked[0]?.id).toBe('mem_2')
  })

  it('is a no-op when nothing has a score (preserves order)', () => {
    const ordered = [fakeEntry('mem_1'), fakeEntry('mem_2'), fakeEntry('mem_3')]
    const reranked = usefulnessService.rerank(fixture.projectId, ordered, T0)
    expect(reranked.map((e) => e.id)).toEqual(['mem_1', 'mem_2', 'mem_3'])
  })

  it('boost is bounded — a tiny score cannot leap a far-more-relevant entry', () => {
    usefulnessService.recordFetch(fixture.projectId, 'mem_99', T0_ISO) // weak, single fetch
    // mem_99 is dead last in a long relevance-ordered list.
    const ordered = Array.from({ length: 10 }, (_, i) => fakeEntry(`mem_${i}`))
    ordered.push(fakeEntry('mem_99'))
    const reranked = usefulnessService.rerank(fixture.projectId, ordered, T0)
    // It may climb a few slots but must NOT reach the top.
    expect(reranked[0]?.id).toBe('mem_0')
  })
})

describe('usefulnessService — ship-success attribution', () => {
  it('credits surfaced entries on ship and clears the log', () => {
    usefulnessService.recordSurfaced(fixture.projectId, ['mem_10', 'mem_11'], 'task-1', T0_ISO, {
      queryText: 'authentication migration gotcha',
      surface: 'context-memory',
    })
    const credited = usefulnessService.creditShippedTask(fixture.projectId, 'task-1', T0_ISO)
    expect(credited).toBe(2)

    const scores = usefulnessService.decayedScores(fixture.projectId, T0)
    // Ship credit (2.5) is the strongest signal — stronger than a reference.
    expect(scores.get('mem_10')).toBeCloseTo(2.5, 5)
    expect(scores.get('mem_11')).toBeCloseTo(2.5, 5)

    // Log cleared → a second credit finds nothing.
    expect(usefulnessService.creditShippedTask(fixture.projectId, 'task-1', T0_ISO)).toBe(0)

    const labels = prjctDb.query<{
      query_text: string
      positive_id: string
      source: string
      source_task_id: string
    }>(
      fixture.projectId,
      `SELECT query_text, positive_id, source, source_task_id
       FROM retrieval_eval_labels
       ORDER BY positive_id`
    )
    expect(labels).toEqual([
      {
        query_text: 'authentication migration gotcha',
        positive_id: 'mem_10',
        source: 'ship-surfaced',
        source_task_id: 'task-1',
      },
      {
        query_text: 'authentication migration gotcha',
        positive_id: 'mem_11',
        source: 'ship-surfaced',
        source_task_id: 'task-1',
      },
    ])
  })

  it('only credits the shipped task, leaving other tasks pending', () => {
    usefulnessService.recordSurfaced(fixture.projectId, ['mem_20'], 'task-a', T0_ISO)
    usefulnessService.recordSurfaced(fixture.projectId, ['mem_21'], 'task-b', T0_ISO)
    usefulnessService.creditShippedTask(fixture.projectId, 'task-a', T0_ISO)

    const scores = usefulnessService.decayedScores(fixture.projectId, T0)
    expect(scores.get('mem_20')).toBeCloseTo(2.5, 5)
    expect(scores.has('mem_21')).toBe(false) // task-b never shipped → no credit yet
    // task-b's surface row survives for a later ship.
    expect(usefulnessService.creditShippedTask(fixture.projectId, 'task-b', T0_ISO)).toBe(1)
  })

  it('adds ship credit on top of an existing usefulness score', () => {
    usefulnessService.recordFetch(fixture.projectId, 'mem_30', T0_ISO) // 0.4
    usefulnessService.recordSurfaced(fixture.projectId, ['mem_30'], 'task-x', T0_ISO)
    usefulnessService.creditShippedTask(fixture.projectId, 'task-x', T0_ISO)
    expect(usefulnessService.decayedScores(fixture.projectId, T0).get('mem_30')).toBeCloseTo(2.9, 5)
  })

  it('is a no-op for an empty task id or no surfaced rows', () => {
    expect(usefulnessService.creditShippedTask(fixture.projectId, '', T0_ISO)).toBe(0)
    expect(usefulnessService.creditShippedTask(fixture.projectId, 'never-surfaced', T0_ISO)).toBe(0)
  })
})

describe('usefulnessService — automatic friction penalty (no command)', () => {
  it('demotes surfaced entries on friction but keeps the rows (task still open)', () => {
    usefulnessService.recordSurfaced(fixture.projectId, ['mem_60', 'mem_61'], 'task-f', T0_ISO)
    const nudged = usefulnessService.penalizeSurfaced(fixture.projectId, 'task-f', T0_ISO)
    expect(nudged).toBe(2)

    const scores = usefulnessService.decayedScores(fixture.projectId, T0)
    expect(scores.get('mem_60')).toBeCloseTo(-0.5, 5)
    expect(scores.get('mem_61')).toBeCloseTo(-0.5, 5)

    // Rows are NOT cleared — a later ship can still credit the same task.
    const credited = usefulnessService.creditShippedTask(fixture.projectId, 'task-f', T0_ISO)
    expect(credited).toBe(2)
    // Net per entry: -0.5 (friction) + 2.5 (ship) = 2.0.
    expect(usefulnessService.decayedScores(fixture.projectId, T0).get('mem_60')).toBeCloseTo(2.0, 5)
  })

  it('is a no-op for an empty task id', () => {
    expect(usefulnessService.penalizeSurfaced(fixture.projectId, '', T0_ISO)).toBe(0)
  })
})

describe('usefulnessService — negative signal (corrections)', () => {
  it('a `corrects:` tag drives the marked entry NEGATIVE', () => {
    usefulnessService.recordCorrection(fixture.projectId, { corrects: 'mem_40' }, T0_ISO)
    expect(usefulnessService.decayedScores(fixture.projectId, T0).get('mem_40')).toBeCloseTo(
      -2.5,
      5
    )
  })

  it('`contradicts:` works the same and only acts on explicit tags', () => {
    // Inline mention in CONTENT must NOT penalize — corrections are tags-only.
    usefulnessService.recordReferences(fixture.projectId, 'builds on mem_41', {}, T0_ISO) // +1.0
    usefulnessService.recordCorrection(fixture.projectId, { contradicts: 'mem_42' }, T0_ISO)
    const s = usefulnessService.decayedScores(fixture.projectId, T0)
    expect(s.get('mem_41')).toBeCloseTo(1.0, 5) // referenced, not corrected
    expect(s.get('mem_42')).toBeCloseTo(-2.5, 5) // corrected
  })

  it('does NOT credit an inline reference to an id the same entry corrects', () => {
    // Real-world shape found in live testing: a correction names the entry it
    // corrects in its own text ("mem_70 was wrong"). The inline mention must
    // not earn a +1.0 reference that cancels the -2.5 penalty.
    const corrector = 'REINFORCE: mem_70 turned out wrong'
    usefulnessService.recordReferences(fixture.projectId, corrector, { corrects: 'mem_70' }, T0_ISO)
    usefulnessService.recordCorrection(fixture.projectId, { corrects: 'mem_70' }, T0_ISO)
    // Pure -2.5, NOT -2.5 + 1.0.
    expect(usefulnessService.decayedScores(fixture.projectId, T0).get('mem_70')).toBeCloseTo(
      -2.5,
      5
    )
  })

  it('a correction can flip a previously-useful entry net-negative', () => {
    usefulnessService.recordReferences(fixture.projectId, 'mem_43', {}, T0_ISO) // +1.0
    usefulnessService.recordCorrection(fixture.projectId, { corrects: 'mem_43' }, T0_ISO) // -2.5
    expect(usefulnessService.decayedScores(fixture.projectId, T0).get('mem_43')).toBeCloseTo(
      -1.5,
      5
    )
  })

  it('rerank SINKS a corrected entry below its relevance position', () => {
    usefulnessService.recordCorrection(fixture.projectId, { corrects: 'mem_50' }, T0_ISO)
    // mem_50 leads on relevance but is a known mistake; mem_51/52 are neutral.
    const ordered = [fakeEntry('mem_50'), fakeEntry('mem_51'), fakeEntry('mem_52')]
    const reranked = usefulnessService.rerank(fixture.projectId, ordered, T0)
    expect(reranked[0]?.id).not.toBe('mem_50')
    expect(reranked.at(-1)?.id).toBe('mem_50')
  })
})
