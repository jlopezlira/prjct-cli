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

/** True-LRU touch: refresh recency on hit, evict oldest past the cap. */
function ledgerSet(map: Map<string, string>, key: string, value: string, max: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
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
  const partitioned = entries.reduce<CondensedDelivery<T>>(
    (acc, entry) => {
      const key = `${scope}:${entry.id}`
      const hash = hashContent(entry.content)
      const isRepeat = !opts.full && deliveredLedger.get(key) === hash
      ledgerSet(deliveredLedger, key, hash, DELIVERED_LEDGER_MAX)
      if (isRepeat) acc.repeats.push(entry)
      else acc.fresh.push(entry)
      return acc
    },
    { fresh: [], repeats: [] }
  )
  return partitioned
}

/**
 * Single-blob variant of the ledger for MCP tool results: an unchanged
 * repeat collapses the whole result to a one-line pointer that carries the
 * re-fetch instruction. Session-scoped by process lifetime (stdio MCP).
 */
export function condenseResult(
  scope: string,
  id: string,
  content: string,
  opts: { full?: boolean } = {}
): { text: string; repeated: boolean; hash: string } {
  const key = `${scope}:${id}`
  const hash = hashContent(content)
  const repeated = !opts.full && deliveredLedger.get(key) === hash
  ledgerSet(deliveredLedger, key, hash, DELIVERED_LEDGER_MAX)
  if (!repeated) return { text: content, repeated, hash }
  return {
    text: `_${id} unchanged since last delivery this session (hash ${hash.slice(0, 8)}) — pass full:true to re-fetch._`,
    repeated,
    hash,
  }
}

/** Test seam: reset the in-process ledgers. */
export function _resetDeliveredLedgerForTests(): void {
  deliveredLedger.clear()
  gateL1.clear()
}

// ---------------------------------------------------------------------------
// Universal delivery gate — the ONE primitive every prjct→agent emission
// flows through. Hooks and CLI use durable session stamps (hook processes
// are ephemeral); MCP keeps using the in-process ledger above. Suppression
// is sessionId-scoped by default; without session identity only explicitly
// static content may be suppressed (short TTL) so two concurrent agents in
// one repo never steal each other's context.
// ---------------------------------------------------------------------------

export type DeliverySurface =
  | 'session-start'
  | 'prompt-state'
  | 'prompt-cues'
  | 'pre-search'
  | 'pre-edit'
  | 'pre-bash-commit'
  | 'cwd-changed'
  | 'mcp-result'
  | 'cli-work'
  | 'cli-prime'
  | 'cli-sync'
  | 'cli-search'
  | 'cli-context'

export interface GateRequest {
  projectId: string
  projectPath: string
  sessionId: string | undefined
  surface: DeliverySurface
  /** Sub-key inside the surface: file path, search token, tool id… */
  key?: string
  content: string
  /** Strips per-turn counter noise before hashing (default: identity). */
  normalize?: (content: string) => string
  /** Escape hatch: always emit, still restamp. */
  full?: boolean
  /** Policy when sessionId is undefined. Default: emit (never suppress). */
  noSession?: { mode: 'emit' } | { mode: 'memory' } | { mode: 'static'; ttlMs: number }
  /** Pointer text on suppression; default → emit null. */
  onRepeat?: (hash: string) => string
}

export interface GateResult {
  emit: string | null
  suppressed: boolean
  hash: string
  emittedChars: number
}

/** Gate stamp prefix — swept by session-cleanup's run-dir GC (24h TTL). */
const GATE_STAMP_PREFIX = 'scc-'
const GATE_L1_MAX = 256
const GATE_KEYED_MAX_ENTRIES = 200

/** In-process fast path over the disk stamps (warm daemon). */
const gateL1 = new Map<string, string>()

interface GateStampEntry {
  h: string
  t: number
}

function gateStampPath(stampKey: string, surface: DeliverySurface, keyed: boolean): string {
  const ext = keyed ? 'json' : 'hash'
  return path.join(DAEMON_PATHS.runDir(), `${GATE_STAMP_PREFIX}${stampKey}-${surface}.${ext}`)
}

async function readGateFile(target: string): Promise<Record<string, GateStampEntry> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(target, 'utf-8')) as Record<string, GateStampEntry>
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

async function writeGateFile(target: string, map: Record<string, GateStampEntry>): Promise<void> {
  const entries = Object.entries(map)
  const bounded =
    entries.length > GATE_KEYED_MAX_ENTRIES
      ? Object.fromEntries(entries.slice(entries.length - GATE_KEYED_MAX_ENTRIES))
      : map
  await fs
    .mkdir(path.dirname(target), { recursive: true })
    .then(() => fs.writeFile(target, JSON.stringify(bounded)))
    .catch(() => undefined)
}

