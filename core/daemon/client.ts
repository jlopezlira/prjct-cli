/**
 * Daemon Client
 *
 * Thin client that connects to the daemon over Unix socket.
 * Used by the CLI entry point to route commands through the daemon
 * for near-zero startup latency.
 *
 * Falls back to direct execution if the daemon is not running.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import { connect } from 'node:net'
import path from 'node:path'
import type { DaemonRequest, DaemonResponse, DaemonStatus } from '../types/daemon'
import { isBunAvailable } from '../utils/runtime'
import { commandRequestTimeoutMs, DAEMON_PATHS, encodeMessage, isDaemonNamedPipe } from './protocol'
import { releaseSpawnLock, tryAcquireSpawnLock } from './startup-lock'

function systemErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/** Only these connect failures prove that no live process owns the endpoint. */
export function shouldUnlinkDaemonSocket(error: unknown): boolean {
  const code = systemErrorCode(error)
  return code === 'ENOENT' || code === 'ECONNREFUSED'
}

/**
 * Check if the daemon is running (socket file exists + responds to ping)
 */
export async function isDaemonRunning(): Promise<boolean> {
  const socketPath = DAEMON_PATHS.socket()

  const namedPipe = isDaemonNamedPipe(socketPath)

  // Quick check: Unix sockets are filesystem entries; Windows named pipes are not.
  if (!namedPipe && !fs.existsSync(socketPath)) return false

  // Verify: can we actually connect and get a response?
  // Short timeout — a hung daemon must not stall spawn/health for 30s.
  try {
    const response = await sendRequest(
      {
        id: crypto.randomUUID(),
        command: '__ping',
        args: [],
        options: {},
        cwd: process.cwd(),
      },
      { timeoutMs: 1_000 }
    )
    return response.success
  } catch (error) {
    // Only remove an endpoint when the OS proves there is no listener.
    // Permission errors (sandbox EACCES/EPERM), timeouts, and malformed
    // responses do not prove staleness and must not steal a live daemon's
    // socket. Named pipes are not unlinkable files.
    if (!namedPipe && shouldUnlinkDaemonSocket(error)) {
      try {
        fs.unlinkSync(socketPath)
      } catch {
        /* ignore */
      }
    }
    return false
  }
}

/**
 * Get daemon status
 */
export async function getDaemonStatus(): Promise<DaemonStatus> {
  const socketPath = DAEMON_PATHS.socket()
  const pidPath = DAEMON_PATHS.pid()

  const namedPipe = isDaemonNamedPipe(socketPath)

  if (!namedPipe && !fs.existsSync(socketPath)) {
    return { running: false }
  }

  try {
    const response = await sendRequest({
      id: crypto.randomUUID(),
      command: 'daemon',
      args: ['status'],
      options: {},
      cwd: process.cwd(),
    })

    if (response.success && response.result) {
      return response.result as DaemonStatus
    }
  } catch {
    // Daemon not responding
  }

  // Check PID file as fallback
  if (fs.existsSync(pidPath)) {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)
    return { running: false, pid, socketPath }
  }

  return { running: false }
}

export interface SendRequestOptions {
  /**
   * Override the default timeout. Defaults come from
   * `commandRequestTimeoutMs(command)` (hooks 800ms, long verbs 10min, else 30s).
   */
  timeoutMs?: number
}

/**
 * Send a command to the daemon and return the response.
 * Default budget: hooks 800ms, ship/sync/dream… 10min, everything else 30s.
 * Callers can still override with `timeoutMs`.
 */
