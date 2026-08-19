/**
 * Session Context Cache — prjct's own "prompt cache" for hosts that lack one.
 *
 * Kimi/Codex re-send the whole conversation history on every API call, so
 * every byte prjct injects is re-paid until the session ends. This module is
 * the per-session ledger of what prjct already delivered:
 *
 *   - Hooks side (disk): hook processes are ephemeral, so stamps live in the
 *     daemon run dir, keyed by project+cwd+session. The prompt hook uses them
 *     to re-emit the state block only on MATERIAL change (delta emission).
 *   - MCP side (memory): stdio MCP servers are spawned one per host session,
 *     so a plain in-process map is naturally session-scoped. Tools use it to
 *     collapse already-delivered entries into one-line refs.
 *
 * Escape hatch: host-side compaction can evict content the ledger believes
 * delivered — refs always carry the re-fetchable id, and MCP callers can pass
 * full=true to bypass the ledger.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DAEMON_PATHS } from '../daemon/protocol'

/** Stamp filename prefix — also listed in session-cleanup's STAMP_PREFIXES,
 *  which owns run-dir GC (the Stop-hook sweep); no purge logic lives here. */
const STAMP_PREFIX = 'prompt-scc-'

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Filesystem-safe stamp key scoped to project + cwd + host session. */
export function sessionStampKey(
  projectId: string,
  projectPath: string,
  sessionId: string | undefined
): string {
  const cwd = createHash('sha1').update(path.resolve(projectPath)).digest('hex').slice(0, 12)
  const session = createHash('sha1')
    .update(sessionId ?? 'no-session')
    .digest('hex')
    .slice(0, 12)
  return `${projectId.replace(/[^a-zA-Z0-9._-]/g, '_')}-${cwd}-${session}`
}

function stampPath(key: string): string {
  return path.join(DAEMON_PATHS.runDir(), `${STAMP_PREFIX}${key}.hash`)
}

export async function readSessionStamp(key: string): Promise<string | null> {
  try {
    return (await fs.readFile(stampPath(key), 'utf-8')).trim()
  } catch {
    return null
  }
}

export async function writeSessionStamp(key: string, value: string): Promise<void> {
  const target = stampPath(key)
  await fs
    .mkdir(path.dirname(target), { recursive: true })
    .then(() => fs.writeFile(target, value))
    .catch(() => undefined)
}

/**
 * Normalize away per-turn counter noise before hashing the state block, so
 * "3 modified" → "4 modified" (every agent edit) or "16 turns" → "17 turns"
 * (every prompt) does not count as material change. A cue APPEARING or
 * DISAPPEARING still flips the hash — the model sees each escalation once —
 * while branch switches, cycle changes, and threshold crossings stay material.
 */
export function normalizeStateForMaterialChange(state: string): string {
  return (
    state
      // Unpushed FIRST and count-only: its comma-joined form rides the same
      // line as the working-tree segment, and the greedy working-tree rule
      // would swallow it — presence/absence of unpushed commits IS material.
      .replace(/, (\d+) unpushed/g, ', unpushed')
      .replace(/ — working tree [^\n]*?(, unpushed)?$/gm, (_m, unpushed) =>
        unpushed ? ' — working tree dirty, unpushed' : ' — working tree dirty'
      )
      .replace(/ — \d+ unpushed/g, ' — unpushed')
      .replace(/Inbox: \d+ items pending/g, 'Inbox: pending')
      .replace(/Turn \d+ on this cycle/g, 'Turn ~ on this cycle')
      .replace(/\d+ turns on this cycle/g, '~ turns on this cycle')
      .replace(/context density \(high ~\d+%\)/g, 'context density (high)')
      .replace(/context density \(~\d+%\)/g, 'context density (warn)')
      .replace(/[\d,]+ of [\d,]+ \(\d+%\)/g, '~ of budget')
      .replace(/[\d,]+ of [\d,]+ spent/g, '~ of budget spent')
  )
}

// ---------------------------------------------------------------------------
// MCP side — in-process delivered-content ledger.
// ---------------------------------------------------------------------------

const DELIVERED_LEDGER_MAX = 512
const deliveredLedger = new Map<string, string>()

export interface DeliverableEntry {
  id: string
  content: string
}

export interface CondensedDelivery<T extends DeliverableEntry> {
  /** Entries not yet delivered this session — render in full. */
  fresh: T[]
  /** Entries already delivered verbatim this session — render as one-line refs. */
  repeats: T[]
}

/**
 * Partition entries into fresh vs already-delivered for this session and
 * record the fresh ones. `full: true` bypasses the ledger (still records),
 * for when the host compacted its context.
 */
export function condenseDelivered<T extends DeliverableEntry>(
  scope: string,
  entries: T[],
  opts: { full?: boolean } = {}
): CondensedDelivery<T> {
  if (deliveredLedger.size > DELIVERED_LEDGER_MAX) deliveredLedger.clear()
  const partitioned = entries.reduce<CondensedDelivery<T>>(
    (acc, entry) => {
      const key = `${scope}:${entry.id}`
      const hash = hashContent(entry.content)
      const isRepeat = !opts.full && deliveredLedger.get(key) === hash
      deliveredLedger.set(key, hash)
      if (isRepeat) acc.repeats.push(entry)
      else acc.fresh.push(entry)
      return acc
    },
    { fresh: [], repeats: [] }
  )
  return partitioned
}

/** Test seam: reset the in-process ledger. */
export function _resetDeliveredLedgerForTests(): void {
  deliveredLedger.clear()
}
