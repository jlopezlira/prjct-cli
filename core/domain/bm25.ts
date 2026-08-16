/**
 * BM25 Text Search Index
 *
 * Implements the Okapi BM25 ranking algorithm for file relevance scoring.
 * Indexes files by extracting tokens from:
 * - Function names, class names, export names
 * - Import paths
 * - Comments and JSDoc
 * - File path segments
 *
 * Zero API calls — pure math on filesystem data.
 *
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { BM25_B, BM25_K1 } from '../constants/algorithms'
import prjctDb from '../storage/database'
import type { SqliteStatement } from '../storage/database/sqlite-compat'
import type { BM25Index, BM25Score } from '../types/domain.js'
import { scoresToSortedArray } from '../utils/collection-filters'
import { batchProcess, walkDir } from '../utils/file-helper'

/** Common stop words to exclude from BM25 indexing */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'of',
  'in',
  'to',
  'for',
  'with',
  'on',
  'at',
  'from',
  'by',
  'as',
  'or',
  'and',
  'but',
  'if',
  'not',
  'no',
  'so',
  'up',
  'out',
  'this',
  'that',
  'it',
  'its',
  'all',
  'any',
  // Code noise
  'import',
  'export',
  'default',
  'const',
  'let',
  'var',
  'function',
  'class',
  'interface',
  'type',
  'return',
  'new',
  'true',
  'false',
  'null',
  'undefined',
  'void',
  'async',
  'await',
  'static',
  'public',
  'private',
  'protected',
  'readonly',
  'string',
  'number',
  'boolean',
  'object',
  'array',
])

// Tokenization

/**
 * Split camelCase/PascalCase identifiers into words.
 * e.g., "getUserById" → ["get", "user", "by", "id"]
 */
function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_./]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1)
}

/**
 * Extract tokens from a file's content and path.
 *
 * Extracts:
 * - Path segments (e.g., "core/domain/bm25.ts" → ["core", "domain", "bm25"])
 * - Function/class/interface/type names (split camelCase)
 * - Import sources (split on / and -)
 * - Single-line and multi-line comments
 * - JSDoc content
 */
export function tokenizeFile(content: string, filePath: string): string[] {
  const tokens: string[] = []

  // 1. Path segments (weighted: appear in every query match)
  const pathParts = filePath
    .replace(/\.[^.]+$/, '') // remove extension
    .split(/[/\\]/)
    .filter(Boolean)
  for (const part of pathParts) {
    tokens.push(...splitIdentifier(part))
  }

  // 2. Export names: export function/class/interface/type/const
  const exportPatterns = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+interface\s+(\w+)/g,
    /export\s+type\s+(\w+)/g,
    /export\s+(?:const|let|var)\s+(\w+)/g,
    /export\s+default\s+(?:class|function)\s+(\w+)/g,
  ]

  for (const pattern of exportPatterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) {
        tokens.push(...splitIdentifier(match[1]))
      }
    }
  }

  // 3. Non-exported function/class/interface names
  const declPatterns = [
    /(?:async\s+)?function\s+(\w+)/g,
    /class\s+(\w+)/g,
    /interface\s+(\w+)/g,
    /type\s+(\w+)\s*=/g,
  ]

  for (const pattern2 of declPatterns) {
    for (const match2 of content.matchAll(pattern2)) {
      if (match2[1]) {
        tokens.push(...splitIdentifier(match2[1]))
      }
    }
  }

  // 4. Import sources
  const importPattern = /(?:from|import)\s+['"]([^'"]+)['"]/g
  for (const importMatch of content.matchAll(importPattern)) {
    const source = importMatch[1]
    if (source.startsWith('.') || source.startsWith('@/')) {
      // Internal import — extract path tokens
      tokens.push(...splitIdentifier(source))
    } else {
      // External package — use package name
      const pkgName = source.startsWith('@')
        ? source.split('/').slice(0, 2).join('/')
        : source.split('/')[0]
      tokens.push(...splitIdentifier(pkgName))
    }
  }

  // 5. Comments (single-line)
  const singleLineComments = /\/\/\s*(.+)/g
  for (const commentMatch of content.matchAll(singleLineComments)) {
    const words = commentMatch[1]
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2)
    tokens.push(...words)
  }

  // 6. JSDoc / multi-line comments — extract meaningful words
  const multiLineComments = /\/\*\*?([\s\S]*?)\*\//g
  for (const multiMatch of content.matchAll(multiLineComments)) {
    const words = multiMatch[1]
      .replace(/@\w+/g, '') // strip JSDoc tags
      .replace(/\*/g, '')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && /^[a-z]+$/.test(w))
    tokens.push(...words)
  }

  // Filter: remove stop words, short tokens, non-alpha
  return tokens.filter((t) => t.length > 1 && !STOP_WORDS.has(t) && /^[a-z][a-z0-9]*$/.test(t))
}