export function sendRequest(
  request: DaemonRequest,
  options: SendRequestOptions = {}
): Promise<DaemonResponse> {
  const timeoutMs = options.timeoutMs ?? commandRequestTimeoutMs(request.command)

  return new Promise((resolve, reject) => {
    const socketPath = DAEMON_PATHS.socket()
    const socket = connect(socketPath)
    const chunks: string[] = []
    const completion = new AbortController()

    const timeout = setTimeout(() => {
      if (!completion.signal.aborted) {
        completion.abort()
        socket.destroy()
        reject(
          new Error(
            `Daemon request timed out; operation ${request.id}. Resume the same command with --operation-id=${request.id}; add --operation-status to inspect.`
          )
        )
      }
    }, timeoutMs)

    socket.on('connect', () => {
      socket.write(encodeMessage(request))
    })

    socket.on('data', (chunk) => {
      chunks.push(chunk.toString())
      const buffer = chunks.join('')

      // Guard against a runaway response (malformed / hostile peer).
      if (buffer.length > 8 * 1024 * 1024) {
        if (!completion.signal.aborted) {
          completion.abort()
          clearTimeout(timeout)
          socket.destroy()
          reject(new Error('Daemon response too large'))
        }
        return
      }

      const newlineIdx = buffer.indexOf('\n')
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx)
        chunks.splice(0, chunks.length, buffer.slice(newlineIdx + 1))

        try {
          const response = JSON.parse(line) as DaemonResponse
          completion.abort()
          clearTimeout(timeout)
          socket.end()
          resolve(response)
        } catch (err) {
          completion.abort()
          clearTimeout(timeout)
          socket.end()
          reject(new Error(`Invalid daemon response: ${(err as Error).message}`))
        }
      }
    })

    socket.on('error', (err) => {
      if (!completion.signal.aborted) {
        completion.abort()
        clearTimeout(timeout)
        reject(err)
      }
    })

    socket.on('close', () => {
      if (!completion.signal.aborted) {
        completion.abort()
        clearTimeout(timeout)
        reject(new Error('Connection closed before response'))
      }
    })
  })
}

/**
 * Execute a CLI command via the daemon
 *
 * Returns the DaemonResponse, or null if the daemon is not available
 * (caller should fall back to direct execution).
 *
 * When autoStart is true and the daemon is not running, spawns it
 * in the background so the next command gets the fast path.
 */
export async function executeViaDaemon(
  command: string,
  args: string[],
  options: Record<string, string | boolean>,
  cwd: string,
  perfStartNs?: string,
  autoStart = true
): Promise<DaemonResponse | null> {
  const socketPath = DAEMON_PATHS.socket()

  const namedPipe = isDaemonNamedPipe(socketPath)

  if (!namedPipe && !fs.existsSync(socketPath)) {
    if (options['operation-id']) {
      if (autoStart) await spawnDaemon().catch(() => {})
      return {
        id: String(options['operation-id']),
        success: false,
        exitCode: 1,
        stderr: 'Resume requires a running daemon. Start it and repeat the same operation id.',
      }
    }
    if (autoStart) {
      // Spawn daemon in background for future commands
      spawnDaemon().catch(() => {})
    }
    return null // Daemon not running — fall back for this command
  }

  const operationId =
    typeof options['operation-id'] === 'string' ? options['operation-id'] : crypto.randomUUID()
  try {
    // Caller identity resolves HERE (client inherits the agent's env); the
    // daemon's env is frozen at spawn and must never be consulted for it.
    const { resolveCallerIdentity } = await import('../services/agent-identity')
    const caller = resolveCallerIdentity(command)
    return await sendRequest({
      id: operationId,
      command,
      args,
      options,
      cwd,
      perfStartNs,
      callerSession: {
        sessionId: caller.sessionId,
        agent: caller.agent,
        identity: caller.identity,
      },
    })
  } catch (error) {
    if (!shouldUnlinkDaemonSocket(error) || options['operation-id']) {
      return {
        id: operationId,
        success: false,
        exitCode: 1,
        stderr: `Daemon operation ${operationId} has an uncertain outcome: ${error instanceof Error ? error.message : String(error)}. Resume with --operation-id=${operationId}; execution was not replayed.`,
      }
    }
    if (autoStart) {
      // Named pipes need a connect attempt to discover absence; spawn for next command.
      spawnDaemon().catch(() => {})
    }
    return null // Daemon error — fall back
  }
}

/**
 * Request the daemon to stop
 */
export async function stopDaemon(): Promise<boolean> {
  try {
    const response = await sendRequest({
      id: crypto.randomUUID(),
      command: 'daemon',
      args: ['stop'],
      options: {},
      cwd: process.cwd(),
    })
    return response.success
  } catch {
    return false
  }
}

