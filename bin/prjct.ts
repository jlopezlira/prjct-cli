;(globalThis as Record<string, unknown>).__perfStartNs = process.hrtime.bigint()

// === DAEMON FAST PATH ===
// Only uses node builtins + daemon protocol/client — zero heavy imports.
// If daemon handles the command, process.exit() skips all remaining code.
const _initialFastArgs = process.argv.slice(2)
const _initialFastCommand = _initialFastArgs.find(
  (argument) => !argument.startsWith('--') && !argument.startsWith('-')
)

// M5: internal hook — `prjct __internal-auto-update <currentVersion>`
// is invoked by the SessionStart hook as a detached child to perform a
// silent update. Handled here BEFORE the heavy imports so the rest of
// the CLI plumbing never loads in this child.
if (_initialFastCommand === '__internal-auto-update') {
  const currentVersion = _initialFastArgs[1] ?? ''
  try {
    const { runBackgroundCheck } = await import('../core/services/auto-updater')
    await runBackgroundCheck(currentVersion)
  } catch {
    // Detached child — never crash visibly. Errors are logged to
    // ~/.prjct-cli/state/auto-update.log inside runBackgroundCheck.
  }
  process.exit(0)
}

// Internal hook — `prjct __post-upgrade` is spawned as a detached child by
// the auto-update block in main() after a version change. It runs the full
// post-upgrade re-setup (provider installers, Context7 verification, the
// per-project cliVersion migration over the whole projects dir) OFF the
// user's critical path: this work took ~30s on machines with large project
// dirs and used to stall the user's FIRST command after every upgrade.
if (_initialFastCommand === '__post-upgrade') {
  try {
    const { run: runSetup } = await import('../core/infrastructure/setup')
    await runSetup()
  } catch {
    // Detached child — never crash visibly. Every piece of this setup is
    // also covered by an idempotent self-heal (shim skills, settings
    // hooks, sync's MCP/codex repair), so a failed child converges on
    // later invocations.
  }
  process.exit(0)
}

// Internal hook — `prjct __internal-ensure-daemon` is spawned as a detached
// child by the hook fast path (and the production shim) when the daemon
// socket is missing. A pure Claude session only ever runs `prjct hook <sub>`,
// so nothing else would start the daemon and every hook would pay the cold
// start (~300ms bun / ~950ms node) forever. This child just calls
// spawnDaemon() — single-flight via the cross-process spawn lock — and
// exits; the hook that triggered it never waits.
if (_initialFastCommand === '__internal-ensure-daemon') {
  try {
    if (process.env.PRJCT_NO_DAEMON !== '1') {
      const { spawnDaemon } = await import('../core/daemon/client')
      await spawnDaemon()
    }
  } catch {
    // Detached child — never crash visibly. The next hook retries.
  }
  process.exit(0)
}