/**
 * Tokenize a query string (task description).
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .split(/\s+/)
    .flatMap((word) => splitIdentifier(word))
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t) && /^[a-z][a-z0-9]*$/.test(t))
}

// Index Building

/**
 * Build a BM25 index for all files in a project.
 *
 * Performance target: <5 seconds for 500-file project.
 */
/**
 * Null-prototype map for the inverted index. The index is keyed by raw source
 * TOKENS, and tokens like `constructor`, `toString`, `hasOwnProperty`, or
 * `__proto__` collide with `Object.prototype` on a plain `{}`: `!index[token]`
 * reads the inherited method as truthy, the `= []` init is skipped, and the
 * subsequent `.push` throws — aborting the WHOLE BM25 build. sync swallows it
 * as "non-critical", so the file index silently never builds and the anti-
 * grep-walk file cues go dark. A prototype-less object can't collide.
 */
function emptyInvertedIndex(): BM25Index['invertedIndex'] {
  return Object.create(null) as BM25Index['invertedIndex']
}

export async function buildIndex(projectPath: string): Promise<BM25Index> {
  const files = await walkDir(projectPath)

  const documents: BM25Index['documents'] = {}
  const invertedIndex: BM25Index['invertedIndex'] = emptyInvertedIndex()

  // Process files in parallel batches of 50
  const results = await batchProcess(files, 50, async (filePath) => {
    try {
      const content = await fs.readFile(path.join(projectPath, filePath), 'utf-8')
      const tokens = tokenizeFile(content, filePath)
      return tokens.length > 0 ? { filePath, tokens } : null
    } catch {
      return null
    }
  })

  for (const { filePath, tokens } of results) {
    documents[filePath] = { tokens, length: tokens.length }

    for (const [token, tf] of termFrequencies(tokens)) {
      if (!invertedIndex[token]) {
        invertedIndex[token] = []
      }
      invertedIndex[token].push({ path: filePath, tf })
    }
  }
  const totalLength = results.reduce((total, result) => total + result.tokens.length, 0)

  const totalDocs = Object.keys(documents).length

  return {
    documents,
    invertedIndex,
    avgDocLength: totalDocs > 0 ? totalLength / totalDocs : 0,
    totalDocs,
    builtAt: new Date().toISOString(),
  }
}

// BM25 Scoring

/**
 * Calculate IDF (Inverse Document Frequency) for a term.
 */
function idf(docFrequency: number, totalDocs: number): number {
  return Math.log((totalDocs - docFrequency + 0.5) / (docFrequency + 0.5) + 1)
}

/**
 * Score all documents against a query using BM25.
 *
 * Performance target: <50ms per query.
 *
 * @returns Sorted array of (path, score) tuples, highest score first.
 */