function emitResult(content: string, hash: string): GateResult {
  return { emit: content, suppressed: false, hash, emittedChars: content.length }
}

function suppressResult(hash: string, onRepeat?: (hash: string) => string): GateResult {
  const pointer = onRepeat ? onRepeat(hash) : null
  return { emit: pointer, suppressed: true, hash, emittedChars: pointer?.length ?? 0 }
}

/**
 * Deliver-once gate. Emits `content` when it was never delivered under this
 * (session, surface, key) or when it materially changed; suppresses repeats.
 * Fail-soft: any storage error emits. `full` always emits and restamps.
 */
export async function gateDelivery(req: GateRequest): Promise<GateResult> {
  try {
    const hash = hashContent((req.normalize ?? ((c: string) => c))(req.content))
    const policy = req.sessionId === undefined ? (req.noSession ?? { mode: 'emit' }) : null
    if (policy?.mode === 'emit') return emitResult(req.content, hash)

    const stampKey = sessionStampKey(req.projectId, req.projectPath, req.sessionId)
    const subKey = req.key ? hashContent(req.key).slice(0, 16) : '_'
    const l1Key = `${stampKey}:${req.surface}:${subKey}`
    const ttlMs = policy?.mode === 'static' ? policy.ttlMs : null
    const now = Date.now()

    if (policy?.mode === 'memory') {
      const repeat = !req.full && gateL1.get(l1Key) === hash
      ledgerSet(gateL1, l1Key, hash, GATE_L1_MAX)
      return repeat ? suppressResult(hash, req.onRepeat) : emitResult(req.content, hash)
    }

    // Session-scoped (durable) and static-TTL paths share the disk stamp;
    // the L1 map only short-circuits the non-TTL session path (TTL needs
    // the per-entry timestamp, which lives on disk).
    if (ttlMs === null && !req.full && gateL1.get(l1Key) === hash) {
      ledgerSet(gateL1, l1Key, hash, GATE_L1_MAX)
      return suppressResult(hash, req.onRepeat)
    }

    const target = gateStampPath(stampKey, req.surface, true)
    const stored = (await readGateFile(target)) ?? {}
    const entry = stored[subKey]
    const fresh = entry === undefined || entry.h !== hash
    const expired = ttlMs !== null && entry !== undefined && now - entry.t > ttlMs
    const suppress = !req.full && !fresh && !expired

    delete stored[subKey]
    stored[subKey] = { h: hash, t: now } // re-insert last: insertion-order eviction keeps hot keys
    await writeGateFile(target, stored)
    if (ttlMs === null) ledgerSet(gateL1, l1Key, hash, GATE_L1_MAX)

    return suppress ? suppressResult(hash, req.onRepeat) : emitResult(req.content, hash)
  } catch {
    return { emit: req.content, suppressed: false, hash: '', emittedChars: req.content.length }
  }
}

/**
 * Durable per-entry ledger (CLI surfaces): same partition contract as
 * condenseDelivered, backed by the keyed gate stamp so it survives the
 * per-invocation CLI process. No session identity → everything fresh.
 */
export async function condenseDeliveredDurable<T extends DeliverableEntry>(
  scope: {
    projectId: string
    projectPath: string
    sessionId: string | undefined
    surface: DeliverySurface
  },
  entries: T[],
  opts: { full?: boolean } = {}
): Promise<CondensedDelivery<T>> {
  if (scope.sessionId === undefined) return { fresh: entries, repeats: [] }
  try {
    const stampKey = sessionStampKey(scope.projectId, scope.projectPath, scope.sessionId)
    const target = gateStampPath(stampKey, scope.surface, true)
    const stored = (await readGateFile(target)) ?? {}
    const now = Date.now()
    const partitioned = entries.reduce<CondensedDelivery<T>>(
      (acc, entry) => {
        const subKey = hashContent(entry.id).slice(0, 16)
        const hash = hashContent(entry.content)
        const isRepeat = !opts.full && stored[subKey]?.h === hash
        delete stored[subKey]
        stored[subKey] = { h: hash, t: now }
        if (isRepeat) acc.repeats.push(entry)
        else acc.fresh.push(entry)
        return acc
      },
      { fresh: [], repeats: [] }
    )
    await writeGateFile(target, stored)
    return partitioned
  } catch {
    return { fresh: entries, repeats: [] }
  }
}
