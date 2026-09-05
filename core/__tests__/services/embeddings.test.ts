/**
 * Semantic-search layer — offline tests.
 *
 * Pins: provider resolution (explicit endpoint vs the always-on local
 * default), the local subword embedder (determinism, normalization,
 * morphological ranking, end-to-end), cosine math, cosine-ranked
 * semanticSearch, and backfill idempotency. No network: the HTTP path uses an
 * injected fake; the local path is pure-JS.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isModelMemory } from '../../memory/entries'
import { projectMemory } from '../../memory/project-memory'
import {
  cosineSimilarity,
  dot,
  type EmbeddingProvider,
  embeddingService,
  embedLocalText,
  LOCAL_EMBEDDING_MODEL,
  LocalSubwordEmbeddingProvider,
  resolveActiveProvider,
  resolveProvider,
} from '../../services/embeddings'
import prjctDb from '../../storage/database'
import type { LocalConfig } from '../../types/config'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: {
  tmpRoot: string
  projectId: string
  origCliHome: string | undefined
} = {
  tmpRoot: '',
  projectId: '',
  origCliHome: undefined as unknown as string | undefined,
}

const NOW = '2026-05-30T00:00:00.000Z'

/** Deterministic, offline provider: maps known text → known vector. */
class FakeProvider implements EmbeddingProvider {
  readonly model = 'fake-1'
  constructor(private readonly map: Record<string, number[]>) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.map[t] ?? [0, 0, 0, 1])
  }
}

const enabledConfig: LocalConfig = {
  projectId: 'x',
  dataPath: '',
  embeddings: { provider: 'openai-compatible', model: 'fake-1', baseUrl: 'http://x/v1' },
} as LocalConfig

