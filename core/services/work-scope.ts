/**
 * Work-scope resolution — the SSOT for "which files should the agent open?"
 *
 * Agents MUST resolve scope through prjct BEFORE Grep/Glob walks. Pipeline:
 *   1) Memory seeds (FTS + optional semantic embeddings via enrichedRecall)
 *   2) Code index rank (BM25 + import graph + co-change)
 *   3) Graph expand (neighbors of top seeds)
 *   4) Merge → constrained list (default 8) with honest reasons
 *
 * Path language/extension filters are DYNAMIC: built on sync into
 * `file-inventory` (project-file-inventory.ts). No hard-coded language lists.
 */

import { hasIndexes, rankFiles } from '../domain/file-ranker'
import type { MemoryEntry } from '../memory/entries'
import { projectMemory } from '../memory/project-memory'
import type { LikelyFileHit } from './file-cue'
import {
  formatInventorySummary,
  inventoryExtensions,
  inventoryPathWeightFor,
  loadFileInventory,
  pathMatchesInventory,
} from './project-file-inventory'
import { breakImpact } from './world-model-impact'

const DEFAULT_LIMIT = 8

/**
 * Generic path capture: `dir/…/name.ext` with any extension.
 * Acceptance is gated by project file-inventory (discovered at sync), not by
 * a static language whitelist.
 */
