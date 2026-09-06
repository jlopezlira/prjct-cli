/**
 * Daemon IPC Protocol Types
 *
 * Type definitions for the JSON messages exchanged between the thin CLI client
 * and the daemon process over a Unix socket.
 */

/** Request sent from CLI client to daemon */
export interface DaemonRequest {
  /** Unique request ID for correlating responses */
  id: string
  /** CLI command name (e.g. "sync", "status", "done") */
  command: string
  /** Positional arguments */
  args: string[]
  /** Named options/flags */
  options: Record<string, string | boolean>
  /** Working directory of the CLI client */
  cwd: string
  /** Process start time (nanoseconds) for startup metrics */
  perfStartNs?: string
  /** Raw stdin payload, forwarded for `hook` commands (the Claude Code
   *  event JSON the hook would otherwise read from its own stdin). */
  stdin?: string
  /** Host that invoked a `hook` command (the client's PRJCT_HOOK_HOST), so
   *  the warm daemon adapts output for the right host instead of reading its
   *  own — host-less — env. */
  hookHost?: string
  /** Caller's agent-session identity, resolved in the CLIENT process (which
   *  inherits the agent's env — the daemon's env is frozen at spawn). Powers
   *  session-scoped delivery trimming; optional = drift-safe both ways
   *  (absent → sessionless policies, i.e. no suppression). */
  callerSession?: { sessionId?: string; agent?: string; identity?: string }
  /** Per-daemon secret read from the owner-only run dir (`daemon.token`).
   *  Proves the peer can read the same user's files — the portable stand-in
   *  for SO_PEERCRED, and the only auth Windows named pipes get. */
  auth?: string
}

/** Response sent from daemon to CLI client */
export interface DaemonResponse {
  /** Correlates to request ID */
  id: string
  /** Whether the command succeeded */
  success: boolean
  /** Exit code to use */
  exitCode: number
  /** Stdout output to display */
  stdout?: string
  /** Stderr output to display */
  stderr?: string
  /** Structured result (for --json mode) */
  result?: unknown
  /**
   * Set when the daemon refused the request because its code is stale (a
   * newer build/install is on disk). The request was NOT executed, so there
   * are zero side effects — the client must transparently fall through to
   * direct in-process execution on the fresh code, NOT print this as an error.
   */
  retry?: boolean
  /**
   * Set (together with `retry`) when the request carried no valid daemon
   * token. Nothing executed; clients run the command directly. Hook clients
   * must take the COLD path rather than punt, because the daemon will not
   * restart to fix a missing token the way it does for stale code.
   */
  unauthenticated?: boolean
}

/** Daemon status info returned by `daemon status` */
export interface DaemonStatus {
  running: boolean
  pid?: number
  socketPath?: string
  uptime?: number
  commandsServed?: number
  lastActivity?: string
  /** Installed package version this daemon process loaded */
  version?: string | null
  /** Resident set size in bytes (process.memoryUsage().rss) */
  memoryRss?: number
  /** In-flight requests (commands + hooks) */
  activeRequests?: number
  /** True when a reload/restart has been scheduled */
  restartPending?: boolean
  /** Why a restart was scheduled, if any */
  restartReason?: 'code' | 'drift' | null
  /** Uncaught/unhandled errors absorbed since start (crash resilience counter) */
  absorbedErrors?: number
}

/** Internal daemon state */
export interface DaemonState {
  startedAt: number
  commandsServed: number
  lastActivity: number
  idleTimeoutMs: number
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Path to the entry file used to start the daemon */
  entryPath: string | null
  /** mtime of the entry file at daemon startup (ms since epoch) */
  entryMtime: number | null
  /** Number of requests currently being processed. Restart waits for this to hit 0. */
  activeRequests: number
  /** True once the daemon has decided to restart; new requests are refused. */
  restartPending: boolean
  /**
   * Why restart is pending. `code` = local rebuild (safe to self-respawn the
   * same entry path). `drift` = global install moved (must NOT self-respawn
   * from this process — the fresh client spawns the new binary).
   */
  restartReason: 'code' | 'drift' | null
  /** Count of absorbed uncaught/unhandled errors (diagnostics). */
  absorbedErrors: number
}
