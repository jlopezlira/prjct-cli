/**
 * Session cleanup — runs at the end of every Claude Code session
 * (Stop hook). Trims age-out inbox items, prunes old archives /
 * checkpoints, and rotates stale on-disk caches. Best-effort
 * everywhere — a failure on one step does not block the rest.
 *
 * Configurable via env var `PRJCT_CLEANUP_AGGRESSIVENESS` ∈
 * { conservative | standard | aggressive }. Default `standard`.
 *
 * Aggressiveness profile (days before each rule fires):
 *   conservative: inbox 30, archives 180, checkpoints disabled
 *   standard:     inbox 14, archives 90,  checkpoints 30
 *   aggressive:   inbox 7,  archives 30,  checkpoints 14
 *
 * Returns a `CleanupReport` summarising what got moved/deleted so
 * the next session-start hook can surface a one-line summary.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { DAEMON_PATHS } from '../daemon/protocol'
import pathManager from '../infrastructure/path-manager'
import { memoryFingerprint } from '../memory/content-fingerprint'
import { projectMemory } from '../memory/project-memory'
import { archiveStorage } from '../storage/archive-storage'
import prjctDb from '../storage/database'

export type CleanupAggressiveness = 'conservative' | 'standard' | 'aggressive'

export interface CleanupReport {
  inboxArchived: number
  archivesPruned: number
  checkpointsRemoved: number
  context7CacheRotated: boolean
  stampsRemoved: number
}

interface CleanupProfile {
  inboxDays: number
  archivesDays: number
  /** null = never prune checkpoints. */
  checkpointsDays: number | null
}

const PROFILES: Record<CleanupAggressiveness, CleanupProfile> = {
  conservative: { inboxDays: 30, archivesDays: 180, checkpointsDays: null },
  standard: { inboxDays: 14, archivesDays: 90, checkpointsDays: 30 },
  aggressive: { inboxDays: 7, archivesDays: 30, checkpointsDays: 14 },
}

export function resolveProfile(env: NodeJS.ProcessEnv = process.env): CleanupProfile {
  const value = (env.PRJCT_CLEANUP_AGGRESSIVENESS ?? 'standard').toLowerCase()
  const aggressiveness =
    value === 'conservative' || value === 'standard' || value === 'aggressive'
      ? (value as CleanupAggressiveness)
      : 'standard'
  return PROFILES[aggressiveness]
}

/**
 * Archive inbox memory entries older than `inboxDays`. The entries are
 * NOT deleted — they go to the `archives` table (restorable) and the
 * vault regen will drop them from the active list.
 */
async function archiveAgedInbox(projectId: string, inboxDays: number): Promise<number> {
  const cutoff = Date.now() - inboxDays * 24 * 60 * 60 * 1000
  const candidates = projectMemory.recall(projectId, { types: ['inbox'], limit: 200 })
  const aged = candidates.filter((e) => Date.parse(e.rememberedAt) < cutoff)
  if (aged.length === 0) return 0

  // Move to archive and tombstone the original event so recall stops
  // returning it. archive-storage stores the full payload so a future
  // `prjct restore` (not yet implemented as a top-level CLI) can lift
  // it back if the user changes their mind.
  const movedEntryIds: string[] = []
  for (const entry of aged) {
    try {
      archiveStorage.archive(projectId, {
        entityType: 'memory_entry',
        entityId: entry.id,
        entityData: {
          type: entry.type,
          content: entry.content,
          tags: entry.tags,
          rememberedAt: entry.rememberedAt,
        },
        summary: entry.content.slice(0, 80),
        reason: `inbox-age-out (>${inboxDays}d)`,
      })
      // Tombstone via type rewrite so recall's `type IN (...)` filter
      // skips it. Keeps the row for forensic recovery.
      const numericId = entry.id.startsWith('mem_') ? entry.id.slice(4) : null
      if (numericId) {
        prjctDb.run(
          projectId,
          'UPDATE events SET type = ? WHERE id = ?',
          'memory.archived.inbox',
          Number(numericId)
        )
      }
      // Schema v2: drop it from the normalized table recall now reads.
      prjctDb.run(
        projectId,
        'UPDATE memory_entries SET deleted_at = ? WHERE id = ?',
        Date.now(),
        entry.id
      )
      movedEntryIds.push(entry.id)
    } catch {
      // Per-entry failures are silent — keeping the loop moving is
      // more useful than failing the whole cleanup.
    }
  }
  return movedEntryIds.length
}

/**
 * Delete checkpoint files at
 * `~/.prjct-cli/projects/<projectId>/checkpoints/` whose mtime is
 * older than `daysOld`. Only the file is removed; nothing else
 * depends on the on-disk artifact.
 */
async function pruneOldCheckpoints(projectId: string, daysOld: number | null): Promise<number> {
  if (daysOld === null) return 0
  const dir = path.join(pathManager.getGlobalProjectPath(projectId), 'checkpoints')
  const entries = await fs.readdir(dir).catch(() => null)
  if (!entries) return 0
  const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000
  const removedFiles: string[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const full = path.join(dir, name)
    try {
      const stat = await fs.stat(full)
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(full)
        removedFiles.push(full)
      }
    } catch {
      /* skip */
    }
  }
  return removedFiles.length
}

