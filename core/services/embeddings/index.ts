/**
 * Semantic-search layer.
 *
 * Design constraints that shaped this:
 *   - ON by default, universally, with ZERO new dependency. The default
 *     provider is a pure-JS local embedder (feature-hashed character n-grams,
 *     see LocalSubwordEmbeddingProvider) — no model download, no native addon,
 *     no API key, no network. So "vectorized to the DB" is true for every user
 *     out of the box, not just those who configured an endpoint.
 *   - AUTO-UPGRADE: when a project configures an OpenAI-compatible endpoint
 *     (OpenAI, Ollama at `http://localhost:11434/v1`, LM Studio, …) that real
 *     model takes over — higher quality, same pipeline. The local embedder is
 *     the floor, not the ceiling.
 *   - NO vector database / native dependency. Vectors are packed Float32
 *     BLOBs in SQLite (`memory_embeddings`) and ranked with in-process cosine.
 *     For a project's hundreds–thousands of entries this is trivially fast and
 *     keeps prjct's zero-native-dep story intact.
 *
 * The provider is injectable so tests run fully offline against a fake.
 */

import { isModelMemory, type MemoryEntry } from '../../memory/entries'
import { projectMemory } from '../../memory/project-memory'
import prjctDb from '../../storage/database'
import type { LocalConfig } from '../../types/config'
import { normalizeModelForBaseUrl, resolveGlobalEmbeddings } from './global'
import { getEmbeddingsKey } from './secure-key'

// Global BYOT config surface — re-exported so callers use one import path.
export {
  clearGlobalEmbeddings,
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_MODEL,
  detectBaseUrlFromKey,
  resolveGlobalEmbeddings,
  setGlobalEmbeddings,
} from './global'
/** Env var holding the bearer token for the embeddings endpoint (if any).
 *  Re-exported from secure-key so existing importers keep working. */
export { EMBEDDINGS_API_KEY_ENV } from './secure-key'

/** Produces one vector per input string, order-preserving. */
export interface EmbeddingProvider {
  readonly model: string
  /**
   * True for providers that compute in-process with no network/cost, so the
   * caller may embed inline (e.g. on every capture) instead of deferring to a
   * batched backfill. Remote/HTTP providers leave this falsy.
   */
  readonly isLocal?: boolean
  embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>
}

/**
 * Resolve a provider from config, or null when embeddings are disabled.
 * Disabled === no provider configured: the single switch the rest of the
 * code branches on.
 */
export function resolveProvider(config: LocalConfig | null | undefined): EmbeddingProvider | null {
  const e = config?.embeddings
  if (!e || !e.provider || !e.model) return null
  if (e.provider === 'openai-compatible') {
    return new HttpEmbeddingProvider(e.baseUrl ?? 'https://api.openai.com/v1', e.model, {
      authHeader: e.authHeader,
      authScheme: e.authScheme,
      extraHeaders: e.headers,
      query: e.query,
    })
  }
  return null
}

/**
 * Auth/transport knobs so the OpenAI-compatible path reaches providers that
 * deviate from the `Authorization: Bearer` default — Azure OpenAI (`api-key`
 * header + `api-version` query), gateways needing extra static headers, etc.
 * All optional; the defaults are exactly the OpenAI/OpenRouter/Ollama shape.
 */
export interface HttpAuthOptions {
  /** Whole request deadline, including response body; default 10 seconds. */
  timeoutMs?: number
  /** Header that carries the API key. Default `authorization`. */
  authHeader?: string
  /** Scheme/prefix before the key, e.g. `Bearer`. Empty string = raw key
   *  (Azure's `api-key: <key>`). Default `Bearer`. */
  authScheme?: string
  /** Extra static headers sent on every request. */
  extraHeaders?: Record<string, string>
  /** Raw query string appended to the URL, e.g. `api-version=2023-05-15`. */
  query?: string
}

/**
 * Build the `/embeddings` request (URL + fetch init) for an OpenAI-compatible
 * endpoint. Pure and exported so the auth/header/query wiring is unit-testable
 * without a network round-trip.
 */
