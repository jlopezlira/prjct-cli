/**
 * Skill-miss detector (harness #16).
 *
 * Pure-core tests pin the heuristic contract: relevance needs a path
 * hit OR ≥2 distinctive shared tokens, a referenced memory is never a
 * miss, token-only detection survives an empty changed-file list,
 * hashKey is stable. The DB integration test pins persistence shape,
 * idempotent dedup, inferred/recency containment, and the
 * no-loose-files persistence rule.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { _internal, detectSkillMisses } from '../../services/skill-miss-detector'
import { crewRunStorage } from '../../storage/crew-run-storage'
import prjctDb from '../../storage/database'
import { execFileAsync } from '../../utils/exec'

interface CM {
  id: string
  type: string
  content: string
  fileTag: string
  rememberedAt: string
  provenance: string
  session: string
}

function mem(over: Partial<CM>): CM {
  return {
    id: over.id ?? 'mem_1',
    type: over.type ?? 'decision',
    content: over.content ?? '',
    fileTag: over.fileTag ?? '',
    rememberedAt: over.rememberedAt ?? new Date(0).toISOString(),
    provenance: over.provenance ?? 'declared',
    session: over.session ?? '',
  }
}

describe('skill-miss-detector — tokenize', () => {
  it('drops short tokens and stopwords, lowercases', () => {
    const t = _internal.tokenize('Always wrap the SQLite busy PRAGMA handle')
    expect(t.has('always')).toBe(false) // stopword
    expect(t.has('the')).toBe(false) // too short
    expect(t.has('busy')).toBe(false) // < MIN_TOKEN_LEN (4)
    expect(t.has('sqlite')).toBe(true)
    expect(t.has('pragma')).toBe(true)
    expect(t.has('handle')).toBe(true)
  })
})

describe('skill-miss-detector — analyze', () => {
  it('flags a relevant-but-unreferenced memory (token overlap, no git)', () => {
    const transcript = 'edited the sqlite connection and pragma handling for the project'
    const out = _internal.analyze(
      transcript,
      [],
      [mem({ id: 'mem_42', content: 'Set sqlite pragma busy_timeout to 5000 on every handle' })]
    )
    expect(out.length).toBe(1)
    expect(out[0]?.memId).toBe('mem_42')
    expect(out[0]?.reason).toBe('topic-overlap-unused')
    expect(out[0]?.evidenceFile).toBe('')
  })

  it('does NOT flag when a distinctive token was referenced (knowledge applied)', () => {
    // "busy_timeout" → token "timeout" (len 7, distinctive) appears in the
    // transcript → the memory was consulted.
    const transcript = 'set the sqlite pragma busy timeout to 5000 like the decision said'
    const out = _internal.analyze(
      transcript,
      [],
      [mem({ content: 'Set sqlite pragma busy_timeout to 5000 on every handle' })]
    )
    expect(out.length).toBe(0)
  })

  it('requires ≥2 token overlap OR a path hit (false-positive containment)', () => {
    const transcript = 'worked on the unrelated billing invoice export feature today'
    const out = _internal.analyze(
      transcript,
      [],
      [mem({ content: 'Set sqlite pragma busy_timeout to 5000' })]
    )
    expect(out.length).toBe(0)
  })

  it('flags via changed-file path overlap and records the evidence file', () => {
    const transcript = 'made some edits and moved on to the next thing entirely'
    const out = _internal.analyze(
      transcript,
      ['core/storage/database.ts'],
      [
        mem({
          id: 'mem_7',
          content: 'database connections need pragma busy_timeout',
          fileTag: 'core/storage/database.ts',
        }),
      ]
    )
    expect(out.length).toBe(1)
    expect(out[0]?.reason).toBe('path-overlap-unused')
    expect(out[0]?.evidenceFile).toBe('core/storage/database.ts')
  })

  it('empty changed-file list never breaks token-based detection (criterion #4)', () => {
    // Transcript shares TOPIC tokens (ranker, scoring) but never the
    // memory's signature ("retrieval") → relevant, unreferenced → miss.
    const transcript = 'tuned the ranker scoring and reranker heuristics today'
    const out = _internal.analyze(
      transcript,
      [],
      [mem({ content: 'retrieval ranker scoring must combine bm25 and import-graph' })]
    )
    expect(out.length).toBe(1)
  })

  it('orders path-overlap misses before token-only ones', () => {
    const out = _internal.analyze(
      'changed the ranker scoring weights and cache plumbing extensively',
      ['core/domain/file-ranker.ts'],
      [
        mem({ id: 'tok', content: 'ranker scoring weights need tuning indexes' }),
        mem({
          id: 'pathy',
          content: 'recompute caches eagerly',
          fileTag: 'core/domain/file-ranker.ts',
        }),
      ]
    )
    expect(out.length).toBe(2)
    expect(out[0]?.memId).toBe('pathy')
  })
})

describe('skill-miss-detector — hashKey', () => {
  it('normalises whitespace + casing and is memId-scoped', () => {
    const a = _internal.hashKey('mem_1', 'Set  PRAGMA   busy_timeout')
    const b = _internal.hashKey('mem_1', 'set pragma busy_timeout')
    const c = _internal.hashKey('mem_2', 'set pragma busy_timeout')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('caps misses per session conservatively', () => {
    expect(_internal.MAX_SKILL_MISSES_PER_SESSION).toBeLessThanOrEqual(5)
  })
})

describe('skill-miss-detector — persistence + containment (DB)', () => {
  const fixture = { dir: '', projectId: '', transcriptPath: '' }

  async function seedDecision(
    content: string,
    opts: { ageMs?: number; provenance?: string } = {}
  ): Promise<void> {
    const ts = new Date(Date.now() - (opts.ageMs ?? 7 * 24 * 60 * 60 * 1000)).toISOString()
    prjctDb.run(
      fixture.projectId,
      "INSERT INTO events (type, data, timestamp) VALUES ('memory.remember.decision', ?, ?)",
      JSON.stringify({
        content,
        tags: { key: `seed-${Math.random().toString(36).slice(2, 8)}` },
        provenance: opts.provenance ?? 'declared',
      }),
      ts
    )
  }

  beforeEach(async () => {
    prjctDb.close()
    fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-skillmiss-test-'))
    await fs.mkdir(path.join(fixture.dir, '.prjct'), { recursive: true })
    fixture.projectId = `skillmiss-${crypto.randomUUID()}`
    await configManager.writeConfig(fixture.dir, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.dir, '.prjct-data'),
    } as Parameters<typeof configManager.writeConfig>[1])
    await pathManager.ensureProjectStructure(fixture.projectId)
    fixture.transcriptPath = path.join(fixture.dir, 'transcript.jsonl')
  })

  afterEach(async () => {
    await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
    prjctDb.close()
  })

  function writeTranscript(text: string): Promise<void> {
    return fs.writeFile(
      fixture.transcriptPath,
      [
        JSON.stringify({ role: 'user', content: 'do the work' }),
        JSON.stringify({ role: 'assistant', content: text }),
      ].join('\n')
    )
  }

  it('persists a skill-miss as a tagged improvement-signal, idempotently', async () => {
    await seedDecision('Set sqlite pragma busy_timeout to 5000 on every connection')
    await writeTranscript('edited the sqlite pragma handling in the storage layer')

    const r1 = await detectSkillMisses(fixture.dir, fixture.transcriptPath, 'sess-1', {
      runtime: 'grok',
      model: 'grok-code-fast',
    })
    expect(r1.signalsRecorded).toBe(1)
    expect(r1.failures[0]).toMatchObject({
      category: 'skill-miss',
      expectedBehavior: expect.stringMatching(/mem_/),
      observedBehavior: 'Relevant project knowledge was not referenced in the session.',
      relatedRuleId: expect.stringMatching(/^mem_/),
    })

    const signals = (await import('../../memory/project-memory')).projectMemory.recall(
      fixture.projectId,
      {
        types: ['improvement-signal'],
        tags: { source: 'skill-miss-detector' },
        dedupeByKey: false,
      }
    )
    expect(signals.length).toBe(1)
    expect(signals[0]?.tags.kind).toBe('skill-miss')
    expect(signals[0]?.tags.category).toBe('skill-miss')
    expect(signals[0]?.tags.relates).toMatch(/^mem_/)
    expect(signals[0]?.tags.runtime).toBe('grok')
    expect(signals[0]?.tags.model).toBe('grok-code-fast')
    expect(signals[0]?.content).toContain('[skill-miss]')

    // Re-run on the same transcript → dedup, no second row.
    const r2 = await detectSkillMisses(fixture.dir, fixture.transcriptPath, 'sess-1')
    expect(r2.signalsRecorded).toBe(0)
    const after = (await import('../../memory/project-memory')).projectMemory.recall(
      fixture.projectId,
      {
        types: ['improvement-signal'],
        tags: { source: 'skill-miss-detector' },
        dedupeByKey: false,
      }
    )
    expect(after.length).toBe(1)
  })

  it('excludes inferred-provenance candidates', async () => {
    await seedDecision('Set sqlite pragma busy_timeout to 5000', { provenance: 'inferred' })
    await writeTranscript('edited the sqlite pragma handling in the storage layer')
    const r = await detectSkillMisses(fixture.dir, fixture.transcriptPath, 's')
    expect(r.signalsRecorded).toBe(0)
  })

  it('excludes memories captured this session (recency containment)', async () => {
    await seedDecision('Set sqlite pragma busy_timeout to 5000', { ageMs: 60 * 1000 })
    await writeTranscript('edited the sqlite pragma handling in the storage layer')
    const r = await detectSkillMisses(fixture.dir, fixture.transcriptPath, 's')
    expect(r.signalsRecorded).toBe(0)
  })

  it('nets a negative usefulness score on the missed entry (feedback loop)', async () => {
    await seedDecision('Set sqlite pragma busy_timeout to 5000 on every connection')
    await writeTranscript('edited the sqlite pragma handling in the storage layer')

    const r = await detectSkillMisses(fixture.dir, fixture.transcriptPath, 'sess-1')
    expect(r.signalsRecorded).toBe(1)

    const signals = (await import('../../memory/project-memory')).projectMemory.recall(
      fixture.projectId,
      {
        types: ['improvement-signal'],
        tags: { source: 'skill-miss-detector' },
        dedupeByKey: false,
      }
    )
    const missedId = signals[0]?.tags.relates as string
    const row = prjctDb.get<{ score: number }>(
      fixture.projectId,
      'SELECT score FROM memory_usefulness WHERE memory_id = ?',
      missedId
    )
    // remember() auto-credits +1.0 for the relates: tag; the penalty must
    // cancel it and net the entry slightly negative — a miss is not usage.
    expect(row).not.toBeNull()
    expect(row?.score ?? 0).toBeLessThan(0)
  })

  it('writes nothing to disk outside SQLite (persistence rule)', async () => {
    await seedDecision('Set sqlite pragma busy_timeout to 5000 on every connection')
    await writeTranscript('edited the sqlite pragma handling in the storage layer')
    const before = (await fs.readdir(fixture.dir)).sort()
    await detectSkillMisses(fixture.dir, fixture.transcriptPath, 's')
    const afterEntries = (await fs.readdir(fixture.dir)).sort()
    // Only the things we created (.prjct, .prjct-data, transcript.jsonl)
    // — the detector must not drop a report/markdown file in the project.
    expect(afterEntries).toEqual(before)
  })
})

describe('skill-miss-detector — crew-isolation guard (analyze)', () => {
  it('a crew-touched file does not trigger path-overlap relevance', () => {
    const candidate = mem({
      id: 'mem_c',
      content: 'rotate refresh credentials hourly',
      fileTag: 'core/auth-service.ts',
    })
    const transcript = 'did some unrelated plumbing work and moved on entirely'
    // Control: no crew files → path-overlap flags it.
    expect(_internal.analyze(transcript, ['core/auth-service.ts'], [candidate]).length).toBe(1)
    // Guarded: the file was crew-touched → no longer relevant.
    expect(
      _internal.analyze(
        transcript,
        ['core/auth-service.ts'],
        [candidate],
        new Set(['core/auth-service.ts'])
      ).length
    ).toBe(0)
  })

  it('token-overlap still flags even when the file is crew-touched', () => {
    const candidate = mem({
      id: 'mem_t',
      content: 'rotate refresh credentials hourly',
      fileTag: 'core/auth-service.ts',
    })
    // Shares ≥2 TOPIC tokens (rotate, refresh, hourly) but not the
    // signature (credentials) → relevant via tokens, still unreferenced.
    const transcript = 'we rotate the refresh logic here but skipped the hourly cadence'
    const out = _internal.analyze(
      transcript,
      ['core/auth-service.ts'],
      [candidate],
      new Set(['core/auth-service.ts'])
    )
    expect(out.length).toBe(1)
    expect(out[0]?.reason).toBe('topic-overlap-unused')
  })

  it('a non-crew changed file is still flagged via path-overlap', () => {
    const candidate = mem({
      id: 'mem_n',
      content: 'rotate refresh credentials hourly',
      fileTag: 'core/billing-engine.ts',
    })
    const transcript = 'did some unrelated plumbing work and moved on entirely'
    const out = _internal.analyze(
      transcript,
      ['core/billing-engine.ts'],
      [candidate],
      new Set(['core/auth-service.ts'])
    )
    expect(out.length).toBe(1)
    expect(out[0]?.reason).toBe('path-overlap-unused')
  })
})

describe('skill-miss-detector — crew-isolation guard (DB + git)', () => {
  const fixture = { dir: '', projectId: '', transcriptPath: '' }

  function seedOldDecision(content: string, fileTag: string): void {
    prjctDb.run(
      fixture.projectId,
      "INSERT INTO events (type, data, timestamp) VALUES ('memory.remember.decision', ?, ?)",
      JSON.stringify({
        content,
        tags: { file: fileTag, key: `s-${Math.random().toString(36).slice(2, 8)}` },
        provenance: 'declared',
      }),
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    )
  }

  beforeEach(async () => {
    prjctDb.close()
    fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-skillmiss-crew-'))
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: fixture.dir })
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: fixture.dir })
    await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: fixture.dir })
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: fixture.dir })
    await fs.mkdir(path.join(fixture.dir, '.prjct'), { recursive: true })
    await fs.mkdir(path.join(fixture.dir, 'core'), { recursive: true })
    await fs.writeFile(path.join(fixture.dir, 'core/auth-service.ts'), 'export const v = 1\n')
    await execFileAsync('git', ['add', '.'], { cwd: fixture.dir })
    await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: fixture.dir })
    // Uncommitted modification → getModifiedFiles() sees core/auth-service.ts.
    await fs.writeFile(path.join(fixture.dir, 'core/auth-service.ts'), 'export const v = 2\n')
    fixture.projectId = `skillmiss-crew-${crypto.randomUUID()}`
    await configManager.writeConfig(fixture.dir, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.dir, '.prjct-data'),
    } as Parameters<typeof configManager.writeConfig>[1])
    await pathManager.ensureProjectStructure(fixture.projectId)
    fixture.transcriptPath = path.join(fixture.dir, 'transcript.jsonl')
    await fs.writeFile(
      fixture.transcriptPath,
      [
        JSON.stringify({ role: 'user', content: 'do the work' }),
        JSON.stringify({
          role: 'assistant',
          content: 'did some unrelated plumbing work and moved on entirely',
        }),
      ].join('\n')
    )
    seedOldDecision('rotate refresh credentials hourly', 'core/auth-service.ts')
  })

  afterEach(async () => {
    await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
    prjctDb.close()
  })

  it('flags a path-overlap miss when NO crew run is present (control)', async () => {
    const r = await detectSkillMisses(fixture.dir, fixture.transcriptPath, 's')
    expect(r.signalsRecorded).toBe(1)
  })

  it('suppresses the miss when a RECENT crew run touched the file', async () => {
    crewRunStorage.record(fixture.projectId, {
      filesTouched: ['core/auth-service.ts'],
      reviewerVerdict: 'APPROVED',
      implementerSummary: 'edited auth-service',
      endedAt: new Date().toISOString(),
    })
    const r = await detectSkillMisses(fixture.dir, fixture.transcriptPath, 's')
    expect(r.signalsRecorded).toBe(0)
  })

  it('does NOT suppress when the crew run is older than the recency window', async () => {
    const old = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString()
    crewRunStorage.record(fixture.projectId, {
      filesTouched: ['core/auth-service.ts'],
      reviewerVerdict: 'APPROVED',
      implementerSummary: 'edited auth-service long ago',
      startedAt: old,
      endedAt: old,
    })
    const r = await detectSkillMisses(fixture.dir, fixture.transcriptPath, 's')
    expect(r.signalsRecorded).toBe(1)
  })
})