/**
 * Force-kill the daemon using PID file when graceful stop fails.
 * Cleans up socket and PID files afterward.
 */
export function forceKillDaemon(): boolean {
  const pidPath = DAEMON_PATHS.pid()
  const socketPath = DAEMON_PATHS.socket()

  // Try to kill via PID file
  const killResult = (() => {
    if (!fs.existsSync(pidPath)) return { killed: false, safeToCleanOwnership: true }
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)
    if (Number.isNaN(pid)) {
      return { killed: false, safeToCleanOwnership: true }
    }
    try {
      process.kill(pid, 'SIGKILL')
      return { killed: true, safeToCleanOwnership: true }
    } catch (error) {
      return { killed: false, safeToCleanOwnership: systemErrorCode(error) === 'ESRCH' }
    }
  })()

  if (!killResult.safeToCleanOwnership) return false

  // Clean up stale files
  try {
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath)
  } catch {
    /* ignore */
  }
  if (!isDaemonNamedPipe(socketPath)) {
    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
  }

  return killResult.killed
}

/**
 * Spawn the daemon as a background process
 *
 * Resolves entry point following the same pattern as bin/prjct.ts:
 * - Dev mode: raw TypeScript via bun (core/daemon/entry.ts exists)
 * - Production (from dist/bin/): compiled JS adjacent (../daemon/entry.mjs)
 * - Production (from bin/): compiled JS in dist/ (dist/daemon/entry.mjs)
 *
 * Single-flight: in-process promise coalesce + exclusive spawn lock file so
 * concurrent hooks/CLI clients never race the Unix socket bind (production
 * symptom: "Failed to listen" / "chmod ENOENT" storms in daemon.log).
 */
/** In-process single-flight so one CLI process never double-spawns. */
const spawnState: { inFlight: Promise<boolean> | null } = { inFlight: null }

/** How far up from the running module we look for the packaged daemon. */
const DAEMON_ENTRY_MAX_ASCENT = 8

export interface DaemonLaunch {
  entryPath: string
  runtime: 'bun' | 'node'
}

/**
 * Locate the daemon entry from the directory the running module sits in.
 *
 * This used to guess three fixed paths off `__dirname`, all assuming the caller
 * lives in `dist/bin/`. The bundler emits this module into
 * `dist/bin/core-chunks/` (and `dist/bin/hook-chunks/`) — one level deeper — so
 * every guess missed and a published install could NEVER spawn its daemon.
 * Silently: callers only see `false`, so every CLI run fell back to cold start.
 * Walking up for the packaged entry survives however the bundle is laid out.
 */
export function resolveDaemonLaunch(
  fromDir: string,
  opts: { exists: (candidate: string) => boolean; preferBun: boolean }
): DaemonLaunch | null {
  // Source checkout: client.ts and entry.ts are siblings.
  const source = path.join(fromDir, 'entry.ts')
  if (opts.exists(source)) return { entryPath: source, runtime: 'bun' }

  const runtime: 'bun' | 'node' = opts.preferBun ? 'bun' : 'node'
  const ascend = (dir: string, hops: number): DaemonLaunch | null => {
    if (hops > DAEMON_ENTRY_MAX_ASCENT) return null
    for (const relative of [
      ['daemon', 'entry.mjs'],
      ['dist', 'daemon', 'entry.mjs'],
    ]) {
      const candidate = path.join(dir, ...relative)
      if (opts.exists(candidate)) return { entryPath: candidate, runtime }
    }
    const parent = path.dirname(dir)
    return parent === dir ? null : ascend(parent, hops + 1)
  }
  return ascend(fromDir, 0)
}

export async function spawnDaemon(): Promise<boolean> {
  if (spawnState.inFlight) return spawnState.inFlight
  spawnState.inFlight = spawnDaemonExclusive().finally(() => {
    spawnState.inFlight = null
  })
  return spawnState.inFlight
}

