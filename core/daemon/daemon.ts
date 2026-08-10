/**
 * prjct Daemon Server
 *
 * Long-running background process that keeps CLI modules warm in memory.
 * Listens on a Unix domain socket for commands from the thin CLI client.
 *
 * Benefits:
 * - Near-zero startup (~5-10ms vs ~360ms cold start)
 * - Modules loaded once, reused across invocations
 * - Storage caches persist across commands
 * - Single process for CLI + HTTP API
 */

import { spawn as spawnProcess } from 'node:child_process'
import fs from 'node:fs'
import type { Server, Socket } from 'node:net'
import { createServer as createNetServer, connect as netConnect } from 'node:net'
import { PrjctCommands } from '../commands/commands'
import { resetGroupLoaders } from '../commands/register'
import { commandRegistry } from '../commands/registry'
import type { HookIo } from '../hooks/_runner'
import { getHookRunner } from '../hooks/registry'
import { refreshUpdateStatus } from '../services/update-checker'
import prjctDb from '../storage/database'
import { realtimeManager } from '../sync/realtime-manager'
import type { DaemonRequest, DaemonResponse, DaemonState } from '../types/daemon'
import { executeCommand } from './dispatch'
import {
  DAEMON_PATHS,
  encodeMessage,
  IDLE_TIMEOUT_MS,
  isDaemonNamedPipe,
  MAX_BUFFER_SIZE,
  SHUTDOWN_DRAIN_MS,
} from './protocol'
import { daemonRequestJournal } from './request-journal'
import { daemonRequestLanes } from './request-lanes'
import {
  decideRestart,
  isCodeStale as detectStaleCode,
  isGlobalVersionDrifted,
  isProcessRunning,
  readOwnPackageVersion,
  resolveEntryPath,
  rotateLog,
} from './staleness'
import { decideListenFailure } from './startup-lock'

/** Run WAL checkpoint every N requests to reclaim disk space */
const WAL_CHECKPOINT_INTERVAL = 50

/**
 * Min interval between global-install version-drift checks. The mtime check is
 * a single stat and runs on every request; drift does a few readlink+readFile,
 * so we throttle it by TIME (not request count) — at most once per second. A
 * time bound caps the staleness window to ~1s regardless of request rate,
 * unlike a per-N-request counter which could serve N-1 stale commands.
 */
const VERSION_DRIFT_CHECK_MIN_MS = 1000

/** How often the daemon re-checks npm for a newer published version. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

/** Cap absorbed crash handlers so a tight loop cannot pin the process forever. */
const MAX_ABSORBED_ERRORS = 50

interface DaemonRuntime {
  ipcServer: Server | null
  commands: PrjctCommands | null
  state: DaemonState | null
  ownVersion: string | null
  lastDriftCheckMs: number
  updateTimer: ReturnType<typeof setInterval> | null
  shuttingDown: boolean
}

const runtime: DaemonRuntime = {
  ipcServer: null,
  commands: null,
  state: null,
  ownVersion: null,
  lastDriftCheckMs: 0,
  updateTimer: null,
  shuttingDown: false,
}

