/**
 * Single-flight spawn lock for the prjct daemon.
 *
 * Concurrent clients (hooks + CLI + post-upgrade) all call spawnDaemon()
 * when the socket is missing. Without a lock, two processes both unlink the
 * socket, both bind, and the loser (or worse: a stolen Unix socket) leaves
 * "Failed to listen" / "chmod ENOENT" noise in daemon.log — observed in
 * production under session storms.
 *
 * Exclusive create (O_EXCL / 'wx') is the mutex. Stale locks from a killed
 * spawner are reclaimed when the holder PID is no longer alive.
 */

import fs from 'node:fs'
import path from 'node:path'
import { DAEMON_PATHS } from './protocol'
import { isProcessRunning } from './staleness'

export function spawnLockPath(runDir: string = DAEMON_PATHS.runDir()): string {
  return path.join(runDir, 'daemon.spawn.lock')
}

export interface SpawnLockHandle {
  fd: number
  path: string
}

/**
 * Try to acquire the exclusive spawn lock.
 * Returns a handle on success, null if another live process holds it.
 */
export function tryAcquireSpawnLock(
  runDir: string = DAEMON_PATHS.runDir(),
  pid: number = process.pid
): SpawnLockHandle | null {
  fs.mkdirSync(runDir, { recursive: true })
  const lockPath = spawnLockPath(runDir)

  for (const _ of [0, 1]) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      try {
        fs.writeFileSync(fd, `${pid}\n`)
      } catch {
        try {
          fs.closeSync(fd)
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(lockPath)
        } catch {
          /* ignore */
        }
        return null
      }
      return { fd, path: lockPath }
    } catch {
      // Lock exists — reclaim if the holder is dead, otherwise yield.
      const holderPid = (() => {
        try {
          return parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10)
        } catch {
          return null
        }
      })()

      if (holderPid && !Number.isNaN(holderPid) && isProcessRunning(holderPid)) {
        return null
      }

      // Stale lock (dead holder or unreadable) — remove and retry once.
      try {
        fs.unlinkSync(lockPath)
      } catch {
        return null
      }
    }
  }

  return null
}

export function releaseSpawnLock(handle: SpawnLockHandle | null): void {
  if (!handle) return
  try {
    fs.closeSync(handle.fd)
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(handle.path)) {
      const content = fs.readFileSync(handle.path, 'utf-8').trim()
      // Only unlink if we still own it (another process shouldn't, but be safe).
      if (content === String(process.pid) || content === `${process.pid}`) {
        fs.unlinkSync(handle.path)
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Pure decision for a listen failure: if the endpoint is already serving
 * (we lost the race), exit cleanly as success; otherwise treat as fatal.
 */
export function decideListenFailure(opts: {
  errorCode?: string
  errorMessage: string
  peerHealthy: boolean
}): { exitCode: number; reason: string } {
  const code = opts.errorCode ?? ''
  const msg = opts.errorMessage
  const addrInUse =
    code === 'EADDRINUSE' ||
    msg.includes('EADDRINUSE') ||
    msg.includes('address already in use') ||
    msg.includes('Failed to listen')

  if (addrInUse && opts.peerHealthy) {
    return { exitCode: 0, reason: 'lost-spawn-race-peer-healthy' }
  }
  if (addrInUse) {
    return { exitCode: 1, reason: 'listen-failed-no-peer' }
  }
  return { exitCode: 1, reason: 'listen-error' }
}
