/**
 * Import Graph Builder
 *
 * Builds a directed dependency graph from TypeScript/JavaScript imports.
 * Uses the existing imports-tool parser to extract import relationships.
 *
 * When BM25 identifies a file as relevant, this follows the import chain
 * N levels deep (default: 2) to include closely related files.
 *
 * Score = 1 / (depth + 1) for each reachable file.
 * Direct imports get 0.5, 2nd-level imports get 0.33.
 *
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { IMPORT_REGEX, RESOLVE_EXTENSIONS } from '../constants/file-patterns'
import prjctDb from '../storage/database'
import type {
  ImportAdjacency,
  ImportGraph,
  ImportScore,
  ReverseAdjacency,
} from '../types/domain.js'
import { batchProcess, walkDir } from '../utils/file-helper'

/**
 * Extract internal import paths from file content.
 * Only resolves relative imports (starting with . or @/).
 */
function extractImportSources(content: string): string[] {
  const regex = new RegExp(IMPORT_REGEX.source, 'g')
  return [...content.matchAll(regex)]
    .map((match) => match[1])
    .filter((source) => source.startsWith('.') || source.startsWith('@/'))
}

/**
 * Try to resolve an import source to an actual file path.
 */
async function resolveImport(
  source: string,
  fromFile: string,
  projectPath: string
): Promise<string | null> {
  const basePath = source.startsWith('@/')
    ? path.join(projectPath, 'src', source.slice(2))
    : path.resolve(path.dirname(path.join(projectPath, fromFile)), source)

  for (const ext of RESOLVE_EXTENSIONS) {
    const fullPath = basePath + ext
    try {
      const stat = await fs.stat(fullPath)
      if (stat.isFile()) {
        return path.relative(projectPath, fullPath)
      }
    } catch {
      // Extension not found, try next
    }
  }
  return null
}

// Graph Building

/**
 * Build the import graph for a project.
 *
 * Performance target: <3 seconds for 500-file project.
 */
export async function buildGraph(projectPath: string): Promise<ImportGraph> {
  const files = await walkDir(projectPath)
  const forward: ImportAdjacency = {}
  const reverse: ReverseAdjacency = {}

  // Process files in parallel batches of 50
  const results = await batchProcess(files, 50, async (filePath) => {
    const result = await importsForFile(projectPath, filePath)
    return result && result.imports.length > 0 ? result : null
  })

  for (const { filePath, imports } of results) {
    forward[filePath] = imports
    for (const target of imports) {
      if (!reverse[target]) reverse[target] = []
      reverse[target].push(filePath)
    }
  }

  return {
    forward,
    reverse,
    fileCount: files.length,
    edgeCount: results.reduce((total, result) => total + result.imports.length, 0),
    builtAt: new Date().toISOString(),
  }
}

// Graph Scoring

/**
 * Given a set of seed files (e.g., from BM25), follow import chains
 * and score connected files by proximity.
 *
 * Score = 1 / (depth + 1):
 * - Seed file itself: not scored (already scored by BM25)
 * - Direct import/importer: 0.5 (depth=1)
 * - 2nd-level: 0.33 (depth=2)
 *
 * Follows both forward (imports) and reverse (imported-by) edges.
 *
 * @param seedFiles - Files already identified as relevant
 * @param graph - The import graph
 * @param maxDepth - Maximum depth to follow (default: 2)
 * @returns Scored files NOT in the seed set
 */
export function scoreFromSeeds(
  seedFiles: string[],
  graph: ImportGraph,
  maxDepth = 2
): ImportScore[] {
  const seedSet = new Set(seedFiles)
  const visited = new Map<string, { score: number; depth: number }>()

  // BFS from each seed
  const queue: Array<{ file: string; depth: number }> = []

  for (const seed of seedFiles) {
    // Add direct neighbors at depth 1
    const forwardEdges = graph.forward[seed] || []
    const reverseEdges = graph.reverse[seed] || []

    for (const neighbor of [...forwardEdges, ...reverseEdges]) {
      if (!seedSet.has(neighbor)) {
        queue.push({ file: neighbor, depth: 1 })
      }
    }
  }

  // Process queue without Array.shift(), which is O(n) per pop on large graphs.
  for (const { file, depth } of queue) {
    if (depth > maxDepth) continue

    const score = 1 / (depth + 1)
    const existing = visited.get(file)

    if (existing) {
      // Keep the better (higher) score
      if (score > existing.score) {
        visited.set(file, { score, depth })
      }
      continue
    }

    visited.set(file, { score, depth })

    // Continue BFS for next level
    if (depth < maxDepth) {
      const forwardEdges = graph.forward[file] || []
      const reverseEdges = graph.reverse[file] || []

      for (const neighbor2 of [...forwardEdges, ...reverseEdges]) {
        if (!seedSet.has(neighbor2) && !visited.has(neighbor2)) {
          queue.push({ file: neighbor2, depth: depth + 1 })
        }
      }
    }
  }

  return Array.from(visited.entries())
    .map(([p, { score, depth }]) => ({ path: p, score, depth }))
    .sort((a, b) => b.score - a.score)
}