export function buildEmbeddingsRequest(
  baseUrl: string,
  model: string,
  texts: string[],
  key: string | null,
  auth: HttpAuthOptions = {}
): { url: string; init: RequestInit } {
  const root = baseUrl.replace(/\/+$/, '')
  const q = auth.query?.trim().replace(/^\?/, '')
  const url = `${root}/embeddings${q ? `?${q}` : ''}`
  // Wire-level safety net: normalize the model for the base URL (OpenRouter
  // needs `vendor/model`), so even an older/per-project config that stored a
  // bare id reaches OpenRouter correctly. No-op for OpenAI/Ollama/etc.
  const wireModel = normalizeModelForBaseUrl(model, root)

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(auth.extraHeaders ?? {}),
  }
  if (key) {
    const headerName = auth.authHeader?.trim() || 'authorization'
    const scheme = auth.authScheme ?? 'Bearer'
    headers[headerName] = scheme ? `${scheme} ${key}` : key
  }

  return {
    url,
    init: { method: 'POST', headers, body: JSON.stringify({ model: wireModel, input: texts }) },
  }
}

/** OpenAI-compatible `/embeddings` provider over `fetch` (no SDK). */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly baseUrl: string,
    public readonly model: string,
    private readonly auth: HttpAuthOptions = {}
  ) {}

  async embed(texts: string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
    if (texts.length === 0) return []
    const configured = this.auth.timeoutMs ?? 10_000
    if (!Number.isFinite(configured) || configured < 1 || configured > 120_000)
      throw new Error('Embedding deadline must be between 1 and 120000ms')
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const timer = setTimeout(
      () => controller.abort(new Error('Embedding deadline exceeded')),
      configured
    )
    try {
      controller.signal.throwIfAborted()
      const key = await getEmbeddingsKey({ signal: controller.signal })
      controller.signal.throwIfAborted()
      const { url, init } = buildEmbeddingsRequest(this.baseUrl, this.model, texts, key, this.auth)
      const res = await fetch(url, { ...init, signal: controller.signal })
      if (!res.ok) throw new Error(`embeddings endpoint ${res.status}`)
      const json = (await res.json()) as { data?: Array<{ embedding: number[]; index?: number }> }
      controller.signal.throwIfAborted()
      const data = json.data
      if (!Array.isArray(data) || data.length !== texts.length)
        throw new Error('Embedding response count mismatch')
      const ordered = data.every((d) => d.index !== undefined)
        ? [...data].sort((a, b) => a.index! - b.index!)
        : data
      if (ordered.some((d, i) => d.index !== undefined && d.index !== i))
        throw new Error('Embedding response index mismatch')
      const dimension = ordered[0]?.embedding?.length
      if (
        !dimension ||
        ordered.some(
          (d) =>
            !Array.isArray(d.embedding) ||
            d.embedding.length !== dimension ||
            d.embedding.some((n) => !Number.isFinite(n))
        )
      )
        throw new Error('Invalid embedding vectors')
      return ordered.map((d) => d.embedding)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }
}

// Local default provider — zero-dependency subword embedding.

/** Model tag stamped on locally-computed vectors. Bump the suffix to
 *  invalidate every local vector if the algorithm below changes. */
export const LOCAL_EMBEDDING_MODEL = 'local-subword-v1'
const LOCAL_DIM = 256
const MAX_TOKENS = 800 // cap work on pathologically long entries

/** FNV-1a 32-bit — small, fast, well-distributed string hash. Indexes UTF-16
 *  code units via charCodeAt (identical output to the old split('') walk) so
 *  no per-call char arrays are allocated on the embedding hot path. */
function fnv1a(str: string): number {
  const h = Array.from({ length: str.length }, (_, index) => str.charCodeAt(index)).reduce(
    (hash, unit) => Math.imul(hash ^ unit, 0x01000193),
    0x811c9dc5
  )
  return h >>> 0
}

/** Character n-grams of `s` for n in [min,max]; falls back to the whole
 *  string when it is shorter than `min`. */
function charNGrams(s: string, min: number, max: number): string[] {
  const grams: string[] = []
  if (s.length < min) {
    grams.push(s)
    return grams
  }
  for (const n of Array.from({ length: max - min + 1 }, (_, offset) => min + offset)) {
    grams.push(
      ...Array.from({ length: Math.max(0, s.length - n + 1) }, (_, index) =>
        s.slice(index, index + n)
      )
    )
  }
  return grams
}

/**
 * Embed one string into an L2-normalized LOCAL_DIM vector via the hashing
 * trick over boundary-wrapped character n-grams (n=3..5) plus the whole token.
 * Memory content is English by convention (see the skill's CONTENT LANGUAGE
 * rule), which keeps semantics clean; the tokenizer stays Unicode-safe so code
 * identifiers (file paths, function names) and any stray non-English token
 * still contribute. A signed hash spreads collisions across buckets.
 */