function write(type: string, content: string, tags: Record<string, string> = {}): string {
  prjctDb.appendEvent(fixture.projectId, `memory.remember.${type}`, {
    content,
    tags,
    provenance: 'declared',
  })
  const latest = projectMemory.recall(fixture.projectId, { limit: 1, dedupeByKey: false })
  return latest[0]?.id ?? ''
}

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-embed-'))
  fixture.projectId = `test-embed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // Isolate the GLOBAL embeddings config: without this, resolveActiveProvider
  // reads the developer's real ~/.prjct-cli/config/global.json, so the
  // "falls back to the local default" cases fail on any BYOT-configured machine.
  fixture.origCliHome = process.env.PRJCT_CLI_HOME
  process.env.PRJCT_CLI_HOME = fixture.tmpRoot
  patchPathManager(fixture.tmpRoot)
})

afterEach(async () => {
  if (fixture.origCliHome === undefined) delete process.env.PRJCT_CLI_HOME
  else process.env.PRJCT_CLI_HOME = fixture.origCliHome
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe('embeddings — provider resolution', () => {
  it('resolveProvider (explicit only) is null without config / provider / model', () => {
    expect(resolveProvider(null)).toBeNull()
    expect(resolveProvider({ projectId: 'x', dataPath: '' } as LocalConfig)).toBeNull()
    expect(
      resolveProvider({ embeddings: { provider: 'openai-compatible' } } as LocalConfig)
    ).toBeNull()
  })

  it('resolveActiveProvider falls back to the local default (never null)', () => {
    expect(resolveActiveProvider(null)).toBeInstanceOf(LocalSubwordEmbeddingProvider)
    expect(resolveActiveProvider(null).model).toBe(LOCAL_EMBEDDING_MODEL)
    // An explicit endpoint upgrades over the local default.
    expect(resolveActiveProvider(enabledConfig).model).toBe('fake-1')
  })

  it('isEnabled is always true (semantic on for everyone)', () => {
    expect(embeddingService.isEnabled(null)).toBe(true)
    expect(embeddingService.isEnabled(enabledConfig)).toBe(true)
  })

  it('semanticSearch returns [] when nothing is embedded yet (lexical fallback)', async () => {
    const out = await embeddingService.semanticSearch(fixture.projectId, 'anything', {
      projectId: 'x',
      dataPath: '',
    } as LocalConfig)
    expect(out).toHaveLength(0)
  })
})

describe('isModelMemory — selectivity predicate', () => {
  it('excludes raw friction signals and hot-file churn, keeps real knowledge', () => {
    expect(isModelMemory({ type: 'decision', tags: {} })).toBe(true)
    expect(isModelMemory({ type: 'gotcha', tags: {} })).toBe(true)
    expect(isModelMemory({ type: 'feedback', tags: {} })).toBe(true)
    expect(isModelMemory({ type: 'improvement-signal', tags: {} })).toBe(false)
    expect(isModelMemory({ type: 'learning', tags: { pattern: 'hot-file' } })).toBe(false)
    // a recurring-bug pattern learning is signal, not noise
    expect(isModelMemory({ type: 'learning', tags: { pattern: 'recurring-bug' } })).toBe(true)
  })
})

describe('embeddings — backfill is selective (model memory only)', () => {
  it('embeds only model memories and prunes noise vectors', async () => {
    const decision = write('decision', 'we chose sqlite for local-first storage')
    write('improvement-signal', '[negation] pushback', { source: 'friction-detector' })
    write('learning', 'bin/prjct.ts — 5 touches in 7 days', { pattern: 'hot-file' })

    const r = await embeddingService.backfill(
      fixture.projectId,
      { projectId: fixture.projectId, dataPath: '' } as LocalConfig,
      NOW
    )
    // total/embedded count only the model-worthy entry (the decision).
    expect(r.total).toBe(1)
    expect(r.embedded).toBe(1)

    const rows = prjctDb.query<{ memory_id: string }>(
      fixture.projectId,
      'SELECT memory_id FROM memory_embeddings'
    )
    expect(rows.map((row) => row.memory_id)).toEqual([decision])
  })
})

describe('LocalSubwordEmbeddingProvider', () => {
  const local = new LocalSubwordEmbeddingProvider()

  it('produces a deterministic, L2-normalized 256-dim vector', async () => {
    const [a] = await local.embed(['authentication flow'])
    const [b] = await local.embed(['authentication flow'])
    expect(a).toHaveLength(256)
    expect(a).toEqual(b!) // deterministic
    const norm = Math.sqrt(a!.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 5)
  })

  it('scores morphologically-related text above unrelated text', async () => {
    const [q] = await local.embed(['authentication'])
    const [near] = await local.embed(['authenticate the user'])
    const [far] = await local.embed(['banana pricing spreadsheet'])
    expect(cosineSimilarity(q!, near!)).toBeGreaterThan(cosineSimilarity(q!, far!))
  })

  it('end-to-end: backfill + semanticSearch with the local default ranks the related entry first', async () => {
    const target = write('decision', 'migrate the sqlite database schema with a new migration')
    write('decision', 'style the react frontend button component')

    // No provider passed → uses the local default via resolveActiveProvider.
    const r = await embeddingService.backfill(
      fixture.projectId,
      { projectId: fixture.projectId, dataPath: '' } as LocalConfig,
      NOW
    )
    expect(r.embedded).toBe(2)

    const hits = await embeddingService.semanticSearch(
      fixture.projectId,
      'database migrations',
      { projectId: fixture.projectId, dataPath: '' } as LocalConfig,
      5
    )
    expect(hits[0]?.id).toBe(target)
  })
})

describe('embeddings — stored norms (migration 28)', () => {
  it('store() persists the vector L2 norm', () => {
    embeddingService.store(fixture.projectId, 'mem_n1', [3, 4], 'fake-1', NOW)
    const row = prjctDb.get<{ norm: number }>(
      fixture.projectId,
      'SELECT norm FROM memory_embeddings WHERE memory_id = ?',
      'mem_n1'
    )
    expect(row?.norm).toBeCloseTo(5)
  })

  it('semanticSearch ranks correctly using stored norms', async () => {
    const provider = new FakeProvider({
      'auth bug': [1, 0, 0, 0],
      'auth race condition in login': [0.9, 0.1, 0, 0],
      'how to cook pasta': [0, 0, 0.9, 0.1],
    })
    const near = write('gotcha', 'auth race condition in login')
    const far = write('gotcha', 'how to cook pasta')
    await embeddingService.backfill(fixture.projectId, enabledConfig, NOW, { provider })

    const hits = await embeddingService.semanticSearch(
      fixture.projectId,
      'auth bug',
      enabledConfig,
      2,
      provider
    )
    expect(hits[0]?.id).toBe(near)
    expect(hits[1]?.id).toBe(far)
  })

  it('semanticSearch survives a NULL norm (falls back to recompute)', async () => {
    const provider = new FakeProvider({
      'auth bug': [1, 0, 0, 0],
      'auth race condition in login': [0.9, 0.1, 0, 0],
    })
    const id = write('gotcha', 'auth race condition in login')
    await embeddingService.backfill(fixture.projectId, enabledConfig, NOW, { provider })
    prjctDb.run(
      fixture.projectId,
      'UPDATE memory_embeddings SET norm = NULL WHERE memory_id = ?',
      id
    )

    const hits = await embeddingService.semanticSearch(
      fixture.projectId,
      'auth bug',
      enabledConfig,
      1,
      provider
    )
    expect(hits[0]?.id).toBe(id)
  })
})

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5)
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5)
  })
  it('is 0 against a zero vector (no NaN)', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0)
  })
})

describe('dot', () => {
  it('sums the shared-prefix products across array and typed-array shapes', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32)
    expect(dot(Float64Array.from([1, 2]), Float32Array.from([3, 4]))).toBe(11)
    // min-length parity with the old walk: the extra tail is ignored
    expect(dot([1, 1, 1, 99], [1, 1])).toBe(2)
  })
  it('equals cosine for embedLocalText vectors (they are L2-normalized)', () => {
    const a = embedLocalText('retention reference model over project memory')
    const b = embedLocalText('retention reference model over project memory!')
    expect(dot(a, Float64Array.from(b))).toBeCloseTo(cosineSimilarity(a, b), 10)
    expect(dot(a, Float64Array.from(a))).toBeCloseTo(1, 10)
  })
})

describe('embeddings — backfill + semanticSearch', () => {
  it('does not embed a query when its model has no indexed candidates', async () => {
    embeddingService.store(fixture.projectId, 'mem_other', [1, 0], 'other-model', NOW)
    const calls: string[][] = []
    const hits = await embeddingService.semanticSearch(
      fixture.projectId,
      'query',
      enabledConfig,
      10,
      {
        model: 'empty-model',
        embed: async (texts) => {
          calls.push(texts)
          return [[1, 0]]
        },
      }
    )
    expect(hits).toEqual([])
    expect(calls).toEqual([])
  })

  it('fills the result budget with eligible entries beyond the first ranked batch', async () => {
    for (const index of Array.from({ length: 12 }, (_, n) => n)) {
      const id = write('gotcha', `noise ${index}`)
      embeddingService.store(fixture.projectId, id, [1, 0], 'fake-1', NOW)
    }
    const target = write('decision', 'eligible')
    embeddingService.store(fixture.projectId, target, [0.8, 0.2], 'fake-1', NOW)
    const hits = await embeddingService.semanticSearch(
      fixture.projectId,
      'query',
      enabledConfig,
      1,
      new FakeProvider({ query: [1, 0] }),
      (entry) => entry.type === 'decision'
    )
    expect(hits.map((entry) => entry.id)).toEqual([target])
  })

  it('ranks the nearest entry first and round-trips the stored vector', async () => {
    const a = write('decision', 'alpha')
    write('decision', 'beta')
    const provider = new FakeProvider({
      alpha: [1, 0, 0],
      beta: [0, 1, 0],
      'find the first one': [0.95, 0.05, 0],
    })

    const r = await embeddingService.backfill(fixture.projectId, enabledConfig, NOW, { provider })
    expect(r.embedded).toBe(2)

    const hits = await embeddingService.semanticSearch(
      fixture.projectId,
      'find the first one',
      enabledConfig,
      5,
      provider
    )
    expect(hits[0]?.id).toBe(a)
  })

  it('backfill is idempotent — a second run embeds nothing new', async () => {
    write('fact', 'one')
    write('fact', 'two')
    const provider = new FakeProvider({ one: [1, 0], two: [0, 1] })
    const first = await embeddingService.backfill(fixture.projectId, enabledConfig, NOW, {
      provider,
    })
    expect(first.embedded).toBe(2)
    const second = await embeddingService.backfill(fixture.projectId, enabledConfig, NOW, {
      provider,
    })
    expect(second.embedded).toBe(0)
  })
})
