/**
 * Structural code-graph snapshot for cloud 3D visualization.
 *
 * Same domain as CBM / native symbol index:
 *   nodes = Function | Method | Class | Interface | Type | File | …
 *   links = CALLS | IMPORTS | DEFINES | HANDLES | TESTS
 *
 * NOT knowledge/contribution clusters.
 *
 * Default: ship the FULL index (every symbol, every structural edge, every
 * file that holds a symbol). Optional maxNodes/maxLinks are opt-in only for
 * tests or explicit callers — never applied by default.
 */

import { hasSymbolIndex, listAllSymbols, loadMeta } from '../domain/symbol-graph'
import prjctDb from '../storage/database'
import type { CodeSymbolEdge, SymbolEdgeType } from '../types/domain.js'

export type CloudGraphNodeKind =
  | 'Function'
  | 'Method'
  | 'Class'
  | 'Interface'
  | 'Type'
  | 'Enum'
  | 'Const'
  | 'Route'
  | 'File'
  | 'Symbol'

export interface CloudGraphNode {
  id: string
  name: string
  kind: CloudGraphNodeKind | string
  file?: string | null
  exported?: boolean
}

export interface CloudGraphLink {
  source: string
  target: string
  type: string
}

export interface CloudCodeGraphSnapshot {
  version: 1
  builtAt: string
  symbolCount: number
  edgeCount: number
  nodes: CloudGraphNode[]
  links: CloudGraphLink[]
}

const KIND_MAP: Record<string, CloudGraphNodeKind> = {
  function: 'Function',
  method: 'Method',
  class: 'Class',
  interface: 'Interface',
  type: 'Type',
  enum: 'Enum',
  const: 'Const',
  route: 'Route',
  file: 'File',
}

/** Prefer structural call graph edges; imports/defines still useful. */
const EDGE_PRIORITY: Record<string, number> = {
  CALLS: 5,
  IMPORTS: 4,
  DEFINES: 3,
  HANDLES: 2,
  TESTS: 1,
}

function mapKind(kind: string): CloudGraphNodeKind {
  return KIND_MAP[kind.toLowerCase()] ?? 'Symbol'
}

function loadEdges(projectId: string): CodeSymbolEdge[] {
  try {
    return prjctDb
      .query<{
        src: string
        dst: string
        edge_type: string
        confidence: number
      }>(projectId, 'SELECT src, dst, edge_type, confidence FROM code_symbol_edges')
      .map((r) => ({
        src: r.src,
        dst: r.dst,
        edgeType: r.edge_type as SymbolEdgeType,
        confidence: r.confidence,
      }))
  } catch {
    return []
  }
}

function hasFiniteCap(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

/**
 * Build a CBM-style structural graph from the local symbol index.
 *
 * Default = full index. Pass maxNodes/maxLinks only when you intentionally
 * want a truncated sample (tests).
 */
export function buildCloudCodeGraphSnapshot(
  projectId: string,
  opts: { maxNodes?: number; maxLinks?: number } = {}
): CloudCodeGraphSnapshot | null {
  if (!hasSymbolIndex(projectId)) return null

  const symbols = listAllSymbols(projectId)
  if (symbols.length === 0) return null

  const edges = loadEdges(projectId)
  const meta = loadMeta(projectId)

  // Degree from structural edges only (ordering only — does not drop nodes)
  const degree = new Map<string, number>()
  for (const e of edges) {
    const w = EDGE_PRIORITY[e.edgeType] ?? 1
    degree.set(e.src, (degree.get(e.src) ?? 0) + w)
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + w)
  }

  const kindWeight = (k: string): number => {
    switch (k) {
      case 'class':
        return 8
      case 'function':
      case 'method':
        return 6
      case 'interface':
      case 'type':
        return 4
      case 'route':
        return 5
      default:
        return 2
    }
  }

  const scored = symbols
    .map((s) => {
      const deg = degree.get(s.id) ?? 0
      const exp = s.exported ? 4 : 0
      return { s, score: deg + exp + kindWeight(s.kind) }
    })
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))

  // Full set by default; optional opt-in cap for tests only
  const picked = hasFiniteCap(opts.maxNodes)
    ? scored.slice(0, opts.maxNodes).map((x) => x.s)
    : scored.map((x) => x.s)
  const keep = new Set(picked.map((s) => s.id))

  // File nodes for every file among picked symbols (no "top N" slice)
  const fileCounts = new Map<string, number>()
  for (const s of picked) {
    fileCounts.set(s.file, (fileCounts.get(s.file) ?? 0) + 1)
  }
  const files = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([f]) => f)

  const fileNodeId = (file: string) => `file:${file}`
  const nodes: CloudGraphNode[] = []

  for (const file of files) {
    const base = file.split('/').pop() || file
    nodes.push({
      id: fileNodeId(file),
      name: base,
      kind: 'File',
      file,
      exported: false,
    })
    keep.add(fileNodeId(file))
  }

  for (const s of picked) {
    nodes.push({
      id: s.id,
      name: s.name,
      kind: mapKind(s.kind),
      file: s.file,
      exported: s.exported,
    })
  }

  // DEFINES: File → symbol for every picked symbol that has a file node
  const defineLinks: CloudGraphLink[] = []
  const fileSet = new Set(files)
  for (const s of picked) {
    if (!fileSet.has(s.file)) continue
    defineLinks.push({
      source: fileNodeId(s.file),
      target: s.id,
      type: 'DEFINES',
    })
  }

  // Structural edges between kept symbol nodes (full set by default)
  const edgeCandidates = edges
    .filter((e) => keep.has(e.src) && keep.has(e.dst) && e.src !== e.dst)
    .map((e) => ({
      source: e.src,
      target: e.dst,
      type: e.edgeType,
      prio: EDGE_PRIORITY[e.edgeType] ?? 0,
      conf: e.confidence,
    }))
    .sort((a, b) => b.prio - a.prio || b.conf - a.conf)

  const seen = new Set<string>()
  const links: CloudGraphLink[] = []
  const linkCap = hasFiniteCap(opts.maxLinks) ? opts.maxLinks : Number.POSITIVE_INFINITY

  for (const d of defineLinks) {
    if (links.length >= linkCap) break
    const key = `${d.source}->${d.target}:${d.type}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ source: d.source, target: d.target, type: d.type })
  }

  for (const e of edgeCandidates) {
    if (links.length >= linkCap) break
    const key = `${e.source}->${e.target}:${e.type}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ source: e.source, target: e.target, type: e.type })
  }

  return {
    version: 1,
    builtAt: meta?.builtAt ?? new Date().toISOString(),
    symbolCount: meta?.symbolCount ?? symbols.length,
    edgeCount: meta?.edgeCount ?? edges.length,
    nodes,
    links,
  }
}

/** True when snapshot is non-empty enough to upload. */
export function isUploadableGraph(
  snap: CloudCodeGraphSnapshot | null
): snap is CloudCodeGraphSnapshot {
  return !!snap && snap.nodes.length > 0
}