function embedLocal(text: string): number[] {
  const acc = new Float64Array(LOCAL_DIM)
  const tokens = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TOKENS)
  for (const tok of tokens) {
    const grams = charNGrams(`<${tok}>`, 3, 5)
    grams.push(tok) // whole-token feature in addition to its n-grams
    for (const g of grams) {
      const h = fnv1a(g)
      const bucket = h % LOCAL_DIM
      const sign = h & 0x10000 ? 1 : -1 // sign bit independent of the bucket bits
      acc[bucket] += sign
    }
  }
  const norm = Math.sqrt(acc.reduce((sum, value) => sum + value * value, 0)) || 1
  return Array.from(acc, (value) => value / norm)
}

/**
 * Sync local embed for deterministic scorers (retention Rho excess).
 * Same algorithm as LocalSubwordEmbeddingProvider — pure, 0 network, 0 tokens.
 */
export function embedLocalText(text: string): number[] {
  return embedLocal(text)
}

/**
 * The always-available default provider. Pure-JS, deterministic, no network.
 * Captures morphological / substring similarity (auth≈authentication,
 * sqlite≈SQLite) that exact-token BM25 misses, and yields a continuous score
 * for ranking + the vector substrate the bidirectional-vault pipeline needs.
 * NOT deep synonymy — that is what the HTTP auto-upgrade buys.
 */
export class LocalSubwordEmbeddingProvider implements EmbeddingProvider {
  readonly model = LOCAL_EMBEDDING_MODEL
  readonly isLocal = true
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => embedLocal(t))
  }
}

/**
 * The provider actually used at runtime, in precedence order:
 *   1. a per-project endpoint (`config.embeddings`) — explicit override;
 *   2. the GLOBAL BYOT endpoint (`prjct embeddings set`) — one key, all
 *      projects, the real-model upgrade;
 *   3. the in-process local subword embedder — the always-available default.
 * Unlike `resolveProvider` this NEVER returns null — semantic search is on for
 * everyone.
 */
export function resolveActiveProvider(config: LocalConfig | null | undefined): EmbeddingProvider {
  const explicit = resolveProvider(config)
  if (explicit) return explicit
  const global = resolveGlobalEmbeddings()
  if (global)
    return new HttpEmbeddingProvider(global.baseUrl, global.model, {
      authHeader: global.authHeader,
      authScheme: global.authScheme,
      extraHeaders: global.extraHeaders,
      query: global.query,
    })
  return new LocalSubwordEmbeddingProvider()
}

// Vector <-> BLOB packing (Float32 little-endian).

function packVector(v: number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer)
}

function unpackVector(blob: Uint8Array): Float32Array {
  // Copy into a fresh, 4-byte-aligned buffer — a SQLite BLOB may arrive at a
  // non-aligned byteOffset, which Float32Array's view constructor rejects.
  const copy = Uint8Array.from(blob)
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4))
}

/** Any vector shape the scorers pass around: plain arrays from providers,
 *  packed Float32 columns from SQLite, Float64 reference vectors. */
export type NumericVector = readonly number[] | Float32Array | Float64Array

/**
 * Structural view that lets one reduce() implementation serve plain arrays
 * and typed arrays alike — TS cannot call .reduce on the union directly
 * (incompatible synthetic signatures), and a `for (const i of …)` index walk
 * would need a mutable counter (const-only rule) plus an index-array alloc.
 */
type ReducibleVector = {
  readonly length: number
  reduce(cb: (total: number, value: number, index: number) => number, initial: number): number
}

export function cosineSimilarity(a: NumericVector, b: NumericVector): number {
  // Single-sourced over dot/l2Norm so a numeric fix (e.g. clamping) can
  // never diverge between this and the norm-cached semanticSearch path.
  const denom = l2Norm(a) * l2Norm(b)
  return denom === 0 ? 0 : dot(a, b) / denom
}

interface EmbeddingRow {
  memory_id: string
  vector: Uint8Array
  norm: number | null
}

function l2Norm(v: NumericVector): number {
  // Native reduce over the vector itself: no intermediate Array.from alloc.
  return Math.sqrt((v as ReducibleVector).reduce((total, value) => total + value * value, 0))
}

/**
 * Dot product over the shared prefix (parity with the old min-length walk).
 * Exported for callers holding L2-normalized vectors (retention reference
 * index) where dot == cosine and the norms can be skipped entirely.
 */
export function dot(a: NumericVector, b: NumericVector): number {
  const n = Math.min(a.length, b.length)
  return (a as ReducibleVector).reduce(
    (total, value, index) => (index < n ? total + value * b[index]! : total),
    0
  )
}