export async function startDaemon(options: { foreground?: boolean }): Promise<void> {
  // Flag child services can check to know they're running under the
  // long-lived daemon — lets them fire-and-forget safe work that would
  // otherwise be killed by `process.exit()` in the CLI.
  process.env.PRJCT_IN_DAEMON = '1'

  const socketPath = DAEMON_PATHS.socket()
  const pidPath = DAEMON_PATHS.pid()
  const runDir = DAEMON_PATHS.runDir()
  const namedPipe = isDaemonNamedPipe(socketPath)

  fs.mkdirSync(runDir, { recursive: true })

  // Cross-process single-flight lives in spawnDaemon() (client-side lock).
  // Here we only refuse if a live PID already owns the endpoint; lost listen
  // races exit 0 via decideListenFailure when a peer is healthy.
  if (fs.existsSync(pidPath)) {
    const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)
    if (isProcessRunning(existingPid)) {
      console.log(`Daemon already running (PID ${existingPid})`)
      process.exit(0)
    }
    try {
      fs.unlinkSync(pidPath)
    } catch {
      /* ignore */
    }
  }

  // Clean up stale Unix socket. Windows named pipes are not filesystem entries.
  // Never unlink if a live peer is already serving (protects against the
  // classic "steal the Unix socket under a live listener" race).
  if (!namedPipe && fs.existsSync(socketPath)) {
    const peerAlive = await peerDaemonHealthy(socketPath, pidPath)
    if (peerAlive) {
      console.log('Daemon already serving — yielding')
      process.exit(0)
    }
    try {
      fs.unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
  }

  rotateLog()

  const entryPath = resolveEntryPath()
  const entryMtime = (() => {
    if (!entryPath) return null
    try {
      return fs.statSync(entryPath).mtimeMs
    } catch {
      return null
    }
  })()

  runtime.ownVersion = readOwnPackageVersion()

  runtime.state = {
    startedAt: Date.now(),
    commandsServed: 0,
    lastActivity: Date.now(),
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    idleTimer: null,
    entryPath,
    entryMtime,
    activeRequests: 0,
    restartPending: false,
    restartReason: null,
    absorbedErrors: 0,
  }

  installCrashHandlers()

  // Self-heal hooks + global CLAUDE.md when the binary moved past the
  // last sync. Best-effort: failures must never block daemon startup.
  if (runtime.ownVersion) {
    try {
      const { isSyncCurrent, runSelfHeal } = await import('../infrastructure/self-heal')
      if (!isSyncCurrent(runtime.ownVersion)) await runSelfHeal(runtime.ownVersion)
    } catch {
      // never block daemon startup
    }
  }

  // Own the "is a newer prjct published?" question. The daemon is the one
  // process that reliably knows the installed version, so it refreshes the
  // global update-status flag here (and hourly below). The statusline only
  // READS that flag — it no longer does any version comparison itself.
  // Best-effort + non-blocking: a slow/offline registry must never delay
  // startup or serving.
  if (runtime.ownVersion) {
    const version = runtime.ownVersion
    void refreshUpdateStatus(version).catch(() => undefined)
    runtime.updateTimer = setInterval(() => {
      void refreshUpdateStatus(version).catch(() => undefined)
    }, UPDATE_CHECK_INTERVAL_MS)
    runtime.updateTimer.unref?.()
  }

  // Pre-load modules (this is the whole point — do it once)
  runtime.commands = new PrjctCommands()

  runtime.ipcServer = createNetServer((socket) => handleConnection(socket))

  runtime.ipcServer.listen(socketPath, () => {
    if (!namedPipe) {
      try {
        if (fs.existsSync(socketPath)) fs.chmodSync(socketPath, 0o600)
      } catch {
        // Race with a dying peer unlinking the socket — non-fatal if we still listen.
      }
    }
    try {
      fs.writeFileSync(pidPath, String(process.pid))
    } catch (err) {
      console.error('Failed to write daemon pid file:', (err as Error).message)
    }

    console.log(`prjct daemon started (PID ${process.pid})`)
    console.log(`  Socket: ${socketPath}`)
    if (entryPath) console.log(`  Watching: ${entryPath}`)

    resetIdleTimer()

    // Open realtime connections for linked projects (cloud sync). Best-effort,
    // non-blocking — a failure here must never stop the daemon from serving.
    void realtimeManager.startAll().catch(() => undefined)
  })

  runtime.ipcServer.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code
    void (async () => {
      const peerHealthy = await peerDaemonHealthy(socketPath, pidPath)
      const decision = decideListenFailure({
        errorCode: code,
        errorMessage: err.message,
        peerHealthy,
      })
      console.error(
        decision.exitCode === 0
          ? `Daemon listen race lost (${decision.reason}) — peer is healthy`
          : `Daemon socket error: ${err.message}`
      )
      // Don't call full shutdown (would unlink a peer's socket). Just exit.
      process.exit(decision.exitCode)
    })()
  })

  process.on('SIGTERM', () => {
    void shutdown(0)
  })
  process.on('SIGINT', () => {
    void shutdown(0)
  })
  process.on('SIGHUP', () => {
    // Refresh BOTH dispatch paths: the explicit-case instance below AND the
    // registry's lazy group memos (schema-covered commands kept pre-reload
    // instances otherwise — the review's stale-SIGHUP finding).
    runtime.commands = new PrjctCommands()
    resetGroupLoaders()
    commandRegistry.resetLazyResolutions()
    console.log('Daemon reloaded (SIGHUP)')
  })

  if (!options.foreground) {
    try {
      process.stdin?.unref?.()
    } catch {
      // Not available in all runtimes (e.g. Bun)
    }
  }
}