export function score(query: string, index: BM25Index): BM25Score[] {
  const queryTokens = tokenizeQuery(query)
  if (queryTokens.length === 0) return []

  const scores = new Map<string, number>()

  for (const token of queryTokens) {
    const postings = index.invertedIndex[token]
    if (!postings) continue

    const tokenIdf = idf(postings.length, index.totalDocs)

    for (const { path: docPath, tf } of postings) {
      const doc = index.documents[docPath]
      if (!doc) continue

      // BM25 term score
      const numerator = tf * (BM25_K1 + 1)
      const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / index.avgDocLength))
      const termScore = tokenIdf * (numerator / denominator)

      scores.set(docPath, (scores.get(docPath) || 0) + termScore)
    }
  }

  // Sort by score descending
  return scoresToSortedArray(scores)
}

// SQLite Persistence

const INDEX_KEY = 'bm25-index'

function termFrequencies(tokens: string[]): Map<string, number> {
  const tfMap = new Map<string, number>()
  for (const token of tokens) {
    tfMap.set(token, (tfMap.get(token) || 0) + 1)
  }
  return tfMap
}

function removeDocument(index: BM25Index, filePath: string): void {
  const doc = index.documents[filePath]
  if (!doc) return
  delete index.documents[filePath]

  const tokens = new Set(doc.tokens)
  const tokensToClean = tokens.size > 0 ? tokens : new Set(Object.keys(index.invertedIndex))
  for (const token of tokensToClean) {
    const postings = index.invertedIndex[token]
    if (!postings) continue
    const next = postings.filter((p) => p.path !== filePath)
    if (next.length === 0) delete index.invertedIndex[token]
    else index.invertedIndex[token] = next
  }
}

function addDocument(index: BM25Index, filePath: string, tokens: string[]): void {
  if (tokens.length === 0) return
  index.documents[filePath] = { tokens, length: tokens.length }
  for (const [token, tf] of termFrequencies(tokens)) {
    if (!index.invertedIndex[token]) index.invertedIndex[token] = []
    index.invertedIndex[token].push({ path: filePath, tf })
  }
}

function recalculateStats(index: BM25Index): void {
  const lengths = Object.values(index.documents).map((doc) => doc.length)
  const totalLength = lengths.reduce((sum, n) => sum + n, 0)
  index.totalDocs = lengths.length
  index.avgDocLength = lengths.length > 0 ? totalLength / lengths.length : 0
  index.builtAt = new Date().toISOString()
}

// See `import-graph.loadGraph` for the rationale; same mtime cache.
const indexCache = new Map<string, { index: BM25Index; updatedAt: string }>()

interface StoredBm25Index {
  schemaVersion?: number
  invertedIndex?: BM25Index['invertedIndex']
  avgDocLength: number
  totalDocs: number
  builtAt: string
  docLengths: Record<string, number>
}

function indexMetadata(index: BM25Index): StoredBm25Index {
  return {
    schemaVersion: 2,
    avgDocLength: index.avgDocLength,
    totalDocs: index.totalDocs,
    builtAt: index.builtAt,
    docLengths: Object.fromEntries(Object.entries(index.documents).map(([p, d]) => [p, d.length])),
  }
}

function writeDocumentRows(
  insertDoc: SqliteStatement,
  insertTerm: SqliteStatement,
  filePath: string,
  tokens: string[],
  updatedAt: string
): void {
  if (tokens.length === 0) return
  insertDoc.run(filePath, JSON.stringify(tokens), tokens.length, updatedAt)
  for (const [token, tf] of termFrequencies(tokens)) {
    insertTerm.run(token, filePath, tf)
  }
}

/**
 * Persist a full BM25 index to SQLite. Internal — invoked from `indexProject`.
 */
function replacePerFileTables(projectId: string, index: BM25Index): void {
  try {
    prjctDb.transaction(projectId, (db) => {
      db.prepare('DELETE FROM bm25_terms').run()
      db.prepare('DELETE FROM bm25_documents').run()
      const now = new Date().toISOString()
      const insertDoc = db.prepare(
        'INSERT INTO bm25_documents (path, tokens, length, updated_at) VALUES (?, ?, ?, ?)'
      )
      const insertTerm = db.prepare('INSERT INTO bm25_terms (token, path, tf) VALUES (?, ?, ?)')
      for (const [filePath, doc] of Object.entries(index.documents)) {
        writeDocumentRows(insertDoc, insertTerm, filePath, doc.tokens, now)
      }
    })
  } catch {
    // Older or partially migrated DBs still keep the kv_store fallback below.
  }
}