// SQLite Persistence

const INDEX_KEY = 'import-graph'

// Process-local mtime cache. The graph can be a few MB after JSON.parse;
// MCP tool calls that ask for related/impact files in succession would
// otherwise re-parse on every call. Invalidation is exact: we look up
// the kv_store row's `updated_at` (cheap SQL) and only re-parse when it
// has changed since the last successful load.
const graphCache = new Map<string, { graph: ImportGraph; updatedAt: string }>()

function countEdges(forward: ImportAdjacency): number {
  return Object.values(forward).reduce((sum, imports) => sum + imports.length, 0)
}

function removeOutgoingEdges(graph: ImportGraph, filePath: string): void {
  const currentImports = graph.forward[filePath] || []
  delete graph.forward[filePath]

  for (const target of currentImports) {
    const nextImporters = (graph.reverse[target] || []).filter((importer) => importer !== filePath)
    if (nextImporters.length === 0) delete graph.reverse[target]
    else graph.reverse[target] = nextImporters
  }
}

function removeIncomingEdges(graph: ImportGraph, filePath: string): string[] {
  const importers = graph.reverse[filePath] || []
  delete graph.reverse[filePath]

  const affectedImporters: string[] = []
  for (const importer of importers) {
    const nextImports = (graph.forward[importer] || []).filter((target) => target !== filePath)
    if (nextImports.length === 0) delete graph.forward[importer]
    else graph.forward[importer] = nextImports
    affectedImporters.push(importer)
  }

  return affectedImporters
}

function addEdges(graph: ImportGraph, filePath: string, imports: string[]): void {
  if (imports.length === 0) return

  const uniqueImports = Array.from(new Set(imports))
  graph.forward[filePath] = uniqueImports

  for (const target of uniqueImports) {
    if (!graph.reverse[target]) graph.reverse[target] = []
    if (!graph.reverse[target].includes(filePath)) graph.reverse[target].push(filePath)
  }
}

async function importsForFile(
  projectPath: string,
  filePath: string
): Promise<{ filePath: string; imports: string[] } | null> {
  try {
    const content = await fs.readFile(path.join(projectPath, filePath), 'utf-8')
    const sources = extractImportSources(content)
    const resolved: string[] = []

    for (const source of sources) {
      const target = await resolveImport(source, filePath, projectPath)
      if (target && target !== filePath) {
        resolved.push(target)
      }
    }

    return { filePath, imports: resolved }
  } catch {
    return null
  }
}

interface StoredImportGraph {
  schemaVersion?: number
  forward?: ImportAdjacency
  reverse?: ReverseAdjacency
  fileCount: number
  edgeCount: number
  builtAt: string
}

function graphMetadata(graph: ImportGraph): StoredImportGraph {
  return {
    schemaVersion: 2,
    fileCount: graph.fileCount,
    edgeCount: graph.edgeCount,
    builtAt: graph.builtAt,
  }
}

function replacePerFileEdges(projectId: string, graph: ImportGraph): void {
  try {
    prjctDb.transaction(projectId, (db) => {
      db.prepare('DELETE FROM import_graph_edges').run()
      const insertEdge = db.prepare(
        'INSERT INTO import_graph_edges (from_path, to_path, sort_order) VALUES (?, ?, ?)'
      )
      for (const [fromPath, imports] of Object.entries(graph.forward)) {
        for (const [sortOrder, toPath] of imports.entries()) {
          insertEdge.run(fromPath, toPath, sortOrder)
        }
      }
    })
  } catch {
    // Older or partially migrated DBs still keep the kv_store fallback below.
  }
}

function updatePerFileEdges(
  projectId: string,
  graph: ImportGraph,
  changedFiles: string[],
  deletedFiles: string[]
): void {
  try {
    prjctDb.transaction(projectId, (db) => {
      const deleteOutgoing = db.prepare('DELETE FROM import_graph_edges WHERE from_path = ?')
      const insertEdge = db.prepare(
        'INSERT INTO import_graph_edges (from_path, to_path, sort_order) VALUES (?, ?, ?)'
      )

      for (const filePath of new Set([...changedFiles, ...deletedFiles])) {
        deleteOutgoing.run(filePath)
      }
      for (const filePath2 of changedFiles) {
        const imports = graph.forward[filePath2] || []
        for (const [sortOrder, target] of imports.entries()) {
          insertEdge.run(filePath2, target, sortOrder)
        }
      }
    })
  } catch {
    // If the table path is unavailable, the next full sync rebuilds it.
  }
}