/**
 * Best-effort check that another daemon is already serving (or a live PID
 * owns the endpoint). Used to exit 0 on lost spawn races instead of
 * cascading fatal errors.
 */
async function peerDaemonHealthy(socketPath: string, pidPath: string): Promise<boolean> {
  const namedPipe = isDaemonNamedPipe(socketPath)
  if (!namedPipe && !fs.existsSync(socketPath)) {
    if (fs.existsSync(pidPath)) {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)
      return !Number.isNaN(pid) && isProcessRunning(pid)
    }
    return false
  }

  // Light connect + ping without importing the full client (avoids cycles).
  return await new Promise<boolean>((resolve) => {
    const sock = netConnect(socketPath)
    const completion = new AbortController()
    const finish = (ok: boolean) => {
      if (completion.signal.aborted) return
      completion.abort()
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    const t = setTimeout(() => finish(false), 400)
    sock.on('connect', () => {
      sock.write(
        encodeMessage({
          id: 'startup-peer-check',
          command: '__ping',
          args: [],
          options: {},
          cwd: process.cwd(),
        })
      )
    })
    sock.on('data', (chunk: Buffer) => {
      try {
        const line = chunk.toString().split('\n')[0]
        const msg = JSON.parse(line) as DaemonResponse
        clearTimeout(t)
        finish(msg.success === true)
      } catch {
        clearTimeout(t)
        finish(false)
      }
    })
    sock.on('error', () => {
      clearTimeout(t)
      finish(false)
    })
  })
}

function installCrashHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    const state = runtime.state
    if (!state) return
    state.absorbedErrors++
    console.error(
      `Daemon absorbed unhandledRejection (${state.absorbedErrors}):`,
      reason instanceof Error ? reason.message : String(reason)
    )
    if (state.absorbedErrors >= MAX_ABSORBED_ERRORS) {
      console.error('Daemon absorbed-error cap reached — shutting down for clean respawn')
      void shutdown(1, { respawn: true })
    }
  })

  process.on('uncaughtException', (err) => {
    const state = runtime.state
    if (!state) {
      console.error('Daemon uncaughtException before init:', err.message)
      process.exit(1)
      return
    }
    state.absorbedErrors++
    console.error(`Daemon absorbed uncaughtException (${state.absorbedErrors}):`, err.message)
    // A true uncaughtException can leave the process in an undefined state.
    // Drain + exit (and self-respawn for warm recovery) rather than keep serving.
    void shutdown(1, { respawn: true })
  })
}

function handleConnection(socket: Socket): void {
  const chunks: string[] = []

  socket.on('data', async (chunk) => {
    chunks.push(chunk.toString())
    const buffer = chunks.join('')

    // Guard against unbounded buffer growth from malformed clients
    if (buffer.length > MAX_BUFFER_SIZE) {
      const errorResponse: DaemonResponse = {
        id: 'unknown',
        success: false,
        exitCode: 1,
        stderr: 'Request too large',
      }
      socket.write(encodeMessage(errorResponse))
      socket.destroy()
      chunks.length = 0
      return
    }

    // Process complete messages (newline-delimited)
    const messages = buffer.split('\n')
    const remainder = messages.pop() ?? ''
    chunks.splice(0, chunks.length, remainder)
    for (const line of messages) {
      if (!line.trim()) continue

      try {
        const request = JSON.parse(line) as DaemonRequest
        const response = await handleRequest(request)
        socket.write(encodeMessage(response))
      } catch (err) {
        const errorResponse: DaemonResponse = {
          id: 'unknown',
          success: false,
          exitCode: 1,
          stderr: `Protocol error: ${(err as Error).message}`,
        }
        socket.write(encodeMessage(errorResponse))
      }
    }
  })

  socket.on('error', () => {
    // Client disconnected — nothing to do
  })
}

