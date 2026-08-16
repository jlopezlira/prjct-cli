/**
 * Code-graph table access — the "wipe + bulk-insert `code_symbols` /
 * `code_symbol_edges`" transaction shared by a fresh build
 * (domain/symbol-graph.ts) and artifact restore (services/code-graph-artifact.ts),
 * plus the edges read shared by artifact export and cloud sync. Lives in
 * storage/, not domain/ — domain/ is pure algorithms, no IO.
 */

import type { CodeSymbol, CodeSymbolEdge } from '../types/domain.js'
import prjctDb from './database'

export function replaceCodeGraph(
  projectId: string,
  graph: { symbols: CodeSymbol[]; edges: CodeSymbolEdge[] }
): void {
  prjctDb.transaction(projectId, (db) => {
    db.prepare('DELETE FROM code_symbols').run()
    db.prepare('DELETE FROM code_symbol_edges').run()
    const insSym = db.prepare(
      `INSERT INTO code_symbols (id, file, kind, name, qname, start_line, end_line, exported)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insEdge = db.prepare(
      `INSERT OR IGNORE INTO code_symbol_edges (src, dst, edge_type, confidence)
       VALUES (?, ?, ?, ?)`
    )
    for (const s of graph.symbols) {
      insSym.run(s.id, s.file, s.kind, s.name, s.qname, s.startLine, s.endLine, s.exported ? 1 : 0)
    }
    for (const e of graph.edges) {
      insEdge.run(e.src, e.dst, e.edgeType, e.confidence)
    }
  })
}

/** All code_symbol_edges for a project, mapped to the domain shape. Empty on any query error. */
export function loadCodeSymbolEdges(projectId: string): CodeSymbolEdge[] {
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
        edgeType: r.edge_type as CodeSymbolEdge['edgeType'],
        confidence: r.confidence,
      }))
  } catch {
    return []
  }
}
