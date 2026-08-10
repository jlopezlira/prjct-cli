/**
 * Per-project code-graph cache artifact.
 *
 * Lives ONLY under prjct project storage — never in the client repo:
 *   ~/.prjct-cli/projects/<projectId>/code-graph.json.gz
 *
 * One file per projectId (same isolation as prjct.db). Not global, not
 * committed with the customer's source tree. Optional gzip snapshot of
 * symbols + edges for local bootstrap if the SQLite symbol tables are empty.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { hasSymbolIndex, listAllSymbols, loadMeta } from '../domain/symbol-graph'
import pathManager from '../infrastructure/path-manager'
import prjctDb from '../storage/database'
import type { LocalConfig } from '../types/config'
import type { CodeSymbol, CodeSymbolEdge, SymbolGraphMeta } from '../types/domain.js'
import type { CloudCodeGraphSnapshot } from './code-graph-cloud'

const ARTIFACT_NAME = 'code-graph.json.gz'

interface ArtifactPayload {
  version: 1
  projectId: string
  exportedAt: string
  meta: SymbolGraphMeta
  symbols: CodeSymbol[]
  edges: CodeSymbolEdge[]
}

/** Absolute path under ~/.prjct-cli/projects/<id>/ — never under client cwd. */
export function artifactPath(projectId: string): string {
  return path.join(pathManager.getGlobalProjectPath(projectId), ARTIFACT_NAME)
}

export async function exportCodeGraphArtifact(
  projectId: string
): Promise<{ path: string; bytes: number; symbols: number; edges: number } | null> {
  if (!hasSymbolIndex(projectId)) return null
  const symbols = listAllSymbols(projectId)
  const edges = (() => {
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
  })()
  const meta = loadMeta(projectId) ?? {
    symbolCount: symbols.length,
    edgeCount: edges.length,
    fileCount: new Set(symbols.map((s) => s.file)).size,
    builtAt: new Date().toISOString(),
  }
  const payload: ArtifactPayload = {
    version: 1,
    projectId,
    exportedAt: new Date().toISOString(),
    meta,
    symbols,
    edges,
  }
  const raw = Buffer.from(JSON.stringify(payload), 'utf-8')
  const gz = gzipSync(raw, { level: 6 })
  const out = artifactPath(projectId)
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, gz)
  return {
    path: out,
    bytes: gz.length,
    symbols: symbols.length,
    edges: edges.length,
  }
}

export async function importCodeGraphArtifact(
  projectId: string
): Promise<{ imported: boolean; symbols: number; edges: number; reason?: string }> {
  const file = artifactPath(projectId)
  const buf = await fs.readFile(file).catch(() => null)
  if (!buf) return { imported: false, symbols: 0, edges: 0, reason: 'no per-project artifact' }
  const parsed = (() => {
    try {
      const json = gunzipSync(buf).toString('utf-8')
      return { payload: JSON.parse(json) as ArtifactPayload }
    } catch (e) {
      return { error: `corrupt artifact: ${e instanceof Error ? e.message : String(e)}` }
    }
  })()
  if ('error' in parsed) {
    return { imported: false, symbols: 0, edges: 0, reason: parsed.error }
  }
  const payload = parsed.payload
  if (payload.version !== 1 || !Array.isArray(payload.symbols)) {
    return { imported: false, symbols: 0, edges: 0, reason: 'unsupported artifact version' }
  }
  // Refuse cross-project restore (artifact stamped with projectId)
  if (payload.projectId && payload.projectId !== projectId) {
    return {
      imported: false,
      symbols: 0,
      edges: 0,
      reason: `artifact projectId mismatch (got ${payload.projectId}, expected ${projectId})`,
    }
  }

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
    for (const s of payload.symbols) {
      insSym.run(s.id, s.file, s.kind, s.name, s.qname, s.startLine, s.endLine, s.exported ? 1 : 0)
    }
    for (const e of payload.edges) {
      insEdge.run(e.src, e.dst, e.edgeType, e.confidence)
    }
  })
  prjctDb.setDoc(projectId, 'symbol-graph', {
    ...payload.meta,
    builtAt: payload.meta.builtAt ?? payload.exportedAt,
  })
  return {
    imported: true,
    symbols: payload.symbols.length,
    edges: payload.edges.length,
  }
}

/**
 * Bootstrap: if SQLite symbol tables empty but this project's cache file
 * exists under ~/.prjct-cli/projects/<id>/, restore into SQLite.
 */
export async function bootstrapCodeGraphFromArtifact(
  projectId: string
): Promise<{ bootstrapped: boolean; detail: string }> {
  if (hasSymbolIndex(projectId)) {
    return { bootstrapped: false, detail: 'local index already present' }
  }
  const result = await importCodeGraphArtifact(projectId)
  if (!result.imported) {
    return { bootstrapped: false, detail: result.reason ?? 'import failed' }
  }
  return {
    bootstrapped: true,
    detail: `imported ${result.symbols} symbols / ${result.edges} edges from per-project cache`,
  }
}

export function shouldAutoUploadCodeGraph(
  config: Pick<LocalConfig, 'cloud'> | null | undefined
): boolean {
  return config?.cloud?.enabled === true && config.cloud.paused !== true
}

export interface CodeGraphUploadDependencies {
  buildSnapshot?: (projectId: string) => CloudCodeGraphSnapshot | null
  upload?: (
    projectId: string,
    graph: CloudCodeGraphSnapshot
  ) => Promise<{ ok: boolean; nodes?: number; links?: number; reason?: string }>
}

/** After a successful full index, always refresh the local cache (non-fatal). */
export async function maybeExportAfterIndex(
  projectId: string,
  options: { uploadToCloud: boolean; uploadDependencies?: CodeGraphUploadDependencies }
): Promise<void> {
  try {
    await exportCodeGraphArtifact(projectId)
  } catch {
    /* non-critical */
  }
  if (!options.uploadToCloud) return
  // Best-effort cloud upload so the SPA 3D graph stays structural (not knowledge).
  try {
    await maybeUploadCodeGraphToCloud(projectId, options.uploadDependencies)
  } catch {
    /* non-critical — offline / unauthed */
  }
}

/** Build full structural snapshot (no node/link caps) and POST to /sync/projects/{id}/code-graph. */
export async function maybeUploadCodeGraphToCloud(
  projectId: string,
  dependencies: CodeGraphUploadDependencies = {}
): Promise<{ uploaded: boolean; nodes?: number; links?: number; reason?: string }> {
  const cloudGraph = await import('./code-graph-cloud')
  const snap = (dependencies.buildSnapshot ?? cloudGraph.buildCloudCodeGraphSnapshot)(projectId)
  if (!cloudGraph.isUploadableGraph(snap)) {
    return { uploaded: false, reason: 'no symbol index or empty graph' }
  }
  try {
    const upload =
      dependencies.upload ??
      (async (id: string, graph: CloudCodeGraphSnapshot) => {
        const { default: syncClient } = await import('../sync/sync-client')
        return syncClient.uploadCodeGraph(id, graph)
      })
    const res = await upload(projectId, snap)
    if (!res.ok) {
      return {
        uploaded: false,
        reason: res.reason ?? 'upload failed or unauthenticated',
        nodes: snap.nodes.length,
        links: snap.links.length,
      }
    }
    return {
      uploaded: true,
      nodes: res.nodes ?? snap.nodes.length,
      links: res.links ?? snap.links.length,
    }
  } catch (e) {
    return {
      uploaded: false,
      reason: e instanceof Error ? e.message : String(e),
    }
  }
}