/**
 * Decide — BEFORE serving — whether the loaded code is stale (a newer build or
 * global install is on disk). Sets `restartPending`. Running this ahead of
 * execution is the whole point: it guarantees a request is never answered by an
 * outdated build (the previous design checked AFTER serving, so the request
 * that first observed the new code was still served stale).
 */
function markStaleIfNeeded(command: string): void {
  const state = runtime.state
  if (!state || state.restartPending) return

  // Cheap (one stat): catches local rebuilds. The drift probe (readlink +
  // readFile) is throttled inside decideRestart and skipped for health pings.
  const codeStale = detectStaleCode(state.entryPath, state.entryMtime)
  const decision = decideRestart({
    codeStale,
    command,
    ownVersion: runtime.ownVersion,
    now: Date.now(),
    lastDriftCheckMs: runtime.lastDriftCheckMs,
    driftMinIntervalMs: VERSION_DRIFT_CHECK_MIN_MS,
    checkDrift: isGlobalVersionDrifted,
  })
  runtime.lastDriftCheckMs = decision.lastDriftCheckMs

  if (decision.restart) {
    state.restartPending = true
    // Local rebuild → safe to self-respawn the same entry path.
    // Global version drift → must NOT self-respawn (this binary is the stale
    // one); the fresh client falls through and spawns the new install.
    state.restartReason = codeStale ? 'code' : 'drift'
    console.log(
      codeStale
        ? 'Build change detected — daemon will restart; request runs on fresh code.'
        : `Version drift detected — daemon v${runtime.ownVersion} is stale; request runs on fresh code.`
    )
  }
}

async function handleRequest(request: DaemonRequest): Promise<DaemonResponse> {
  const state = runtime.state
  if (!state || !runtime.commands) {
    return {
      id: request.id,
      success: false,
      exitCode: 1,
      stderr: 'Daemon not initialized',
    }
  }

  if (runtime.shuttingDown && request.command !== 'daemon' && request.command !== '__ping') {
    return {
      id: request.id,
      success: false,
      exitCode: 1,
      retry: true,
      stderr: 'daemon is shutting down — running directly',
    }
  }

  // Detect staleness BEFORE serving so no request is ever answered by an
  // outdated build.
  markStaleIfNeeded(request.command)

  // When stale, refuse real work and tell the client to run it directly on the
  // fresh code (the `retry` flag). The request did NOT execute → zero side
  // effects → the client falls through safely, no error shown to the user.
  // Control commands (`daemon`, health `__ping`) still pass so `daemon
  // stop`/`status` and liveness checks keep working while we drain.
  if (state.restartPending && request.command !== 'daemon' && request.command !== '__ping') {
    if (state.activeRequests === 0) {
      console.log('Daemon shutting down for code reload...')
      setImmediate(() => {
        void shutdown(0, { respawn: runtime.state?.restartReason === 'code' })
      })
    }
    return {
      id: request.id,
      success: false,
      exitCode: 1,
      retry: true,
      stderr: 'daemon code is stale — running directly',
    }
  }

  return daemonRequestJournal.run(request, async () => {
    state.activeRequests++
    try {
      // Hooks use a separate lane so a long CLI command cannot head-of-line
      // block Claude Code's Prompt/Stop path. Commands stay exclusive because
      // they patch global console.log/error for output capture.
      const lane = request.command === 'hook' ? 'hook' : 'command'
      return await daemonRequestLanes.run(lane, () => handleRequestInner(request))
    } finally {
      state.activeRequests--
      if (state.restartPending && state.activeRequests === 0) {
        console.log('Daemon shutting down for code reload...')
        // Defer to next tick so the response finishes flushing to the client.
        setImmediate(() => {
          void shutdown(0, { respawn: runtime.state?.restartReason === 'code' })
        })
      }
    }
  })
}

