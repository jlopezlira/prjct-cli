/**
 * Memory anchors — close the documented-vs-implemented gap ("prjct anchors
 * commit, author, and files"): a capture that names a file is bound at write
 * time to HEAD (`commit`) and, when its content names an indexed symbol, to
 * that symbol (`symbol`). Anchors ride memory_entry_tags through the existing
 * events trigger — no new write path.
 *
 * The sweep re-checks anchors at HEAD and marks entries whose anchor no longer
 * resolves (file gone without a rename, symbol gone from the index) with
 * `stale_at`. Recall then serves them LAST with a `[stale@sha]` cue — never
 * silently, never dropped: old ≠ wrong, but it must not outrank a fresh hit.
 */

import fs from 'node:fs'
import path from 'node:path'
import { hasSymbolIndex, searchSymbols } from '../domain/symbol-graph'
import prjctDb from '../storage/database'
import { execFileAsync } from '../utils/exec'
import type { MemoryEntry } from './entries'

/** Identifier-shaped tokens worth probing against the symbol index. */
const SYMBOL_TOKEN_RE = /\b([A-Z][A-Za-z0-9]{3,}|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\b/g
/** Sweep budget: recent captures only; the rest age out via retention. */
const SWEEP_LIMIT = 200

export interface ResolvedAnchors {
  commit?: string
  symbol?: string
}

async function headSha(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectPath })
    const sha = String(stdout ?? '').trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}

/** Exact-name presence in the project's symbol index. */
function symbolExists(projectId: string, name: string): boolean {
  try {
    return searchSymbols(projectId, name, { limit: 5 }).some((s) => s.name === name)
  } catch {
    return false
  }
}

/**
 * Anchors for a new capture: HEAD, plus the first identifier in the content
 * that the symbol index knows. Symbol lookup is skipped when there is no
 * index or no project id — never blocks a capture.
 */
export async function resolveAnchors(
  projectPath: string,
  projectId: string | undefined,
  content: string
): Promise<ResolvedAnchors> {
  const anchors: ResolvedAnchors = {}
  const sha = await headSha(projectPath)
  if (sha) anchors.commit = sha
  if (projectId && hasSymbolIndex(projectId)) {
    const candidates = [...new Set(content.match(SYMBOL_TOKEN_RE) ?? [])].slice(0, 8)
    const hit = candidates.find((c) => symbolExists(projectId, c))
    if (hit) anchors.symbol = hit
  }
  return anchors
}

/**
 * True when the anchored file is gone AND git does not know it under a new
 * name (a rename keeps the knowledge valid). One bounded git call per entry.
 */
async function fileAnchorGone(projectPath: string, file: string): Promise<boolean> {
  if (fs.existsSync(path.join(projectPath, file))) return false
  try {
    // Rename detection needs BOTH sides of the diff, so no pathspec (a
    // pathspec on the old name reduces the rename to a plain deletion).
    // Bounded to recent history; the line reads `R100\told\tnew`.
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-100', '-M', '--name-status', '--diff-filter=R', '--format='],
      { cwd: projectPath }
    )
    const line = String(stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^R\d*\t/.test(l) && l.split('\t')[1] === file)
    const renamedTo = line?.split('\t')[2]
    return !(renamedTo && fs.existsSync(path.join(projectPath, renamedTo)))
  } catch {
    return true
  }
}

export interface AnchorSweepResult {
  checked: number
  markedStale: number
  cleared: number
}

/**
 * Re-check anchors on recent file-tagged entries and persist the verdict:
 * `stale_at` set when the anchor no longer resolves, cleared when it does
 * again (a restored file un-stales its knowledge).
 */
export async function markStaleMemoryAnchors(
  projectId: string,
  projectPath: string,
  entries?: MemoryEntry[]
): Promise<AnchorSweepResult> {
  const { projectMemory } = await import('./project-memory')
  const pool = (entries ?? projectMemory.recall(projectId, { limit: SWEEP_LIMIT })).filter(
    (e) => typeof e.tags?.file === 'string' && e.tags.file.length > 0
  )
  const indexed = hasSymbolIndex(projectId)
  const result: AnchorSweepResult = { checked: 0, markedStale: 0, cleared: 0 }
  for (const entry of pool) {
    result.checked += 1
    const fileGone = await fileAnchorGone(projectPath, entry.tags.file as string)
    const symbolGone =
      indexed &&
      typeof entry.tags.symbol === 'string' &&
      !symbolExists(projectId, entry.tags.symbol)
    const stale = fileGone || symbolGone
    if (stale && !entry.staleAt) {
      prjctDb.run(
        projectId,
        'UPDATE memory_entries SET stale_at = ? WHERE id = ?',
        Date.now(),
        entry.id
      )
      result.markedStale += 1
    } else if (!stale && entry.staleAt) {
      prjctDb.run(projectId, 'UPDATE memory_entries SET stale_at = NULL WHERE id = ?', entry.id)
      result.cleared += 1
    }
  }
  return result
}

/** Count of live entries currently marked stale — for `harness audit`. */
export function staleAnchorCount(projectId: string): number {
  try {
    const row = prjctDb.get<{ n: number }>(
      projectId,
      'SELECT COUNT(*) AS n FROM memory_entries WHERE deleted_at IS NULL AND stale_at IS NOT NULL'
    )
    return row?.n ?? 0
  } catch {
    return 0
  }
}