/**
 * Safety bound on how many stored vectors a single semantic query will
 * deserialize and score (newest-first). A no-op for typical projects
 * (hundreds of entries); caps BLOB unpacking for pathological ones.
 */
const SEMANTIC_SCAN_MAX_ROWS = 2000

/** Noise-vector pruning runs on every Nth backfill (see shouldPruneThisRun). */
const PRUNE_EVERY = 10
/** Per-process backfill tick per project — see shouldPruneThisRun. */
const pruneTicks = new Map<string, number>()

export const embeddingService = {
  /**
   * Always true now: the local default provider makes semantic search
   * available to every project. Kept as a method so callers read intent
   * ("is semantic available?") and so a future kill-switch has one home.
   */
  isEnabled(_config: LocalConfig | null | undefined): boolean {
    return true
  },

  /** Store one entry's vector (upsert). */
  store(
    projectId: string,
    memoryId: string,
    vector: number[],
    model: string,
    nowIso: string
  ): void {
    prjctDb.run(
      projectId,
      `INSERT INTO memory_embeddings (memory_id, vector, model, dims, norm, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET
         vector = excluded.vector, model = excluded.model,
         dims = excluded.dims, norm = excluded.norm, created_at = excluded.created_at`,
      memoryId,
      packVector(vector),
      model,
      vector.length,
      l2Norm(vector),
      nowIso
    )
  },

  /** Ids that already have an up-to-date vector for `model`. */
  embeddedIds(projectId: string, model: string): Set<string> {
    try {
      const rows = prjctDb.query<{ memory_id: string }>(
        projectId,
        'SELECT memory_id FROM memory_embeddings WHERE model = ?',
        model
      )
      return new Set(rows.map((r) => r.memory_id))
    } catch {
      return new Set()
    }
  },

  /**
   * Embed every memory entry that lacks a current-model vector, in batches.
   * Returns counts. Best-effort: a failed batch is skipped, not fatal.
   * `nowIso` is passed in (scripts can't call Date.now() deterministically).
   */
  async backfill(
    projectId: string,
    config: LocalConfig,
    nowIso: string,
    opts: { provider?: EmbeddingProvider; batchSize?: number } = {}
  ): Promise<{ embedded: number; skipped: number; total: number }> {
    const provider = opts.provider ?? resolveActiveProvider(config)
    const batchSize = opts.batchSize ?? 64

    // Work list via SQL anti-join: only entries that still lack a vector are
    // fetched + deserialized. The old path loaded the WHOLE corpus on every
    // Stop hook just to set-diff against embeddedIds in JS.
    // Selectivity: model memory only + retention active (never archive/delete
    // candidates; never signals/telemetry). Retention scores are best-effort.
    const retentionById = await (async (): Promise<Map<string, { verdict: string }> | null> => {
      try {
        const { evaluateRetention } = await import('../retention')
        return evaluateRetention(projectId, Date.now()).byId
      } catch {
        return null
      }
    })()

    const todo = projectMemory.unembeddedEntriesForIndex(projectId, provider.model).filter((e) => {
      if (!isModelMemory(e) || e.content.trim().length === 0) return false
      const r = retentionById?.get(e.id)
      if (r && r.verdict !== 'active') return false
      return true
    })

    // Selectivity (RAG north star): embed only entries that MODEL the
    // project/developer, never bulk-vectorize telemetry noise. Pruning noise
    // + archive/delete vectors is throttled to every Nth backfill.
    if (this.shouldPruneThisRun(projectId)) {
      const all = projectMemory.allEntriesForIndex(projectId)
      const drop = all
        .filter((e) => {
          if (!isModelMemory(e)) return true
          const r = retentionById?.get(e.id)
          return r != null && r.verdict !== 'active'
        })
        .map((e) => e.id)
      this.pruneNonModelVectors(projectId, drop)
    }

    // "skipped" = entries already vectorized by prior runs (counted before
    // this run's stores land, mirroring the old set-diff semantics).
    const alreadyEmbedded = this.countByModel(projectId, provider.model)

    const batches = Array.from({ length: Math.ceil(todo.length / batchSize) }, (_, index) =>
      todo.slice(index * batchSize, (index + 1) * batchSize)
    )
    const embeddedByBatch: number[] = []
    for (const batch of batches) {
      try {
        const vectors = await provider.embed(batch.map((e) => e.content))
        const embedded = batch.reduce((count, entry, index) => {
          const vector = vectors[index]
          if (!vector || vector.length === 0) return count
          this.store(projectId, entry.id, vector, provider.model, nowIso)
          return count + 1
        }, 0)
        embeddedByBatch.push(embedded)
      } catch {
        // Skip this batch; the next backfill retries it.
      }
    }
    const embedded = embeddedByBatch.reduce((total, count) => total + count, 0)
    return { embedded, skipped: alreadyEmbedded, total: alreadyEmbedded + todo.length }
  },

  /** Vectors already stored for `model` — the previous runs' work. */
  countByModel(projectId: string, model: string): number {
    try {
      const row = prjctDb.get<{ n: number }>(
        projectId,
        'SELECT COUNT(*) AS n FROM memory_embeddings WHERE model = ?',
        model
      )
      return row?.n ?? 0
    } catch {
      return 0
    }
  },

  /** Prune throttle: every PRUNE_EVERY-th backfill, starting with the first.
   *  In-process counter (review follow-up: the kv version paid a read+write
   *  per Stop just to decide "skip" 9/10 times). Per-process semantics are
   *  the SAFE direction: a long-lived daemon throttles correctly, and
   *  short-lived cold runs prune on their first backfill — pruning more
   *  often is harmless, skipping it forever would not be. */
  shouldPruneThisRun(projectId: string): boolean {
    const tick = pruneTicks.get(projectId) ?? 0
    pruneTicks.set(projectId, (tick + 1) % PRUNE_EVERY)
    return tick === 0
  },

  /** Delete stored vectors for entries that are no longer model-worthy
   *  (e.g. noise embedded by an older indiscriminate backfill). Best-effort. */
  pruneNonModelVectors(projectId: string, noiseIds: string[]): void {
    if (noiseIds.length === 0) return
    try {
      const placeholders = noiseIds.map(() => '?').join(',')
      prjctDb.run(
        projectId,
        `DELETE FROM memory_embeddings WHERE memory_id IN (${placeholders})`,
        ...noiseIds
      )
    } catch {
      /* best-effort — a stale noise vector is harmless until the next run */
    }
  },

  /**
   * Rank stored memory vectors by cosine similarity to `query`. Returns
   * resolved MemoryEntry rows, best-first. Empty when disabled, on provider
   * error, or when nothing has been embedded yet (caller falls back to BM25).
   */
  async semanticSearch(
    projectId: string,
    query: string,
    config: LocalConfig,
    limit = 10,
    provider?: EmbeddingProvider,
    accept?: (entry: MemoryEntry) => boolean
  ): Promise<MemoryEntry[]> {
    const p = provider ?? resolveActiveProvider(config)
    if (!query.trim() || !Number.isFinite(limit) || limit < 1) return []
    const resultLimit = Math.min(Math.floor(limit), SEMANTIC_SCAN_MAX_ROWS)

    const rows = (() => {
      try {
        return prjctDb.query<EmbeddingRow>(
          projectId,
          `SELECT memory_id, vector, norm FROM memory_embeddings
            WHERE model = ? ORDER BY rowid DESC LIMIT ?`,
          p.model,
          SEMANTIC_SCAN_MAX_ROWS
        )
      } catch {
        return null
      }
    })()
    if (!rows?.length) return []
    const qv = await (async (): Promise<number[] | undefined> => {
      try {
        return (await p.embed([query]))[0]
      } catch {
        return undefined
      }
    })()
    if (!qv || qv.length === 0) return []

    // Stored norms (migration 28) turn per-row cosine into a dot product +
    // one multiply; rows lacking a norm (edge: written mid-migration) fall
    // back to recomputing it from the unpacked vector.
    const qNorm = l2Norm(qv)
    if (qNorm === 0) return []
    const ranked = rows
      .map((r) => {
        const v = unpackVector(r.vector)
        const denom = qNorm * (r.norm ?? l2Norm(v))
        return { id: r.memory_id, score: denom === 0 ? 0 : dot(qv, v) / denom }
      })
      .sort((a, b) => b.score - a.score)

    // Resolve bounded batches in rank order until eligible results fill the budget.
    const hits: MemoryEntry[] = []
    const batchSize = Math.max(10, resultLimit)
    const cursor = { offset: 0 }
    while (cursor.offset < ranked.length && hits.length < resultLimit) {
      const entries = projectMemory.getByIds(
        projectId,
        ranked.slice(cursor.offset, cursor.offset + batchSize).map((r) => r.id)
      )
      hits.push(...entries.filter(accept ?? (() => true)))
      cursor.offset += batchSize
    }
    return hits.slice(0, resultLimit)
  },
}