async function handleRequestInner(request: DaemonRequest): Promise<DaemonResponse> {
  const state = runtime.state
  const commands = runtime.commands
  if (!state || !commands) {
    return {
      id: request.id,
      success: false,
      exitCode: 1,
      stderr: 'Daemon not initialized',
    }
  }

  resetIdleTimer()
  state.commandsServed++
  state.lastActivity = Date.now()

  if (state.commandsServed % WAL_CHECKPOINT_INTERVAL === 0) {
    prjctDb.checkpointAll()
  }

  // NOTE: stale-code / version-drift detection happens in markStaleIfNeeded()
  // BEFORE serving (see handleRequest) — never here, or the triggering request
  // would be answered by the outdated build.

  if (request.command === 'daemon') return handleDaemonCommand(request)

  if (request.command === 'hook') return handleHookRequest(request)

  if (request.command === '__ping') {
    return {
      id: request.id,
      success: true,
      exitCode: 0,
      result: { pong: true, pid: process.pid },
    }
  }

  // Execute the CLI command
  try {
    // Capture stdout/stderr
    const output: string[] = []
    const errors: string[] = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '))
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '))

    try {
      const result = await executeCommand(commands, request)
      return {
        id: request.id,
        success: result.success,
        exitCode: result.success ? 0 : 1,
        stdout: output.join('\n') || result.message || undefined,
        stderr: errors.join('\n') || result.error || undefined,
        result,
      }
    } finally {
      console.log = originalLog
      console.error = originalError
    }
  } catch (err) {
    return {
      id: request.id,
      success: false,
      exitCode: 1,
      stderr: (err as Error).message,
    }
  }
}

/**
 * Serve a Claude Code hook from the warm daemon instead of a cold spawn.
 *
 * The hook runner is given a `HookIo` bridge: its event payload comes from
 * the forwarded stdin, its emitted JSON is captured into `stdout` (returned
 * verbatim to the client, which writes it raw — byte-identical to the cold
 * path), and its `afterEmit` side-effects (vault regen, transcript ingest)
 * are DETACHED via setImmediate so they neither delay the response nor block
 * the daemon's serialized request chain. The runner is fail-soft by
 * contract; the outer guard is belt-and-suspenders so a hook can never take
 * the daemon down.
 */
async function handleHookRequest(request: DaemonRequest): Promise<DaemonResponse> {
  const runner = getHookRunner(request.args[0])
  if (!runner) {
    return { id: request.id, success: true, exitCode: 0, stdout: '{}\n' }
  }

  const input: unknown = (() => {
    if (!request.stdin) return {}
    try {
      return JSON.parse(request.stdin)
    } catch {
      return {}
    }
  })()

  const captured: string[] = []
  const io: HookIo = {
    input,
    sink: (chunk) => {
      captured.push(chunk)
    },
    detachAfterEmit: (fn) => {
      setImmediate(() => {
        fn().catch(() => {
          /* detached side-effects are best-effort; the next hook recovers */
        })
      })
    },
  }

  try {
    await runner(request.cwd, io)
  } catch {
    /* runner is fail-soft; guard anyway so the daemon never crashes */
  }

  return { id: request.id, success: true, exitCode: 0, stdout: captured.join('') || '{}\n' }
}

function handleDaemonCommand(request: DaemonRequest): DaemonResponse {
  const subcommand = request.args[0]

  if (subcommand === 'status') {
    const memoryRss = (() => {
      try {
        return process.memoryUsage().rss
      } catch {
        return undefined
      }
    })()
    return {
      id: request.id,
      success: true,
      exitCode: 0,
      result: {
        running: true,
        pid: process.pid,
        socketPath: DAEMON_PATHS.socket(),
        uptime: runtime.state ? Date.now() - runtime.state.startedAt : 0,
        commandsServed: runtime.state?.commandsServed ?? 0,
        lastActivity: runtime.state ? new Date(runtime.state.lastActivity).toISOString() : null,
        registeredCommands: commandRegistry.list().length,
        stale: runtime.state
          ? detectStaleCode(runtime.state.entryPath, runtime.state.entryMtime)
          : false,
        version: runtime.ownVersion,
        memoryRss,
        activeRequests: runtime.state?.activeRequests ?? 0,
        restartPending: runtime.state?.restartPending ?? false,
        restartReason: runtime.state?.restartReason ?? null,
        absorbedErrors: runtime.state?.absorbedErrors ?? 0,
      },
    }
  }

  if (subcommand === 'stop') {
    const response: DaemonResponse = {
      id: request.id,
      success: true,
      exitCode: 0,
      stdout: 'Daemon stopping...',
    }
    setTimeout(() => {
      void shutdown(0)
    }, 100)
    return response
  }

  return {
    id: request.id,
    success: false,
    exitCode: 1,
    stderr: `Unknown daemon command: ${subcommand}. Use: status, stop`,
  }
}

