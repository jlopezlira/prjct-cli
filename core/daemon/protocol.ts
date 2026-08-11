/**
 * Daemon IPC Protocol
 *
 * Runtime constants and codec functions for the JSON message format
 * exchanged between the thin CLI client and the daemon process.
 *
 * Protocol: newline-delimited JSON (NDJSON) over a local IPC endpoint.
 * macOS/Linux use Unix domain sockets; Windows uses a named pipe.
 */

import crypto from 'node:crypto'
import path from 'node:path'
import { resolveCliHome } from '../infrastructure/cli-home'
import type { DaemonRequest, DaemonResponse } from '../types/daemon'

const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\'

export function getDaemonRunDir(cliHome: string = resolveCliHome()): string {
  return path.join(cliHome, 'run')
}

export function getDaemonSocketPath(
  platform: NodeJS.Platform = process.platform,
  cliHome: string = resolveCliHome()
): string {
  if (platform === 'win32') {
    const id = crypto.createHash('sha1').update(path.resolve(cliHome)).digest('hex').slice(0, 16)
    return `${WINDOWS_PIPE_PREFIX}prjct-${id}-daemon`
  }
  return path.join(getDaemonRunDir(cliHome), 'daemon.sock')
}

export function isDaemonNamedPipe(socketPath: string = getDaemonSocketPath()): boolean {
  return socketPath.startsWith(WINDOWS_PIPE_PREFIX)
}

/** Paths used by the daemon */
export const DAEMON_PATHS = {
  /** Directory for runtime files */
  runDir: () => getDaemonRunDir(),
  /** Local IPC endpoint: Unix socket on POSIX, named pipe on Windows */
  socket: () => getDaemonSocketPath(),
  /** PID file */
  pid: () => path.join(DAEMON_PATHS.runDir(), 'daemon.pid'),
  /** Log file */
  log: () => path.join(DAEMON_PATHS.runDir(), 'daemon.log'),
}

/**
 * Default idle timeout before auto-shutdown (8 hours). Sized to outlive a
 * full working session: every request — hooks included — resets the idle
 * timer, so the daemon only dies after 8h of total inactivity (e.g.
 * overnight). The old 30min value let the daemon die mid-session, silently
 * degrading every later hook to the cold path (~300ms bun / ~950ms node).
 */
export const IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000

/** Maximum buffer size per connection before rejecting (1 MB) */
export const MAX_BUFFER_SIZE = 1024 * 1024

/**
 * Client timeout for normal CLI commands routed through the daemon.
 * Must stay in lockstep with the production shim in scripts/build.js.
 */
export const COMMAND_REQUEST_TIMEOUT_MS = 30_000

/**
 * Client timeout for long-running verbs (ship/sync/dream/…). Ship alone can
 * spend >65s on version+changelog+commit+push (plus optional test gates up
 * to 5min). A 30s hard cut made `prjct ship` exit 1 mid-flight ("daemon
 * dropped the request (Daemon request timed out)") while the daemon still
 * ran partial side effects — agents then looped "Retry after daemon timeout".
 * Must stay in lockstep with the production shim in scripts/build.js.
 */
export const LONG_COMMAND_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Verbs that routinely exceed COMMAND_REQUEST_TIMEOUT_MS. Keep this list
 * short and intentional — everything else stays at 30s so a hung daemon
 * cannot pin a shell for 10 minutes.
 */
export const LONG_RUNNING_COMMANDS: ReadonlySet<string> = new Set([
  'ship',
  'sync',
  'dream',
  'update',
  'upgrade',
  'analyze',
  'init',
  'cloud',
])

/**
 * Client timeout for hook requests. Hooks are fail-soft and latency-critical
 * (Claude Code waits). The warm daemon answers in ~5-20ms, so 800ms is
 * already generous; a hung daemon must degrade to the cold in-process path
 * fast, never block the host for 30s. The production shim uses the same
 * value — keep them identical.
 */
export const HOOK_REQUEST_TIMEOUT_MS = 800

/** Resolve the client-side wait budget for a daemon-routed command. */
export function commandRequestTimeoutMs(command: string): number {
  if (command === 'hook') return HOOK_REQUEST_TIMEOUT_MS
  if (LONG_RUNNING_COMMANDS.has(command)) return LONG_COMMAND_TIMEOUT_MS
  return COMMAND_REQUEST_TIMEOUT_MS
}

/**
 * How long shutdown waits for in-flight requests before force-exit.
 * Long enough for a normal command to finish; short enough that a stuck
 * request cannot pin a stale daemon forever.
 */
export const SHUTDOWN_DRAIN_MS = 2_000

/** Encode a message for sending over socket */
export function encodeMessage(msg: DaemonRequest | DaemonResponse): Buffer {
  return Buffer.from(`${JSON.stringify(msg)}\n`)
}