function loadGraphFromPerFileEdges(
  projectId: string,
  updatedAt: string,
  stored: StoredImportGraph | null
): ImportGraph | null {
  try {
    const edges = prjctDb.query<{ from_path: string; to_path: string }>(
      projectId,
      'SELECT from_path, to_path FROM import_graph_edges ORDER BY from_path, sort_order, to_path'
    )
    if (edges.length === 0) {
      if (stored?.edgeCount === 0) {
        const graph: ImportGraph = {
          forward: {},
          reverse: {},
          fileCount: stored.fileCount,
          edgeCount: 0,
          builtAt: stored.builtAt,
        }
        graphCache.set(projectId, { graph, updatedAt })
        return graph
      }
      return null
    }

    const forward: ImportAdjacency = {}
    const reverse: ReverseAdjacency = {}

    for (const edge of edges) {
      if (!forward[edge.from_path]) forward[edge.from_path] = []
      forward[edge.from_path].push(edge.to_path)

      if (!reverse[edge.to_path]) reverse[edge.to_path] = []
      reverse[edge.to_path].push(edge.from_path)
    }

    const files = new Set<string>()
    for (const [fromPath, imports] of Object.entries(forward)) {
      files.add(fromPath)
      for (const toPath of imports) files.add(toPath)
    }

    const graph: ImportGraph = {
      forward,
      reverse,
      fileCount: stored?.fileCount ?? files.size,
      edgeCount: edges.length,
      builtAt: stored?.builtAt ?? updatedAt,
    }
    graphCache.set(projectId, { graph, updatedAt })
    return graph
  } catch {
    return null
  }
}

export function saveGraph(projectId: string, graph: ImportGraph): void {
  prjctDb.setDoc(projectId, INDEX_KEY, graphMetadata(graph))
  replacePerFileEdges(projectId, graph)
  graphCache.delete(projectId)
}

function saveGraphUpdate(
  projectId: string,
  graph: ImportGraph,
  changedFiles: string[],
  deletedFiles: string[]
): void {
  prjctDb.setDoc(projectId, INDEX_KEY, graphMetadata(graph))
  updatePerFileEdges(projectId, graph, changedFiles, deletedFiles)
  graphCache.delete(projectId)
}

export function loadGraph(projectId: string): ImportGraph | null {
  const meta = prjctDb.get<{ updated_at: string }>(
    projectId,
    'SELECT updated_at FROM kv_store WHERE key = ?',
    INDEX_KEY
  )
  if (!meta) {
    graphCache.delete(projectId)
    return null
  }
  const hit = graphCache.get(projectId)
  if (hit && hit.updatedAt === meta.updated_at) return hit.graph
  const stored = prjctDb.getDoc<StoredImportGraph>(projectId, INDEX_KEY)
  const tableGraph = loadGraphFromPerFileEdges(projectId, meta.updated_at, stored)
  if (tableGraph) return tableGraph
  if (!stored?.forward || !stored?.reverse) return null
  const graph: ImportGraph = {
    forward: stored.forward,
    reverse: stored.reverse,
    fileCount: stored.fileCount,
    edgeCount: stored.edgeCount,
    builtAt: stored.builtAt,
  }
  graphCache.set(projectId, { graph, updatedAt: meta.updated_at })
  return graph
}

// High-level API

/**
 * Build and persist the import graph for a project.
 */
export async function indexImports(projectPath: string, projectId: string): Promise<ImportGraph> {
  const graph = await buildGraph(projectPath)
  saveGraph(projectId, graph)
  return graph
}

/**
 * Update the persisted import graph by reparsing only changed files.
 * Falls back to a full rebuild when no existing graph can be loaded.
 */
export async function updateImportGraph(
  projectPath: string,
  projectId: string,
  changedFiles: string[],
  deletedFiles: string[] = []
): Promise<ImportGraph> {
  const existing = loadGraph(projectId)
  if (!existing) return indexImports(projectPath, projectId)

  const touched = new Set([...changedFiles, ...deletedFiles])
  for (const filePath of touched) removeOutgoingEdges(existing, filePath)

  const affectedImporters = new Set<string>()
  for (const filePath2 of deletedFiles) {
    for (const importer of removeIncomingEdges(existing, filePath2)) {
      affectedImporters.add(importer)
    }
  }

  const results = await batchProcess(changedFiles, 50, (filePath) =>
    importsForFile(projectPath, filePath)
  )

  for (const result of results) addEdges(existing, result.filePath, result.imports)
  existing.edgeCount = countEdges(existing.forward)
  existing.builtAt = new Date().toISOString()
  saveGraphUpdate(projectId, existing, [...changedFiles, ...affectedImporters], deletedFiles)
  return existing
}