function resetIdleTimer(): void {
  const state = runtime.state
  if (!state || runtime.shuttingDown) return

  if (state.idleTimer) clearTimeout(state.idleTimer)

  state.idleTimer = setTimeout(() => {
    console.log(`Daemon idle for ${state!.idleTimeoutMs / 1000 / 60} minutes, shutting down`)
    void shutdown(0)
  }, state.idleTimeoutMs)

  // Don't keep the process alive just for the timer
  if (state.idleTimer.unref) state.idleTimer.unref()
}

/**
 * Graceful shutdown: stop accepting work, wait briefly for in-flight
 * requests to finish, then tear down. Optionally self-respawn (only safe
 * for local rebuild reloads — never for version drift).
 */
async function shutdown(exitCode: number, opts: { respawn?: boolean } = {}): Promise<void> {
  if (runtime.shuttingDown) return
  runtime.shuttingDown = true
  console.log('Daemon shutting down...')

  // Stop accepting new connections immediately.
  if (runtime.ipcServer) {
    try {
      runtime.ipcServer.close()
    } catch {
      /* ignore */
    }
    runtime.ipcServer = null
  }

  // Drain in-flight work so a mid-command exit doesn't leave partial state
  // without a response. Cap the wait so a stuck request cannot pin us forever.
  const state = runtime.state
  if (state && state.activeRequests > 0) {
    const deadline = Date.now() + SHUTDOWN_DRAIN_MS
    while (state.activeRequests > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    if (state.activeRequests > 0) {
      console.log(
        `Daemon drain timeout with ${state.activeRequests} active request(s) — forcing exit`
      )
    }
  }

  // Close realtime connections before tearing down storage.
  try {
    realtimeManager.stopAll()
  } catch {
    /* ignore */
  }

  if (state?.idleTimer) clearTimeout(state.idleTimer)
  if (runtime.updateTimer) {
    clearInterval(runtime.updateTimer)
    runtime.updateTimer = null
  }

  try {
    prjctDb.close()
  } catch {
    /* ignore */
  }

  const socketPath = DAEMON_PATHS.socket()
  const pidPath = DAEMON_PATHS.pid()

  if (!isDaemonNamedPipe(socketPath)) {
    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
  }

  try {
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath)
  } catch {
    /* ignore */
  }

  // Self-respawn only when the same entry path now has fresher code (local
  // rebuild). Version drift must leave the process down so a client running
  // the NEW binary can spawn the correct install.
  if (opts.respawn && state?.restartReason !== 'drift') {
    scheduleSelfRespawn()
  }

  process.exit(exitCode)
}

/**
 * Detach a sibling daemon process from the same entry we were started with.
 * Best-effort: failures leave the daemon down (clients cold-fall-through and
 * will spawn on the next command).
 */
function scheduleSelfRespawn(): void {
  try {
    const entry = process.argv[1]
    if (!entry || !fs.existsSync(entry)) return
    const logPath = DAEMON_PATHS.log()
    const logFd = (() => {
      try {
        return fs.openSync(logPath, 'a')
      } catch {
        return undefined
      }
    })()
    const stdio: ['ignore', number | 'ignore', number | 'ignore'] = logFd
      ? ['ignore', logFd, logFd]
      : ['ignore', 'ignore', 'ignore']
    // Must be synchronous before process.exit — an async spawn would never run.
    const child = spawnProcess(process.execPath, [entry], {
      detached: true,
      stdio,
      env: process.env,
    })
    child.unref()
    if (logFd !== undefined) {
      try {
        fs.closeSync(logFd)
      } catch {
        /* ignore */
      }
    }
    console.log('Daemon scheduled self-respawn after code reload')
  } catch (err) {
    console.error('Daemon self-respawn failed:', (err as Error).message)
  }
}