const REPO_PATH_RE = /(?:^|[\s`"'(])((?:@?[\w.-]+\/)+[\w.-]+\.[\w.-]+)(?:$|[\s`"'),;:])/g

export interface WorkScopeHit extends LikelyFileHit {
  /** Higher is better; used for merge sort. */
  score: number
}

export interface WorkScopeResult {
  files: WorkScopeHit[]
  /** True when BM25/import/cochange indexes exist. */
  indexesReady: boolean
  /** How seeds were obtained. */
  sources: {
    memorySeeds: number
    indexHits: number
    graphNeighbors: number
  }
  /** Agent-facing block with MUST discipline. */
  agentBlock: string
}

/**
 * Sync resolution for UserPromptSubmit / cold paths.
 * Memory: FTS only (no embedding HTTP). Index: BM25+graph. Expand: graph.
 */
export function resolveWorkScopeSync(
  projectId: string,
  query: string,
  limit: number = DEFAULT_LIMIT
): WorkScopeResult {
  const q = query.trim()
  if (!q) return emptyResult()

  const memorySeeds = memoryFileSeedsSync(projectId, q)
  return mergeScope(projectId, q, memorySeeds, limit)
}

/** Memory types whose file tags seed the scope (semantic leg). */
const SCOPE_MEMORY_TYPES: ReadonlySet<string> = new Set([
  'context',
  'decision',
  'gotcha',
  'anti-pattern',
  'learning',
])

export interface ResolveWorkScopeOptions {
  /**
   * Memory hits the caller already pulled through `enrichedRecall` for the
   * same query. When present the semantic leg is NOT re-run — `prjct work`
   * recalls once and feeds both the related-context block and the scope.
   */
  memoryHits?: MemoryEntry[]
}

/**
 * Full resolution for work start / MCP — includes semantic memory blend
 * when embeddings are configured (enrichedRecall).
 */
export async function resolveWorkScope(
  projectPath: string,
  projectId: string,
  query: string,
  limit: number = DEFAULT_LIMIT,
  options: ResolveWorkScopeOptions = {}
): Promise<WorkScopeResult> {
  const q = query.trim()
  if (!q) return emptyResult()

  const memorySeeds = new Set<string>(memoryFileSeedsSync(projectId, q))
  try {
    const hits = options.memoryHits ?? (await semanticMemoryHits(projectPath, projectId, q))
    const scoped = hits.filter((h) => SCOPE_MEMORY_TYPES.has(h.type))
    for (const p of extractFilePathsFromEntries(scoped, projectId)) memorySeeds.add(p)
  } catch {
    /* FTS seeds still stand */
  }

  return mergeScope(projectId, q, memorySeeds, limit)
}

async function semanticMemoryHits(
  projectPath: string,
  projectId: string,
  query: string
): Promise<MemoryEntry[]> {
  const { enrichedRecall } = await import('../memory/enriched-recall')
  return enrichedRecall(projectPath, projectId, {
    topic: query,
    types: [...SCOPE_MEMORY_TYPES],
    limit: 12,
  })
}

function mergeScope(
  projectId: string,
  query: string,
  memorySeeds: Set<string>,
  limit: number
): WorkScopeResult {
  const indexes = hasIndexes(projectId)
  const scores = new Map<string, WorkScopeHit>()
  const inv = loadFileInventory(projectId)
  const invExts = inventoryExtensions(projectId)

  const bump = (filePath: string, score: number, signal: string, reason: string) => {
    if (!pathMatchesInventory(projectId, filePath)) return
    // Unknown ext vs inventory: downrank, never drop (P0-4). One inventory
    // load for the whole merge — not one per candidate.
    const weighted = score * inventoryPathWeightFor(invExts, filePath)
    const cur = scores.get(filePath)
    if (!cur) {
      scores.set(filePath, {
        path: filePath,
        score: weighted,
        signals: [signal],
        reason,
      })
      return
    }
    cur.score += weighted
    if (!cur.signals.includes(signal)) cur.signals.push(signal)
    if (weighted >= 0.4) cur.reason = reason
  }

  // 1) Memory seeds — trust file tags; inventory only filters noise / non-project exts
  for (const p of memorySeeds) {
    bump(
      p,
      memorySeedWeight(p, invExts),
      'memory',
      'linked from project judgment memory (decision/gotcha/context)'
    )
  }

  // 2) Code index: BM25 + symbols → import/cochange expand inside rankFiles
  const rankedFiles = (() => {
    if (!(indexes.bm25 || indexes.symbols)) return []
    try {
      return rankFiles(projectId, query, { topN: Math.max(limit * 2, 12) })
    } catch {
      return []
    }
  })()
  for (const f of rankedFiles) {
    const sym = f.signals.symbols ?? 0
    const signals = [
      f.signals.bm25 > 0 ? 'bm25' : null,
      sym > 0 ? 'symbols' : null,
      f.signals.imports > 0 ? 'imports' : null,
      f.signals.cochange > 0 ? 'cochange' : null,
    ].filter((s): s is string => s !== null)
    const topSignal = Math.max(f.signals.bm25, sym, f.signals.imports, f.signals.cochange)
    const reason =
      sym >= topSignal && sym > 0
        ? 'matches function/class/route symbols in code graph'
        : f.signals.bm25 >= f.signals.imports && f.signals.bm25 >= f.signals.cochange
          ? 'matches task terms in code index (BM25)'
          : f.signals.imports >= f.signals.cochange
            ? 'import-graph neighbor of matched files'
            : 'historically co-changes with matched files'
    bump(f.path, f.finalScore, signals[0] ?? 'bm25', reason)
    for (const s of signals.slice(1)) {
      const hit = scores.get(f.path)
      if (hit && !hit.signals.includes(s)) hit.signals.push(s)
    }
  }
  const indexHits = rankedFiles.length

  // 3) Graph expand from top seeds
  const seedForGraph = [...scores.keys()].slice(0, 5)
  if (seedForGraph.length === 0 && memorySeeds.size > 0) {
    seedForGraph.push(...[...memorySeeds].slice(0, 5))
  }
  const graphImpact = (() => {
    if (seedForGraph.length === 0) return null
    try {
      // Neighbours only: traps for the resolved files are recalled once by
      // the caller (recallRisksForFiles), not per graph expansion.
      return breakImpact(projectId, seedForGraph, limit, { traps: false })
    } catch {
      return null
    }
  })()
  if (graphImpact) {
    for (const n of graphImpact.neighbors) {
      bump(
        n.path,
        0.35 * Math.min(1, n.score + 0.1),
        n.via === 'both' ? 'imports' : n.via,
        n.via === 'cochange'
          ? 'historically co-changes with seed files'
          : 'import-graph neighbor of seed files'
      )
    }
  }
  const graphNeighbors = graphImpact?.neighbors.length ?? 0

  const files = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit)

  return {
    files,
    indexesReady: indexes.bm25 || indexes.imports || indexes.cochange || indexes.symbols,
    sources: {
      memorySeeds: memorySeeds.size,
      indexHits,
      graphNeighbors,
    },
    agentBlock: formatWorkScopeBlock(files, {
      indexesReady: indexes.bm25 || indexes.imports || indexes.cochange || indexes.symbols,
      memorySeeds: memorySeeds.size,
      inventoryLine: formatInventorySummary(inv),
    }),
  }
}

function memoryFileSeedsSync(projectId: string, query: string): Set<string> {
  const seeds = new Set<string>()
  try {
    const keywords = query
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 12)
    const lexicalEntries =
      keywords.length > 0
        ? (() => {
            try {
              return projectMemory.searchFts(projectId, keywords, 15)
            } catch {
              return []
            }
          })()
        : []
    const entries =
      lexicalEntries.length > 0
        ? lexicalEntries
        : projectMemory.recall(projectId, {
            types: ['gotcha', 'decision', 'anti-pattern', 'context'],
            limit: 20,
          })
    for (const p of extractFilePathsFromEntries(entries, projectId)) seeds.add(p)
  } catch {
    /* empty */
  }
  return seeds
}