function updatePerFileTables(
  projectId: string,
  index: BM25Index,
  changedFiles: string[],
  deletedFiles: string[]
): void {
  try {
    prjctDb.transaction(projectId, (db) => {
      const deleteTerms = db.prepare('DELETE FROM bm25_terms WHERE path = ?')
      const deleteDoc = db.prepare('DELETE FROM bm25_documents WHERE path = ?')
      const insertDoc = db.prepare(
        'INSERT INTO bm25_documents (path, tokens, length, updated_at) VALUES (?, ?, ?, ?)'
      )
      const insertTerm = db.prepare('INSERT INTO bm25_terms (token, path, tf) VALUES (?, ?, ?)')
      const now = new Date().toISOString()

      for (const filePath of new Set([...changedFiles, ...deletedFiles])) {
        deleteTerms.run(filePath)
        deleteDoc.run(filePath)
      }
      for (const filePath2 of changedFiles) {
        const doc = index.documents[filePath2]
        if (doc) writeDocumentRows(insertDoc, insertTerm, filePath2, doc.tokens, now)
      }
    })
  } catch {
    // If the table path is unavailable, the next full sync rebuilds it.
  }
}

function saveIndex(projectId: string, index: BM25Index): void {
  prjctDb.setDoc(projectId, INDEX_KEY, indexMetadata(index))
  replacePerFileTables(projectId, index)
  indexCache.delete(projectId)
}

function saveIndexUpdate(
  projectId: string,
  index: BM25Index,
  changedFiles: string[],
  deletedFiles: string[]
): void {
  prjctDb.setDoc(projectId, INDEX_KEY, indexMetadata(index))
  updatePerFileTables(projectId, index, changedFiles, deletedFiles)
  indexCache.delete(projectId)
}

function loadIndexFromPerFileTables(
  projectId: string,
  updatedAt: string,
  stored: StoredBm25Index | null
): BM25Index | null {
  try {
    // tokens column deliberately NOT selected: scoring needs only lengths +
    // the inverted index, and parsing every doc's token JSON (477KB on the
    // reference repo) dominated the load. removeDocument's empty-tokens
    // fallback covers the incremental path; changed files are re-tokenized
    // fresh before their rows are rewritten.
    const docs = prjctDb.query<{ path: string; length: number }>(
      projectId,
      'SELECT path, length FROM bm25_documents ORDER BY path'
    )
    if (docs.length === 0) {
      if (stored?.totalDocs === 0) {
        const index: BM25Index = {
          documents: {},
          invertedIndex: emptyInvertedIndex(),
          avgDocLength: 0,
          totalDocs: 0,
          builtAt: stored.builtAt,
        }
        indexCache.set(projectId, { index, updatedAt })
        return index
      }
      return null
    }

    const documents: BM25Index['documents'] = {}
    const invertedIndex: BM25Index['invertedIndex'] = emptyInvertedIndex()
    for (const doc of docs) {
      documents[doc.path] = { tokens: [], length: doc.length }
    }
    const totalLength = docs.reduce((total, doc) => total + doc.length, 0)

    const terms = prjctDb.query<{ token: string; path: string; tf: number }>(
      projectId,
      'SELECT token, path, tf FROM bm25_terms ORDER BY token, path'
    )
    for (const term of terms) {
      if (!invertedIndex[term.token]) invertedIndex[term.token] = []
      invertedIndex[term.token].push({
        path: term.path,
        tf: term.tf,
      })
    }

    const totalDocs = docs.length
    const index: BM25Index = {
      documents,
      invertedIndex,
      avgDocLength: totalDocs > 0 ? totalLength / totalDocs : 0,
      totalDocs,
      builtAt: stored?.builtAt ?? updatedAt,
    }
    indexCache.set(projectId, { index, updatedAt })
    return index
  } catch {
    return null
  }
}