// Read all of stdin (the hook event JSON) as a string, with a timeout
// safety net. Used only on the hook fast path to forward the event to the
// daemon. Returns whatever arrived if stdin never closes.
async function readAllStdin(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  const streamFinished = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve)
    process.stdin.once('error', resolve)
  })
  process.stdin.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
  await Promise.race([
    streamFinished,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
  return Buffer.concat(chunks).toString('utf-8')
}

// === HOOK FAST PATH (daemon-served) ===
// Hooks fire on session-start + every prompt + every stop. A cold spawn
// costs ~300ms (bun) to ~950ms (node) in process + module load alone; the
// warm daemon answers in ~5-20ms. Forward the event (read from stdin) to the
// daemon and write its response raw (byte-identical to the cold path). If the
// daemon isn't reachable, run the SAME hook in-process here using the stdin we
// already read (so it's never read twice), preserving the fail-soft contract.
// `hook` stays in `_binCommands` so the GTD auto-route + generic daemon block
// skip it; PRJCT_NO_DAEMON=1 also skips this and falls through to main().
// Runs BEFORE the verb-registry import and the update/self-heal blocks —
// hooks are the hottest path and need none of them.
if (_initialFastCommand === 'hook' && process.env.PRJCT_NO_DAEMON !== '1') {
  const fs = await import('node:fs')
  const { DAEMON_PATHS, isDaemonNamedPipe } = await import('../core/daemon/protocol')
  const socketPath = DAEMON_PATHS.socket()
  if (isDaemonNamedPipe(socketPath) || fs.existsSync(socketPath)) {
    const subcommand = _initialFastArgs[1]
    const stdinPayload = await readAllStdin(1000)
    try {
      const { sendRequest } = await import('../core/daemon/client')
      const { HOOK_REQUEST_TIMEOUT_MS } = await import('../core/daemon/protocol')
      const crypto = await import('node:crypto')
      // 800ms fail-soft — matches production shim; never stall Claude.
      const response = await sendRequest(
        {
          id: crypto.randomUUID(),
          command: 'hook',
          args: subcommand ? [subcommand] : [],
          options: {},
          cwd: process.cwd(),
          stdin: stdinPayload,
        },
        { timeoutMs: HOOK_REQUEST_TIMEOUT_MS }
      )
      // `retry` = daemon code is stale; the hook did NOT run there. Fall
      // through to in-process execution below so the hook always runs on the
      // fresh code (this was the original "stale daemon caches old hook code"
      // trap). Otherwise write the daemon's output and exit.
      if (!response.retry) {
        if (response.stdout) process.stdout.write(response.stdout)
        process.exit(response.exitCode ?? 0)
      }
    } catch {
      // Fall through to in-process execution below (handles both daemon-
      // unreachable and the stale-retry case).
    }
    // stdin is already consumed, so we can't defer to main()'s stdin-reading
    // handler — run the hook in-process right here with the payload we
    // captured. Mirrors the cold path: emit, then await afterEmit before exit.
    try {
      const { getHookRunner } = await import('../core/hooks/registry')
      const runner = getHookRunner(subcommand)
      if (!runner) {
        process.stdout.write('{}\n')
        process.exit(0)
      }
      const input: unknown = (() => {
        try {
          return stdinPayload ? JSON.parse(stdinPayload) : {}
        } catch {
          return {}
        }
      })()
      const pending: Array<() => Promise<void>> = []
      await runner(process.cwd(), {
        input,
        sink: (chunk: string) => {
          process.stdout.write(chunk)
        },
        detachAfterEmit: (fn: () => Promise<void>) => {
          pending.push(fn)
        },
      })
      // Detach afterEmit so cold Stop/SessionStart do not block the host.
      // Prefer a detached self-spawn when we have a script path (mirrors
      // cold-entry); otherwise await in-process (dev / missing argv[1]).
      if (pending.length > 0) {
        const entry = process.argv[1]
        if (entry && subcommand) {
          try {
            const { spawn } = await import('node:child_process')
            const child = spawn(process.execPath, [entry, 'hook', subcommand], {
              detached: true,
              stdio: ['pipe', 'ignore', 'ignore'],
              cwd: process.cwd(),
              env: {
                ...process.env,
                PRJCT_HOOK_AFTER_EMIT: '1',
                PRJCT_NO_DAEMON: '1',
              },
              shell: false,
            })
            child.stdin?.write(stdinPayload)
            child.stdin?.end()
            child.unref()
          } catch {
            for (const fn of pending) await fn().catch(() => undefined)
          }
        } else {
          for (const fn2 of pending) await fn2().catch(() => undefined)
        }
      }
      process.exit(0)
    } catch {
      process.stdout.write('{}\n')
      process.exit(0)
    }
  } else {
    // No daemon running: this hook pays the cold path, but kick a detached
    // `__internal-ensure-daemon` child so the NEXT hook is warm. Fire-and-
    // forget — never awaited, never blocks the hook response; spawnDaemon's
    // cross-process lock keeps concurrent hooks from racing the socket bind.
    // stdin has NOT been read yet, so fall through to main()'s cold hook
    // handler, which reads it there.
    try {
      const entry = process.argv[1]
      if (entry) {
        const { spawn } = await import('node:child_process')
        const child = spawn(process.execPath, [entry, '__internal-ensure-daemon'], {
          detached: true,
          stdio: 'ignore',
        })
        child.unref()
      }
    } catch {
      /* best-effort — the cold path below still serves this hook */
    }
  }
}

// Verb sets derived from the command manifest (command-data.ts) — the
// single source of truth for which commands exist and where they route.
// `_binCommands` (bin-handled, daemon never sees them) used to be a
// hand-maintained literal here that had to agree with the shim skip-set
// in scripts/build.js and the registry; all three now derive from
// `routingMode` in the manifest. Imported AFTER the hook fast path:
// hooks never need it.
const { REGISTERED_VERBS_SET, BIN_COMMANDS_SET } = await import('../core/commands/verb-names')
const { isRemovedVerb } = await import('../core/commands/removed-verbs')
const _binCommands = BIN_COMMANDS_SET

// v2 auto-route: if the first positional isn't a known verb, treat free-text
// argv as GTD-style inbox capture → `prjct capture "<argv>"`.
// A lone command-shaped token is different: it is almost always a typo or a
// stale install that predates a real verb, so fail loudly instead of writing a
// bogus inbox item. Explicit verbs still win. Capture remains zero-ceremony
// for multi-word notes; tasks still use `prjct task "..."` explicitly. Must
// run BEFORE the daemon fast path so rewritten `capture` routes there.
const { command: _fastCommand, args: _fastArgs } = (() => {
  if (
    !_initialFastCommand ||
    _binCommands.has(_initialFastCommand) ||
    REGISTERED_VERBS_SET.has(_initialFastCommand) ||
    isRemovedVerb(_initialFastCommand)
  ) {
    return { command: _initialFastCommand, args: _initialFastArgs }
  }

  const positionals = _initialFastArgs.filter((argument) => !argument.startsWith('-'))
  const description = positionals.join(' ')
  const flags = _initialFastArgs.filter((argument) => argument.startsWith('-'))
  // A single command-shaped token (e.g. `prjct upgrade`) is almost never a
  // GTD note — it is a MISROUTED command: a typo, a stale parallel install, or
  // a long-lived daemon that predates the verb. Do not write it to memory.
  if (
    positionals.length === 1 &&
    /^[a-z][a-z0-9:-]+$/.test(positionals[0]) &&
    !isRemovedVerb(positionals[0])
  ) {
    process.stderr.write(
      `prjct: '${positionals[0]}' is not a known command in this install. ` +
        'If you meant a command, upgrade prjct with `prjct upgrade` ' +
        '(or `prjct update` on older installs).\n'
    )
    process.exit(1)
  }
  return { command: 'capture', args: ['capture', description, ...flags] }
})()

// Update notice — print at process exit so the banner appears AFTER the
// command's own output. Uses a sync read of the cached latest version;
// the cache is refreshed in a detached background process so the
// network call never delays the user-visible command. Skipped for
// machine-consumed paths (`hook`, `--md`/`--json`, `--quiet`) and for
// the updater itself. Awaited at top-level so the exit handler is
// installed BEFORE the daemon fast path's `process.exit` runs.
const _updateSkipCommands = new Set([
  'update',
  'upgrade',
  'daemon',
  'hook',
  'version',
  '-v',
  '--version',
])
if (
  _fastCommand &&
  !_updateSkipCommands.has(_fastCommand) &&
  process.stderr.isTTY &&
  !_fastArgs.includes('--md') &&
  !_fastArgs.includes('--json') &&
  !_fastArgs.includes('--quiet') &&
  !_fastArgs.includes('-q') &&
  process.env.PRJCT_NO_UPDATE_NOTICE !== '1'
) {
  const { triggerBackgroundRefreshIfStale, getUpdateNotificationSync } = await import(
    '../core/infrastructure/update-checker'
  )
  // Resolve the running version once, synchronously, so the exit
  // handler (which can't await) has it ready.
  const _fs = await import('node:fs')
  const _path = await import('node:path')
  const _currentVersion = (() => {
    try {
      const pkgPath = _path.resolve(
        _path.dirname(new URL(import.meta.url).pathname),
        '..',
        'package.json'
      )
      return JSON.parse(_fs.readFileSync(pkgPath, 'utf-8')).version ?? ''
    } catch {
      return ''
    }
  })()
  try {
    triggerBackgroundRefreshIfStale()
  } catch {
    /* best-effort */
  }
  if (_currentVersion) {
    process.on('exit', () => {
      try {
        const banner = getUpdateNotificationSync(_currentVersion)
        if (banner) process.stderr.write(banner)
      } catch {
        /* never block exit on a notification */
      }
    })
  }
}

if (_fastCommand && !_binCommands.has(_fastCommand) && process.env.PRJCT_NO_DAEMON !== '1') {
  const fs = await import('node:fs')
  const { DAEMON_PATHS, isDaemonNamedPipe } = await import('../core/daemon/protocol')
  const socketPath = DAEMON_PATHS.socket()

  if (isDaemonNamedPipe(socketPath) || fs.existsSync(socketPath)) {
    const { sendRequest } = await import('../core/daemon/client')
    const crypto = await import('node:crypto')

    // Parse args for daemon
    const parseFastArgs = (
      index = 0,
      commandArgs: string[] = [],
      commandOptions: Record<string, string | boolean> = {}
    ): { commandArgs: string[]; commandOptions: Record<string, string | boolean> } => {
      if (index >= _fastArgs.length) return { commandArgs, commandOptions }
      const argument = _fastArgs[index]
      if (argument.startsWith('--')) {
        const raw = argument.slice(2)
        if (raw.includes('=')) {
          const eqIdx = raw.indexOf('=')
          return parseFastArgs(index + 1, commandArgs, {
            ...commandOptions,
            [raw.slice(0, eqIdx)]: raw.slice(eqIdx + 1),
          })
        }
        if (index + 1 < _fastArgs.length && !_fastArgs[index + 1].startsWith('--')) {
          return parseFastArgs(index + 2, commandArgs, {
            ...commandOptions,
            [raw]: _fastArgs[index + 1],
          })
        }
        return parseFastArgs(index + 1, commandArgs, { ...commandOptions, [raw]: true })
      }
      if (argument.startsWith('-') && argument.length === 2) {
        return parseFastArgs(index + 1, commandArgs, {
          ...commandOptions,
          [argument.slice(1)]: true,
        })
      }
      return parseFastArgs(
        index + 1,
        index > 0 ? [...commandArgs, argument] : commandArgs,
        commandOptions
      )
    }
    const { commandArgs, commandOptions } = parseFastArgs()

    try {
      const { commandRequestTimeoutMs } = await import('../core/daemon/protocol')
      const response = await sendRequest(
        {
          id: crypto.randomUUID(),
          command: _fastCommand,
          args: commandArgs,
          options: commandOptions,
          cwd: process.cwd(),
          perfStartNs: (
            (globalThis as Record<string, unknown>).__perfStartNs as bigint
          )?.toString(),
        },
        // ship/sync/dream/… need the long budget; default 30s is for snappy verbs.
        { timeoutMs: commandRequestTimeoutMs(_fastCommand) }
      )

      // Daemon refused because its code is stale (newer build/install on
      // disk). The command did NOT run there — fall through to direct
      // in-process execution on the fresh code. Transparent: no error, no
      // manual re-run. The daemon restarts itself in the background.
      if (!response.retry) {
        if (response.stdout) console.log(response.stdout)
        if (response.stderr) console.error(response.stderr)
        process.exit(response.exitCode)
      }
    } catch (err) {
      // The socket file existed when we entered this block, so the
      // daemon was running (or had been running, with a stale socket
      // left behind). Three failure modes:
      //
      //   1. ECONNREFUSED / ENOENT — stale socket, no listener. The
      //      request never reached a daemon. Safe to fall through to
      //      direct execution.
      //   2. Connection closed mid-response — daemon shut down (code
      //      reload, OOM kill) AFTER receiving the request. The
      //      command MAY have partial side effects (`ship` bumping the
      //      version, `git commit/push`). Re-running would double-bump.
      //   3. Timeout — request was sent, daemon either still working or
      //      dead. Same hazard as (2): partial side effects possible.
      //
      // Fall through ONLY for (1). Anything else exits 1 so the user
      // can investigate before retrying.
      const msg = (err as Error)?.message ?? ''
      const code = (err as NodeJS.ErrnoException)?.code ?? ''
      const safeRetry =
        code === 'ECONNREFUSED' ||
        code === 'ENOENT' ||
        code === 'EACCES' ||
        code === 'EPERM' ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ENOENT') ||
        msg.includes('EACCES') ||
        msg.includes('EPERM')

      if (!safeRetry) {
        console.error(
          `prjct: daemon dropped the request (${msg}). Retry: \`prjct ${_fastArgs.join(' ')}\``
        )
        process.exit(1)
      }
      // Stale socket / no listener — fall through to direct execution.
    }
  }
}

// === SELF-HEAL ===
// Re-install hooks + global CLAUDE.md when the binary version has moved
// past the last successful sync. Replaces postinstall (which is disabled
// by --ignore-scripts and corporate security policies on many client
// machines). Hot path is a single fs read of the stamp file; the slow
// path (a few writes to settings.json + CLAUDE.md) only fires once per
// version bump per machine.
//
// Runs AFTER the daemon fast path: daemon-served commands exit above and
// skip it, which is fine — the SessionStart hook fires its own self-heal
// every session, so healing coverage is unchanged while the daemon path
// stops paying the version/stamp reads.
//
// Skipped for:
//   - `daemon`/`update`/`version` (would deadlock the upgrade flow)
//   - `hook` (session-start fires its own self-heal; other hook events
//     fire too often to pay even the fs-read cost)
//   - PRJCT_NO_SELF_SYNC=1 (escape hatch)
const _selfHealSkip = new Set(['daemon', 'update', 'upgrade', 'version', '-v', '--version', 'hook'])
if (_fastCommand && !_selfHealSkip.has(_fastCommand) && process.env.PRJCT_NO_SELF_SYNC !== '1') {
  try {
    const { VERSION } = await import('../core/utils/version')
    if (VERSION) {
      const { isSyncCurrent, runSelfHeal } = await import('../core/infrastructure/self-heal')
      if (!isSyncCurrent(VERSION)) {
        await runSelfHeal(VERSION)
      }
    }
  } catch {
    // best-effort — never block the user's command on self-heal
  }
}

// === NORMAL PATH ===
// Heavy imports loaded dynamically, only when the daemon is not available.

async function main(): Promise<void> {
  const path = await import('node:path')
  const chalk = (await import('chalk')).default
  const { detectAllProviders } = await import('../core/infrastructure/ai-provider')
  const configManager = (await import('../core/infrastructure/config-manager')).default
  const editorsConfig = (await import('../core/infrastructure/editors-config')).default
  const { fileExists } = await import('../core/utils/file-helper')
  const { invalidateProviderCache } = await import('../core/utils/provider-cache')
  const { VERSION } = await import('../core/utils/version')

  async function checkRoutersInstalled(): Promise<boolean> {
    // Resolve HOME per call (not os.homedir(), which under Bun freezes to the
    // launch env and ignores a relocated/isolated HOME — the same footgun the
    // configPath check above already routes around). Setup writes ~/.claude and
    // ~/.gemini via resolveUserPath, so the check must read from the same place.
    const { resolveUserHome } = await import('../core/infrastructure/user-home')
    const home = resolveUserHome()
    const detection = await detectAllProviders()
    const { readFile } = await import('node:fs/promises')

    const hasPrjctSection = async (...rel: string[]): Promise<boolean> => {
      try {
        return (await readFile(path.join(home, ...rel), 'utf-8')).includes('prjct:start')
      } catch {
        return false
      }
    }

    // Which detected providers have their prjct section installed. A dev may
    // have several CLIs on PATH but only wire prjct into the one(s) they use —
    // requiring EVERY detected provider to be configured wrongly reports a
    // configured rig as "not configured" (e.g. claude set up, gemini not).
    const configured: boolean[] = []
    if (detection.claude.installed) configured.push(await hasPrjctSection('.claude', 'CLAUDE.md'))
    if (detection.gemini.installed) configured.push(await hasPrjctSection('.gemini', 'GEMINI.md'))

    // No supported provider on PATH → nothing to configure, treat as ready.
    if (configured.length === 0) return true
    // Configured iff AT LEAST ONE detected provider carries the prjct section.
    return configured.some(Boolean)
  }

  const args = process.argv.slice(2)

  // Parse --quiet / -q flag
  const quietIndex = args.findIndex((arg) => arg === '--quiet' || arg === '-q')
  const isQuietMode = quietIndex !== -1
  if (isQuietMode) {
    args.splice(quietIndex, 1)
    const { setQuietMode } = await import('../core/utils/output')
    setQuietMode(true)
  }
  const machineReadableOutput =
    isQuietMode || args.includes('--md') || args.includes('--json') || !process.stdout.isTTY

  // Parse --refresh flag
  const refreshIndex = args.indexOf('--refresh')
  const isRefresh = refreshIndex !== -1
  if (isRefresh) {
    args.splice(refreshIndex, 1)
    await invalidateProviderCache()
  }

  // Session tracking for commands that bypass core/index.ts
  async function trackSession(command: string): Promise<() => void> {
    const start = Date.now()
    try {
      const projectId = await configManager.getProjectId(process.cwd())
      if (projectId) {
        const { sessionTracker } = await import('../core/services/session-tracker')
        await sessionTracker.expireIfStale(projectId)
        await sessionTracker.touch(projectId)
        return () => {
          const durationMs = Date.now() - start
          sessionTracker.trackCommand(projectId, command, durationMs).catch(() => {})
          import('../core/infrastructure/performance-tracker')
            .then(({ performanceTracker }) => {
              performanceTracker
                .recordTiming(projectId, 'command_duration', durationMs, { command })
                .catch(() => {})
              performanceTracker.recordMemory(projectId, { command }).catch(() => {})
            })
            .catch(() => {})
        }
      }
    } catch {
      // Non-critical
    }
    return () => {}
  }

  const { runBinCommand } = await import('../core/cli/bin-commands')
  const handled = await runBinCommand(args, { isQuietMode, isRefresh, trackSession })
  if (!handled) {
    // Default: check setup, auto-update, then run.
    // Route through pathManager so PRJCT_CLI_HOME is honored. Using
    // os.homedir() directly here bypassed the override — the same
    // path-resolution class of bug as the case-variant/orphan-project
    // footgun: the not-configured guard misfired under a relocated or
    // isolated home (e.g. the e2e sandbox, or PRJCT_CLI_HOME setups).
    const { default: pathManager } = await import('../core/infrastructure/path-manager')
    const configPath = path.join(pathManager.globalConfigDir, 'installed-editors.json')
    const routersInstalled = await checkRoutersInstalled()

    // Commands that work without full setup
    const noSetupRequired = new Set([
      'auth',
      'login',
      'logout',
      'init',
      'eval',
      'analysis-save-llm',
      // Opt-in owned-loop brain + agent only (default OFF; does not change guest flow).
      // Intentionally does NOT include embeddings — preserve pre-existing setup gate.
      'llm',
      'agent',
    ])

    if (!noSetupRequired.has(args[0]) && (!(await fileExists(configPath)) || !routersInstalled)) {
      console.log(`
${chalk.cyan.bold('  Welcome to prjct!')}

  Run ${chalk.bold('prjct start')} to configure your AI providers.

  ${chalk.dim(`This is a one-time setup that lets you choose between
  Claude Code, Gemini CLI, or both.`)}
`)
      // Fail LOUD, not silently: a non-exempt command was requested but prjct
      // isn't configured, so the command did NOT run. Returning exit 0 here
      // makes scripts/agents believe `prjct task`/`remember`/… succeeded when
      // they were no-ops. Exit non-zero + an actionable stderr hint so the
      // failure is detectable and stdout stays clean for --md consumers.
      console.error(
        `prjct: not configured — \`${args[0]}\` did not run. ` +
          'Run `prjct start` (AI providers) or `prjct init` (project) first.'
      )
      process.exitCode = 1
    } else {
      // Auto-update if version changed
      try {
        const lastVersion = await editorsConfig.getLastVersion()
        if (lastVersion && lastVersion !== VERSION) {
          // Skip the banner when the user explicitly invoked `update` —
          // that command prints its own progress and the auto-update banner
          // would otherwise duplicate (and contradict) it.
          const userInvokedUpdate = args[0] === 'update'

          // Compare semver-ish parts. If the running binary is OLDER than
          // the stamped version (downgrade or local dev build), don't claim
          // we're "updating" — just stamp silently.
          const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0)
          const cmp = (a: string, b: string) => {
            const pa = parts(a)
            const pb = parts(b)
            return (
              [0, 1, 2]
                .map((index) => Math.sign((pa[index] ?? 0) - (pb[index] ?? 0)))
                .find((difference) => difference !== 0) ?? 0
            )
          }
          const isUpgrade = cmp(VERSION, lastVersion) > 0

          if (!userInvokedUpdate && isUpgrade && !machineReadableOutput) {
            console.log(
              `\n${chalk.yellow('ℹ')} prjct updated to v${VERSION} — finishing setup in the background\n`
            )
          }

          try {
            if (userInvokedUpdate) {
              // Explicit `prjct update`: the user asked for maintenance, so
              // run the re-setup synchronously with its own progress output.
              const { run: runSetup } = await import('../core/infrastructure/setup')
              await runSetup()
            } else {
              // Any other command: the re-setup (installers, Context7
              // verification, per-project migration over the whole projects
              // dir) took ~30s on big machines and used to stall the user's
              // FIRST command after every upgrade. Stamp the version FIRST so
              // rapid consecutive invocations don't each spawn a child, then
              // hand the work to a detached `__post-upgrade` child (same
              // pattern as the auto-updater's `__internal-auto-update`).
              await editorsConfig.updateVersion(VERSION).catch(() => {})
              const { spawn } = await import('node:child_process')
              const child = spawn(process.execPath, [process.argv[1], '__post-upgrade'], {
                detached: true,
                stdio: 'ignore',
              })
              child.unref()
            }
          } catch {
            // setup/spawn may fail (e.g. provider detection) — stamp version anyway
            await editorsConfig.updateVersion(VERSION).catch(() => {})
          }
        }
      } catch {
        // Silent fail
      }

      // Auto-start daemon in background for future commands
      if (args.length > 0 && process.env.PRJCT_NO_DAEMON !== '1') {
        import('../core/daemon/client').then(({ spawnDaemon }) => spawnDaemon()).catch(() => {})
      }
      await import('../core/index')
    }
  }
}

main().catch((error) => {
  // Hook contract: `prjct hook <name>` must never disturb the host
  // session. If anything above the dispatcher throws (import failure,
  // unhandled rejection, corrupted config), emit the empty-JSON no-op
  // instead of the fatal banner Claude Code would surface to the user.
  if (process.argv[2] === 'hook') {
    process.stdout.write('{}\n')
    process.exit(0)
  }
  console.error('Fatal error:', (error as Error).message)
  process.exit(1)
})