async function spawnDaemonExclusive(): Promise<boolean> {
  // Already up — nothing to do (cheap; avoids the lock entirely).
  if (await isDaemonRunning()) return true

  const lock = tryAcquireSpawnLock()
  if (!lock) {
    // Another process is mid-spawn — wait for it to come up instead of
    // racing the socket (production logs: Failed to listen / chmod ENOENT).
    return await waitUntilDaemonRunning(3_000)
  }

  try {
    // Re-check under the lock: the winner of a prior race may already be live.
    if (await isDaemonRunning()) return true

    const { spawn } = await import('node:child_process')

    const launch = resolveDaemonLaunch(__dirname, {
      exists: (candidate) => fs.existsSync(candidate),
      preferBun: process.platform !== 'win32' && isBunAvailable(),
    })
    if (!launch) return false
    const { entryPath, runtime } = launch

    const runDir = DAEMON_PATHS.runDir()
    fs.mkdirSync(runDir, { recursive: true })

    const logPath = DAEMON_PATHS.log()
    const logFd = fs.openSync(logPath, 'a')

    const child = spawn(runtime, [entryPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      // The daemon entry sets PRJCT_IN_DAEMON itself before any consumer
      // code runs, so we just inherit the parent env.
      env: process.env,
    })

    child.unref()
    fs.closeSync(logFd)

    return await waitUntilDaemonRunning(3_000)
  } finally {
    releaseSpawnLock(lock)
  }
}

/**
 * Poll for a live daemon with short early intervals (hooks care about the
 * first ~100ms) then back off. Caps at `budgetMs`.
 */
async function waitUntilDaemonRunning(budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  const poll = async (delay: number): Promise<boolean> => {
    if (Date.now() >= deadline) return isDaemonRunning()
    if (await isDaemonRunning()) return true
    await new Promise((resolve) => setTimeout(resolve, delay))
    return poll(Math.min(delay * 2, 250))
  }
  return poll(40)
}

/**
 * Restart the daemon so it re-reads auth/session state and reopens realtime
 * connections with fresh credentials.
 *
 * The daemon is long-lived: `prjct login`/`logout` run in a separate cold
 * process and update the secure token + auth.json, but the daemon keeps its
 * realtime clients (and any sync state) bound to the credentials it booted
 * with. Without a restart, `cloud status`/`link` keep reporting the OLD
 * authenticated/unauthenticated state until a manual `daemon restart`
 * (mem_2880). Login/logout call this so the new state takes effect at once.
 *
 * Best-effort and a no-op when no daemon is running (ephemeral / pull-based
 * mode covers that). Graceful stop falls back to force-kill, then respawn.
 * Returns whether a daemon is live afterward.
 */
export async function restartDaemon(): Promise<boolean> {
  try {
    if (!(await isDaemonRunning())) {
      // Nothing to refresh — the next command spawns a daemon that reads
      // the new auth on boot.
      return false
    }
    const stopped = await stopDaemon()
    if (!stopped) forceKillDaemon()
    // Give the OS a beat to release the socket before respawning.
    await new Promise((resolve) => setTimeout(resolve, 300))
    return await spawnDaemon()
  } catch {
    // Never let a daemon refresh failure break login/logout — the user is
    // still authenticated; worst case they run `daemon restart` manually.
    return false
  }
}

/**
 * Force a fresh daemon lifecycle: stop the current daemon (falling back to
 * a force-kill), or — when none is running — clean up any stale PID/socket
 * files, then spawn a new one. Unlike {@link restartDaemon} (best-effort,
 * a no-op when no daemon is running — the semantics `login`/`logout` want),
 * this always attempts to end with a live daemon: the explicit-command
 * semantics behind `prjct daemon restart`, the top-level `prjct restart`
 * shortcut, and the updater's post-install restart phase.
 */
export async function forceRestartDaemon(): Promise<boolean> {
  if (await isDaemonRunning()) {
    const stopped = await stopDaemon()
    if (!stopped) forceKillDaemon()
    // Give the OS a beat to release the socket before respawning.
    await new Promise((resolve) => setTimeout(resolve, 300))
  } else {
    // Clean up any stale files
    forceKillDaemon()
  }
  return await spawnDaemon()
}
