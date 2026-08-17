/**
 * Hook stdin spill — recovery channel for the native hook-fast punt.
 *
 * The installed hook command is a shell `||` chain (see
 * core/services/hook-command.ts): native hook-fast → runtime+shim →
 * portable `prjct hook X`. Once hook-fast has READ stdin, the next stage's
 * stdin pipe is drained — a naive `||` fallback would silently run with an
 * empty payload. hook-fast therefore SPILLS the payload to a deterministic
 * scratch file in the daemon run dir before punting (exit 89, no output),
 * and every portable stdin reader below checks for a fresh spill first:
 *
 *   <runDir>/hook-stdin-<fnv1a32hex(cwd)>-<subcommand>.json
 *
 * Deterministic (no pid, no env hand-off) because a C process cannot export
 * env vars to the next command in the chain — both sides must compute the
 * path independently. The fnv1a-32 hex of the cwd UTF-8 bytes is mirrored
 * byte-for-byte in native/hook-fast.c; change one, change the other.
 *
 * Collision note: two concurrent sessions in the SAME cwd firing the SAME
 * subcommand share one spill path. Acceptable — a spill only exists when
 * hook-fast already failed, the loser overwrites the winner's identical-
 * shaped event payload, and the next real hook fire regenerates context.
 *
 * Freshness: consumers accept a spill only when its mtime is within
 * HOOK_STDIN_SPILL_MAX_AGE_MS (the shell starts the fallback the moment
 * hook-fast exits, so a legit spill is milliseconds old) and UNLINK it on
 * read, so a stale spill from a crashed chain can never hijack a later,
 * unrelated hook fire's stdin.
 */

import fs from 'node:fs'
import path from 'node:path'
import { getDaemonRunDir } from '../daemon/protocol'

/** Max age of a spill file a consumer will honor (and then delete). */
export const HOOK_STDIN_SPILL_MAX_AGE_MS = 30_000

/** fnv1a-32 over the UTF-8 bytes of `input`, 8-char lowercase hex.
 * MUST match fnv1a32() in native/hook-fast.c exactly. */
function fnv1a32hex(input: string): string {
  const hash = Buffer.from(input, 'utf-8').reduce(
    (acc, byte) => Math.imul(acc ^ byte, 16777619) >>> 0,
    2166136261
  )
  return hash.toString(16).padStart(8, '0')
}

/** Mirrors the subcommand sanitizer in native/hook-fast.c (lowercase [a-z0-9-]). */
function sanitizeSubcommand(subcommand: string): string {
  return subcommand.toLowerCase().replace(/[^a-z0-9-]/g, '')
}

/** Deterministic spill path for a (cwd, subcommand) pair, or null when the
 * subcommand has no safe filename characters. */
export function hookStdinSpillPath(cwd: string, subcommand: string): string | null {
  const sub = sanitizeSubcommand(subcommand)
  if (!sub) return null
  return path.join(getDaemonRunDir(), `hook-stdin-${fnv1a32hex(cwd)}-${sub}.json`)
}

/**
 * Read + delete a fresh spill for (cwd, subcommand). Returns null when no
 * spill exists, the spill is stale (also deleted — GC for crashed chains),
 * or any fs operation fails. Never throws: hooks are fail-soft.
 */
export function consumeHookStdinSpill(cwd: string, subcommand: string): string | null {
  const spillPath = hookStdinSpillPath(cwd, subcommand)
  if (!spillPath) return null
  try {
    const stat = fs.statSync(spillPath)
    if (Date.now() - stat.mtimeMs > HOOK_STDIN_SPILL_MAX_AGE_MS) {
      fs.unlinkSync(spillPath)
      return null
    }
    const payload = fs.readFileSync(spillPath, 'utf-8')
    fs.unlinkSync(spillPath)
    return payload
  } catch {
    return null
  }
}

/**
 * Best-effort spill write for the runtime+shim chain stage: when the shim's
 * own daemon request fails after it read the payload (from stdin or from a
 * spill), it re-spills and punts so the portable stage behind it can still
 * recover. Never throws.
 */
export function writeHookStdinSpill(cwd: string, subcommand: string, payload: string): void {
  const spillPath = hookStdinSpillPath(cwd, subcommand)
  if (!spillPath) return
  try {
    fs.mkdirSync(path.dirname(spillPath), { recursive: true })
    fs.writeFileSync(spillPath, payload, 'utf-8')
  } catch {
    // fail-soft — a missed spill just means the old behavior (no recovery)
  }
}