/**
 * Extract repo-relative paths from memory tags + content mentions.
 * Uses project file-inventory extensions when present (dynamic per project).
 */
export function extractFilePathsFromEntries(entries: MemoryEntry[], projectId?: string): string[] {
  const out = new Set<string>()
  const accept = (raw: string) => {
    const p = normalizePath(raw)
    if (!p) return
    if (projectId) {
      if (pathMatchesInventory(projectId, p)) out.add(p)
    } else if (looksLikeRepoPath(p)) {
      out.add(p)
    }
  }

  for (const e of entries) {
    const fileTag = e.tags?.file?.trim()
    if (fileTag) accept(fileTag)
    const filesTag = e.tags?.files?.trim()
    if (filesTag) {
      for (const part of filesTag.split(',')) {
        const t = part.trim()
        if (t) accept(t)
      }
    }
    const content = e.content ?? ''
    REPO_PATH_RE.lastIndex = 0
    for (const m of content.matchAll(REPO_PATH_RE)) {
      accept(m[1]!)
    }
  }
  return [...out]
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/')
}

function looksLikeRepoPath(p: string): boolean {
  const n = normalizePath(p).trim()
  if (!n || n.length < 3) return false
  // Without projectId inventory, accept path-shaped strings with an extension.
  return n.includes('/') && n.includes('.')
}

/**
 * Soft weight using inventory: paths whose extension is among the project's
 * top extensions score higher. Not a hard language whitelist.
 */
function memorySeedWeight(p: string, invExts: Set<string>): number {
  const base = (p.split('/').pop() ?? p).toLowerCase()
  const ext = base.includes('.') ? `.${base.split('.').pop()}` : ''
  if (base === 'package.json' || base === 'cargo.toml' || base === 'go.mod') return 0.4
  if (invExts.size > 0 && ext && invExts.has(ext)) {
    return p.includes('/') ? 0.9 : 0.75
  }
  // Inventory empty or unknown ext still allowed (pathMatchesInventory open) — medium trust
  if (p.includes('/') && base.includes('.')) return 0.7
  return 0.5
}

function emptyResult(): WorkScopeResult {
  return {
    files: [],
    indexesReady: false,
    sources: { memorySeeds: 0, indexHits: 0, graphNeighbors: 0 },
    agentBlock: '',
  }
}

export function formatWorkScopeBlock(
  files: WorkScopeHit[],
  meta?: { indexesReady?: boolean; memorySeeds?: number; inventoryLine?: string }
): string {
  if (files.length === 0) {
    if (meta?.indexesReady === false) {
      return [
        '**Work scope (prjct):** indexes cold — run `prjct sync` once, then re-resolve scope.',
        meta.inventoryLine ? `_${meta.inventoryLine}_` : '',
        'Until then: prefer `prjct search` / `prjct context memory <topic>` over raw Grep/Glob walks.',
      ]
        .filter(Boolean)
        .join('\n')
    }
    return [
      '**Work scope (prjct):** no high-confidence file hits for this query.',
      meta?.inventoryLine ? `_${meta.inventoryLine}_` : '',
      'MUST still try `prjct context memory <topic>` + `prjct search` before a broad Grep/Glob walk.',
    ]
      .filter(Boolean)
      .join('\n')
  }

  const lines = [
    '**Work scope — prjct (MUST read before Grep/Glob):**',
    '> Do NOT walk the tree. Open these first. Expand only via `prjct guard <file>` (graph neighbors + traps) or MCP `prjct_relevant_files` / `prjct_impact_analysis`.',
    ...files.map((f) => {
      const sig = f.signals.length > 0 ? ` (${f.signals.join('+')})` : ''
      return `- \`${f.path}\` — ${f.reason}${sig}`
    }),
  ]
  if (meta?.memorySeeds && meta.memorySeeds > 0) {
    lines.push(`_Seeded from ${meta.memorySeeds} memory path hit(s) + code index + graph._`)
  }
  if (meta?.inventoryLine) lines.push(`_${meta.inventoryLine}_`)
  return lines.join('\n')
}

/** Adapt to LikelyFileHit[] for existing work/MCP call sites. */
export function toLikelyFileHits(files: WorkScopeHit[]): LikelyFileHit[] {
  return files.map(({ path, signals, reason }) => ({ path, signals, reason }))
}

/** @deprecated Use pathMatchesInventory — kept for tests that imported isUsefulScopePath */
export function isUsefulScopePath(p: string, projectId?: string): boolean {
  if (projectId) return pathMatchesInventory(projectId, p)
  return looksLikeRepoPath(p)
}