/**
 * Cheap existence check: the kv meta row is written on every save, so its
 * presence answers "is there an index?" without deserializing the corpus
 * (the registry's hasIndex used to trigger a FULL load for this).
 */
export function hasIndex(projectId: string): boolean {
  try {
    return (
      prjctDb.get<{ k: string }>(
        projectId,
        'SELECT key AS k FROM kv_store WHERE key = ? LIMIT 1',
        INDEX_KEY
      ) != null
    )
  } catch {
    return false
  }
}

/**
 * Load a BM25 index from SQLite.
 * Returns null if no index exists.
 */
export function loadIndex(projectId: string): BM25Index | null {
  const meta = prjctDb.get<{ updated_at: string }>(
    projectId,
    'SELECT updated_at FROM kv_store WHERE key = ?',
    INDEX_KEY
  )
  if (!meta) {
    indexCache.delete(projectId)
    return null
  }
  const hit = indexCache.get(projectId)
  if (hit && hit.updatedAt === meta.updated_at) return hit.index

  const stored = prjctDb.getDoc<StoredBm25Index>(projectId, INDEX_KEY)
  const tableIndex = loadIndexFromPerFileTables(projectId, meta.updated_at, stored)
  if (tableIndex) return tableIndex

  if (!stored?.invertedIndex) return null

  // Reconstruct documents map with lengths only (tokens not needed for scoring)
  const documents: BM25Index['documents'] = {}
  for (const [p, length] of Object.entries(stored.docLengths)) {
    documents[p] = { tokens: [], length }
  }

  const index: BM25Index = {
    documents,
    // Normalize the JSON-loaded map: JSON.parse restores Object.prototype, so a
    // `constructor`/`__proto__` token query would collide again. Rehome onto a
    // prototype-less object.
    invertedIndex: Object.assign(emptyInvertedIndex(), stored.invertedIndex),
    avgDocLength: stored.avgDocLength,
    totalDocs: stored.totalDocs,
    builtAt: stored.builtAt,
  }
  indexCache.set(projectId, { index, updatedAt: meta.updated_at })
  return index
}

// High-level API

/**
 * Build and persist a BM25 index for a project.
 */
export async function indexProject(projectPath: string, projectId: string): Promise<BM25Index> {
  const index = await buildIndex(projectPath)
  saveIndex(projectId, index)
  return index
}

/**
 * Update the persisted BM25 index by retokenizing only changed files.
 * Falls back to a full rebuild if no existing index can be loaded.
 */
export async function updateProjectIndex(
  projectPath: string,
  projectId: string,
  changedFiles: string[],
  deletedFiles: string[] = []
): Promise<BM25Index> {
  const existing = loadIndex(projectId)
  if (!existing) return indexProject(projectPath, projectId)

  const touched = new Set([...changedFiles, ...deletedFiles])
  for (const filePath of touched) removeDocument(existing, filePath)

  const results = await batchProcess(changedFiles, 50, async (filePath) => {
    try {
      const content = await fs.readFile(path.join(projectPath, filePath), 'utf-8')
      const tokens = tokenizeFile(content, filePath)
      return { filePath, tokens }
    } catch {
      return null
    }
  })

  for (const { filePath, tokens } of results) addDocument(existing, filePath, tokens)
  recalculateStats(existing)
  saveIndexUpdate(projectId, existing, changedFiles, deletedFiles)
  return existing
}

/**
 * Query files by relevance to a task description.
 * Loads index from SQLite, scores against query, returns top N.
 *
 * @param projectId - Project ID for SQLite lookup
 * @param query - Task description or search query
 * @param topN - Maximum number of results (default: 15)
 * @returns Sorted array of (path, score) — empty if no index exists
 */
export function queryFiles(projectId: string, query: string, topN = 15): BM25Score[] {
  const index = loadIndex(projectId)
  if (!index) return []

  return score(query, index).slice(0, topN)
}