/**
 * The context7 verify cache is TTL-bound at 5 minutes (the value),
 * but the FILE itself can stick around for weeks if the user stops
 * running prjct sync. Rotate the file (delete; next call rebuilds it
 * fresh) when it's older than 7 days, regardless of TTL.
 */
async function rotateContext7Cache(): Promise<boolean> {
  // Same path the writer uses (context7-service) — they had drifted: this
  // copy used raw os.homedir() while the writer honors NODE_ENV=test +
  // PRJCT_CLI_HOME, so test runs rotated the user's REAL cache file.
  const { getVerifyCachePath } = await import('./context7-service')
  const file = getVerifyCachePath()
  try {
    const stat = await fs.stat(file)
    const ageDays = (Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000)
    if (ageDays > 7) {
      await fs.unlink(file)
      return true
    }
  } catch {
    /* file missing is the expected fresh-install state */
  }
  return false
}

/**
 * Hook stamps in the daemon run dir are written per session/project and were
 * never deleted — over months the run dir accumulates thousands of stale
 * files. None of them is useful past a day: payload hashes + afterEmit
 * records + git snapshots are turn-scoped, the stop-heavy stamp is a
 * 10-minute cooldown, and kimi session stamps are consumed on the first
 * prompt. Sweep by mtime; never touch daemon.pid/log/sock.
 */
const STAMP_TTL_MS = 24 * 60 * 60 * 1000
const STAMP_PREFIXES = [
  'prompt-state-',
  'prompt-git-',
  'prompt-afteremit-',
  'prompt-scc-',
  'scc-',
  'stop-heavy-',
  'kimi-session-',
]

async function sweepRunDirStamps(): Promise<number> {
  const dir = DAEMON_PATHS.runDir()
  const entries = await fs.readdir(dir).catch(() => null)
  if (!entries) return 0
  const cutoff = Date.now() - STAMP_TTL_MS
  const removedFiles: string[] = []
  for (const name of entries) {
    if (!STAMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    const full = path.join(dir, name)
    try {
      const stat = await fs.stat(full)
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(full)
        removedFiles.push(full)
      }
    } catch {
      /* skip */
    }
  }
  return removedFiles.length
}

/**
 * Run all cleanup steps. Each step is independent — the caller gets a
 * full report even when some steps fail silently. Safe to invoke from
 * the Stop hook.
 */
export async function runSessionCleanup(projectId: string): Promise<CleanupReport> {
  const profile = resolveProfile()
  const report: CleanupReport = {
    inboxArchived: 0,
    archivesPruned: 0,
    checkpointsRemoved: 0,
    context7CacheRotated: false,
    stampsRemoved: 0,
  }

  try {
    report.inboxArchived = await archiveAgedInbox(projectId, profile.inboxDays)
  } catch {
    /* keep going */
  }
  try {
    report.archivesPruned = archiveStorage.pruneOldArchives(projectId, profile.archivesDays)
  } catch {
    /* keep going */
  }
  try {
    report.checkpointsRemoved = await pruneOldCheckpoints(projectId, profile.checkpointsDays)
  } catch {
    /* keep going */
  }
  try {
    report.context7CacheRotated = await rotateContext7Cache()
  } catch {
    /* keep going */
  }
  try {
    report.stampsRemoved = await sweepRunDirStamps()
  } catch {
    /* keep going */
  }

  return report
}

/**
 * Persist the cleanup report so the next session-start hook can
 * surface it as a one-liner. Stored as a memory entry with a
 * predictable key — the surface code just queries by tag.
 */
export async function recordCleanupReport(projectId: string, report: CleanupReport): Promise<void> {
  const total =
    report.inboxArchived +
    report.archivesPruned +
    report.checkpointsRemoved +
    report.stampsRemoved +
    (report.context7CacheRotated ? 1 : 0)
  if (total === 0) return // nothing to surface

  const summary = [
    report.inboxArchived > 0 ? `${report.inboxArchived} inbox archived` : null,
    report.archivesPruned > 0 ? `${report.archivesPruned} archives pruned` : null,
    report.checkpointsRemoved > 0 ? `${report.checkpointsRemoved} checkpoints removed` : null,
    report.stampsRemoved > 0 ? `${report.stampsRemoved} stale hook stamps removed` : null,
    report.context7CacheRotated ? 'context7 cache rotated' : null,
  ]
    .filter((s): s is string => Boolean(s))
    .join(', ')

  // memory_entries (Schema v2) is kept in sync by the memory_entries_from_events
  // trigger — this direct remember-event write is mirrored there automatically.
  // Carry content_hash + project_id so the trigger writes correct dedup keys.
  const cleanupContent = `Session cleanup: ${summary}`
  prjctDb.appendEvent(projectId, 'memory.remember.system-event', {
    content: cleanupContent,
    tags: { source: 'session-cleanup', key: 'last-cleanup' },
    provenance: 'extracted',
    content_hash: memoryFingerprint(cleanupContent),
    project_id: projectId,
  })
}
