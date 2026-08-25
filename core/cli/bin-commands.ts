/**
 * Bin-only command handlers — the `args[0] === X` branches extracted from
 * bin/prjct.ts main(). These are the commands the manifest marks
 * `routingMode: 'bin-only'` (daemon lifecycle, TTY needs, hook entry).
 * bin/prjct.ts keeps startup concerns (flag pre-parse, fast paths,
 * setup check, auto-update); routing for bin commands lives here.
 *
 * Same loading discipline as main(): everything is imported dynamically
 * so the daemon fast path never pays for these modules.
 */

export interface BinCommandContext {
  /** --quiet / -q was passed (already stripped from args). */
  isQuietMode: boolean
  /** --refresh was passed (provider cache already invalidated). */
  isRefresh: boolean
  /** Session/perf tracking for commands that bypass core/index.ts. */
  trackSession: (command: string) => Promise<() => void>
}

/**
 * Run the bin-only command in `args`, if any. Returns false when the
 * command is not bin-handled — the caller falls through to the default
 * path (setup check + core/index.ts dispatch).
 */
export async function runBinCommand(args: string[], ctx: BinCommandContext): Promise<boolean> {
  if (args[0] === 'daemon') {
    const subcommand = args[1] || 'status'

    if (subcommand === 'start') {
      const { isDaemonRunning, spawnDaemon } = await import('../daemon/client')

      if (await isDaemonRunning()) {
        console.log('Daemon is already running.')
        process.exitCode = 0
      } else {
        const foreground = args.includes('--foreground') || args.includes('-f')

        if (foreground) {
          const { startDaemon } = await import('../daemon/daemon')
          // NOTE: --port/--no-http were parsed here for years but
          // startDaemon never accepted them — dead flags, dropped.
          // (bin/prjct.ts sat outside core/tsconfig.json, so the type
          // error only surfaced when this code moved into core/.)
          await startDaemon({ foreground: true })
        } else {
          const started = await spawnDaemon()
          if (started) {
            console.log('Daemon started.')
          } else {
            console.error('Failed to start daemon.')
            process.exitCode = 1
          }
        }
      }
    } else if (subcommand === 'stop') {
      const { isDaemonRunning, stopDaemon } = await import('../daemon/client')

      if (await isDaemonRunning()) {
        const stopped = await stopDaemon()
        console.log(stopped ? 'Daemon stopped.' : 'Failed to stop daemon.')
        process.exitCode = stopped ? 0 : 1
      } else {
        console.log('Daemon is not running.')
        process.exitCode = 0
      }
    } else if (subcommand === 'status') {
      const { getDaemonStatus } = await import('../daemon/client')
      const status = await getDaemonStatus()

      if (status.running) {
        const chalk = (await import('chalk')).default
        const uptime = status.uptime ? Math.round(status.uptime / 1000) : 0
        const stale = (status as unknown as Record<string, unknown>).stale
        console.log(`Daemon running (PID ${status.pid})${stale ? ' ⚠ STALE' : ''}`)
        if (status.version) console.log(`  Version: ${status.version}`)
        console.log(`  Uptime: ${uptime}s`)
        console.log(`  Commands served: ${status.commandsServed ?? 0}`)
        if (typeof status.activeRequests === 'number') {
          console.log(`  Active requests: ${status.activeRequests}`)
        }
        if (typeof status.memoryRss === 'number') {
          const mb = Math.round(status.memoryRss / 1024 / 1024)
          console.log(`  Memory (RSS): ${mb} MB`)
        }
        if (status.lastActivity) {
          console.log(`  Last activity: ${status.lastActivity}`)
        }
        if (status.restartPending) {
          console.log(`  ${chalk.yellow(`Restart pending (${status.restartReason ?? 'unknown'})`)}`)
        }
        if (typeof status.absorbedErrors === 'number' && status.absorbedErrors > 0) {
          console.log(`  Absorbed errors: ${status.absorbedErrors}`)
        }
        if (stale) {
          console.log(
            `  ${chalk.yellow('⚠ Code changed since daemon started. Run: prjct restart')}`
          )
        }
      } else {
        console.log('Daemon is not running.')
      }
      process.exitCode = 0
    } else if (subcommand === 'restart') {
      const { forceRestartDaemon } = await import('../daemon/client')

      const started = await forceRestartDaemon()
      if (started) {
        console.log('Daemon restarted.')
        process.exitCode = 0
      } else {
        console.error('Failed to restart daemon.')
        process.exitCode = 1
      }
    } else if (subcommand === 'logs') {
      const fs = await import('node:fs')
      const { DAEMON_PATHS } = await import('../daemon/protocol')
      const logPath = DAEMON_PATHS.log()

      if (!fs.existsSync(logPath)) {
        console.error(`No daemon log at ${logPath}. Start the daemon first.`)
        process.exitCode = 1
      } else {
        const follow = args.includes('--follow') || args.includes('-f')
        const all = args.includes('--all')
        const linesArg =
          args.find((a) => a.startsWith('--lines='))?.split('=')[1] ||
          (args.includes('-n') ? args[args.indexOf('-n') + 1] : undefined)
        const lines = linesArg ? parseInt(linesArg, 10) : 50

        if (follow) {
          const { spawn } = await import('node:child_process')
          const child = spawn('tail', ['-n', String(lines), '-f', logPath], { stdio: 'inherit' })
          process.on('SIGINT', () => child.kill('SIGINT'))
          await new Promise<void>((resolve) => child.on('exit', () => resolve()))
        } else if (all) {
          process.stdout.write(fs.readFileSync(logPath, 'utf-8'))
        } else {
          const content = fs.readFileSync(logPath, 'utf-8')
          const allLines = content.split('\n')
          const tail = allLines.slice(-Math.max(1, lines))
          process.stdout.write(tail.join('\n'))
          if (!content.endsWith('\n')) process.stdout.write('\n')
        }
        process.exitCode = 0
      }
    } else {
      console.error(
        `Unknown daemon command: ${subcommand}. Use: start, stop, restart, status, logs`
      )
      process.exitCode = 1
    }
  } else if (args[0] === 'stop') {
    // Top-level shortcut: prjct stop → kill daemon (with force-kill fallback)
    const { isDaemonRunning, stopDaemon, forceKillDaemon } = await import('../daemon/client')
    const force = args.includes('--force') || args.includes('-f')

    if (force) {
      const killed = forceKillDaemon()
      console.log(killed ? 'Daemon force-killed.' : 'Daemon is not running.')
      process.exitCode = 0
    } else if (await isDaemonRunning()) {
      const stopped = await stopDaemon()
      if (stopped) {
        console.log('Daemon stopped.')
        process.exitCode = 0
      } else {
        // Graceful stop failed — force kill
        console.log('Graceful stop failed, force-killing...')
        forceKillDaemon()
        console.log('Daemon force-killed.')
        process.exitCode = 0
      }
    } else {
      // Check for stale files even if daemon not responding
      forceKillDaemon()
      console.log('Daemon is not running (cleaned up stale files).')
      process.exitCode = 0
    }
  } else if (args[0] === 'restart') {
    // Top-level shortcut: prjct restart → stop + start daemon
    const { forceRestartDaemon } = await import('../daemon/client')

    const started = await forceRestartDaemon()
    if (started) {
      console.log('Daemon restarted.')
      process.exitCode = 0
    } else {
      console.error('Failed to restart daemon.')
      process.exitCode = 1
    }
  } else if (args[0] === 'start' || args[0] === 'setup') {
    const { SetupCommands } = await import('../commands/setup')
    const commands = new SetupCommands()
    const result =
      args[0] === 'start'
        ? await commands.start()
        : await commands.setup({ force: args.includes('--force') })
    if (result.message) console.log(result.message)
    process.exitCode = result.success ? 0 : 1
  } else if (args[0] === 'context') {
    const projectPath = process.cwd()
    const projectId = await requireProjectOrExit(projectPath)

    if (projectId) {
      const done = await ctx.trackSession('context')
      // --md / --json select the output format; strip them before dispatch
      const contextArgs = args.slice(1).filter((a) => a !== '--md' && a !== '--json')
      const mdMode = args.includes('--md')
      const jsonMode = args.includes('--json')

      if (contextArgs.length === 0) {
        // No subcommand: return project context
        const { ContextCommands } = await import('../commands/context')
        const contextCmds = new ContextCommands()
        const result = await contextCmds.context(null, projectPath, { md: mdMode && !jsonMode })
        process.exitCode = result.success ? 0 : 1
      } else {
        const { runContextTool } = await import('../tools/context')
        const result = await runContextTool(contextArgs, projectId, projectPath)
        // --md prints the tool's markdown rendering when it has one
        // (memory/learnings/skills/tiers/project/artifacts all do); when it
        // doesn't, say so and fall back to JSON. --json always wins, so
        // scripts get the stable machine-readable envelope either way.
        const markdown =
          result.result &&
          typeof result.result === 'object' &&
          'markdown' in result.result &&
          typeof (result.result as { markdown?: unknown }).markdown === 'string'
            ? (result.result as { markdown: string }).markdown
            : null
        if (mdMode && !jsonMode && result.tool !== 'error' && markdown !== null) {
          console.log(markdown)
        } else {
          if (mdMode && !jsonMode && result.tool !== 'error') {
            console.error('--md is not supported for this tool; output is JSON')
          }
          console.log(JSON.stringify(result, null, 2))
        }
        process.exitCode = result.tool === 'error' ? 1 : 0
      }
      done()
    }
  } else if (args[0] === 'hooks') {
    const done = await ctx.trackSession('hooks')
    const { hooksService } = await import('../services/hooks-service')
    const subcommand = args[1] || 'status'
    const exitCode = await hooksService.run(process.cwd(), subcommand)
    process.exitCode = exitCode
    done()
  } else if (args[0] === 'seed') {
    // `prjct seed add|remove|list|suggest [args]` — manage active packs.
    const sub = args[1] ?? 'list'
    const rest = args
      .slice(2)
      .filter((a) => !a.startsWith('-'))
      .join(',')
    const mdMode = args.includes('--md')
    const { SeedCommands } = await import('../commands/seed')
    const cmd = new SeedCommands()
    const result: { success: boolean; error?: string } = await (async () => {
      if (sub === 'add') return cmd.add(rest || null, process.cwd(), { md: mdMode })
      if (sub === 'remove') return cmd.remove(rest || null, process.cwd(), { md: mdMode })
      if (sub === 'list') return cmd.list(null, process.cwd(), { md: mdMode })
      if (sub === 'suggest') return cmd.suggest(null, process.cwd(), { md: mdMode })
      if (sub === 'catalog') return cmd.catalog(null, process.cwd(), { md: mdMode })
      if (sub === 'verify') return cmd.verify(null, process.cwd(), { md: mdMode })
      console.error(
        `Unknown seed subcommand: ${sub}. Use: add, remove, list, suggest, catalog, verify.`
      )
      return { success: false, error: 'unknown' }
    })()
    process.exitCode = result.success ? 0 : 1
  } else if (args[0] === 'context-save') {
    // `prjct context-save [title] [--notes "..."]` — checkpoint working
    // state for resume in another session / branch / workspace.
    const title = args.slice(1).find((a) => !a.startsWith('-')) ?? null
    const notesIdx = args.indexOf('--notes')
    const notes = notesIdx >= 0 ? args[notesIdx + 1] : undefined
    const mdMode = args.includes('--md')
    const { ContextCheckpointCommands } = await import('../commands/context-checkpoint')
    const cmd = new ContextCheckpointCommands()
    const result = await cmd.save(title, process.cwd(), { md: mdMode, notes })
    process.exitCode = result.success ? 0 : 1
  } else if (args[0] === 'context-restore') {
    // `prjct context-restore [<file>] [--list] [--file <name>]` —
    // emit the most recent checkpoint (or named one).
    const list = args.includes('--list')
    const fileIdx = args.indexOf('--file')
    const file = fileIdx >= 0 ? args[fileIdx + 1] : undefined
    const positional = args.slice(1).find((a) => !a.startsWith('-')) ?? null
    const mdMode = args.includes('--md')
    const { ContextCheckpointCommands } = await import('../commands/context-checkpoint')
    const cmd = new ContextCheckpointCommands()
    const result = await cmd.restore(positional, process.cwd(), { md: mdMode, list, file })
    process.exitCode = result.success ? 0 : 1
  } else if (args[0] === 'health') {
    // `prjct health [--md]` — composite quality dashboard. Wraps
    // typecheck / lint / tests / knip and reports a weighted score.
    const mdMode = args.includes('--md')
    const { HealthCommands } = await import('../commands/health')
    const cmd = new HealthCommands()
    const result = await cmd.health(null, process.cwd(), { md: mdMode })
    process.exitCode = result.success ? 0 : 1
  } else if (args[0] === 'retro') {
    // `prjct retro [window]` — gstack-style weekly engineering retro.
    // Window defaults to 7d; accepts NNh / NNd up to 365d.
    const windowArg = args.slice(1).find((a) => !a.startsWith('-')) ?? null
    const mdMode = args.includes('--md')
    const { RetroCommands } = await import('../commands/retro')
    const cmd = new RetroCommands()
    const result = await cmd.retro(windowArg, process.cwd(), { md: mdMode })
    process.exitCode = result.success ? 0 : 1
  } else if (args[0] === 'skill-adherence') {
    // `prjct skill-adherence [window]` — harness #16 QA surface: how
    // often captured project knowledge went unreferenced, and how much
    // got resolved. Read-only; window defaults to 7d.
    const windowArg = args.slice(1).find((a) => !a.startsWith('-')) ?? null
    const mdMode = args.includes('--md')
    const { SkillAdherenceCommands } = await import('../commands/skill-adherence')
    const cmd = new SkillAdherenceCommands()
    const result = await cmd.skillAdherence(windowArg, process.cwd(), { md: mdMode })
    process.exitCode = result.success ? 0 : 1
  } else if (args[0] === 'review-risk') {
    // `prjct review-risk [--md]` — advisory size/delivery-geometry
    // signal (#18/19/20). Read-only; never gates or mutates git.
    const mdMode = args.includes('--md')
    const { ReviewRiskCommands } = await import('../commands/review-risk')
    const cmd = new ReviewRiskCommands()
    const result = await cmd.reviewRisk(null, process.cwd(), { md: mdMode })
    process.exitCode = result.success ? 0 : 1
  } else if (args[0] === 'prefs') {
    // `prjct prefs list|get|check|set|clear [...]` — gstack-inspired
    // per-project AskUserQuestion preferences. The `check` subcommand
    // emits a one-line ASK_NORMALLY|AUTO_DECIDE|NEVER_ASK so a skill
    // preamble can branch on its output.
    const sub = args[1] ?? 'list'
    const positional = args.slice(2).filter((a) => !a.startsWith('-'))
    const reasonIdx = args.indexOf('--reason')
    const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : undefined
    const mdMode = args.includes('--md')
    const { PreferencesCommands } = await import('../commands/preferences')
    const cmd = new PreferencesCommands()
    const result = await cmd.prefs([sub, ...positional], process.cwd(), { md: mdMode, reason })
    process.exitCode = result.success ? 0 : 1
  } else if (args[0] === 'install') {
    // `prjct install` is a convenience alias for `prjct claude install`.
    const { InstallCommands } = await import('../commands/install')
    const cmd = new InstallCommands()
    const mdMode = args.includes('--md')
    const result = await cmd.install(null, process.cwd(), { md: mdMode })
    process.exitCode = result.success ? 0 : 1
  } else if (args[0] === 'claude') {
    // `prjct claude install|uninstall|status` — manage Claude Code hooks in ~/.claude/settings.json.
    const subcommand = args[1] ?? 'status'
    const { InstallCommands } = await import('../commands/install')
    const cmd = new InstallCommands()
    const mdMode = args.includes('--md')
    const result: Awaited<ReturnType<typeof cmd.install>> = await (async () => {
      if (subcommand === 'install') return cmd.install(null, process.cwd(), { md: mdMode })
      if (subcommand === 'uninstall') return cmd.uninstall(null, process.cwd(), { md: mdMode })
      const s = await cmd.status()
      if (s.success) {
        console.log(
          mdMode
            ? `# prjct Claude Code hooks\n\n- installed: ${s.installed}\n- expected: ${s.expected}\n`
            : `installed: ${s.installed}/${s.expected}`
        )
      } else {
        console.error(s.error)
      }
      return s
    })()
    process.exitCode = result.success ? 0 : 1
  } else if (args[0] === 'hook') {
    // `prjct hook <name>` — runs a single Claude Code hook. Invoked by
    // the entries installed via `prjct claude install`. Reads stdin,
    // writes JSON to stdout, exits 0 even on internal failure so the
    // host session is never disturbed.
    const hookName = args[1]
    const projectPath = process.cwd()
    try {
      switch (hookName) {
        case 'session-start': {
          const { runSessionStartHook } = await import('../hooks/session-start')
          await runSessionStartHook(projectPath)
          break
        }
        case 'prompt': {
          const { runPromptHook } = await import('../hooks/prompt')
          await runPromptHook(projectPath)
          break
        }
        case 'pre-bash': {
          const { runPreBashHook } = await import('../hooks/pre-bash')
          await runPreBashHook(projectPath)
          break
        }
        case 'pre-commit': {
          const { runPreCommitHook } = await import('../hooks/pre-commit')
          await runPreCommitHook(projectPath)
          break
        }
        case 'pre-secrets': {
          const { runPreSecretsHook } = await import('../hooks/pre-secrets')
          await runPreSecretsHook(projectPath)
          break
        }
        case 'pre-package': {
          const { runPrePackageHook } = await import('../hooks/pre-package')
          await runPrePackageHook(projectPath)
          break
        }
        case 'pre-edit': {
          const { runPreEditHook } = await import('../hooks/pre-edit')
          await runPreEditHook(projectPath)
          break
        }
        case 'pre-search': {
          const { runPreSearchHook } = await import('../hooks/pre-search')
          await runPreSearchHook(projectPath)
          break
        }
        case 'post-edit': {
          const { runPostEditHook } = await import('../hooks/post-edit')
          await runPostEditHook(projectPath)
          break
        }
        case 'stop': {
          const { runStopHook } = await import('../hooks/stop')
          await runStopHook(projectPath)
          break
        }
        case 'subagent-start': {
          const { runSubagentStartHook } = await import('../hooks/subagent-start')
          await runSubagentStartHook(projectPath)
          break
        }
        case 'subagent-stop': {
          const { runSubagentStopHook } = await import('../hooks/subagent-stop')
          await runSubagentStopHook(projectPath)
          break
        }
        case 'notification': {
          const { runNotificationHook } = await import('../hooks/notification')
          await runNotificationHook(projectPath)
          break
        }
        case 'cwd-changed': {
          const { runCwdChangedHook } = await import('../hooks/cwd-changed')
          await runCwdChangedHook(projectPath)
          break
        }
        default:
          // Unknown hook: emit empty object, stay out of the way.
          process.stdout.write('{}\n')
      }
      process.exitCode = 0
    } catch {
      process.stdout.write('{}\n')
      process.exitCode = 0
    }
  } else if (args[0] === 'crew') {
    // `prjct crew install|uninstall|status|record-run|checkpoints …`
    // Manages the multi-agent crew bundle. Strictly opt-in.
    const subcommand = args[1] ?? 'status'
    const { CrewCommands } = await import('../commands/crew')
    const cmd = new CrewCommands()
    const mdMode = args.includes('--md')
    const getFlag = (name: string): string | undefined => {
      const idx = args.indexOf(`--${name}`)
      if (idx >= 0 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) {
        return args[idx + 1]
      }
      return undefined
    }
    const result: { success: boolean; error?: string } = await (async () => {
      if (subcommand === 'install') return cmd.install(null, process.cwd(), { md: mdMode })
      if (subcommand === 'uninstall') return cmd.uninstall(null, process.cwd(), { md: mdMode })
      if (subcommand === 'status') return cmd.status(null, process.cwd(), { md: mdMode })
      if (subcommand === 'checkpoints') {
        // `prjct crew checkpoints [show|set|reset|export] [--content|--file]`
        const checkpointsSub = args[2] ?? 'show'
        return cmd.checkpoints(checkpointsSub, process.cwd(), {
          md: mdMode,
          content: getFlag('content'),
          file: getFlag('file'),
        })
      }
      if (subcommand === 'record-run') {
        return cmd.recordRun(process.cwd(), {
          md: mdMode,
          spec: getFlag('spec'),
          task: getFlag('task'),
          'implementer-summary': getFlag('implementer-summary'),
          files: getFlag('files'),
          'reviewer-verdict': getFlag('reviewer-verdict'),
          'reviewer-notes': getFlag('reviewer-notes'),
          'run-id': getFlag('run-id'),
        })
      }
      console.error(
        `Unknown crew subcommand: ${subcommand}. Use: install, uninstall, status, checkpoints, record-run.`
      )
      return { success: false, error: `unknown subcommand: ${subcommand}` }
    })()
    process.exitCode = result.success ? 0 : 1
  } else if (args[0] === 'harness') {
    // score | retrieval | audit | instructions [window|set <id> <disposition>] | learn-from | list | use <rig>
    const subcommand = args[1] ?? 'list'
    const { HarnessCommands } = await import('../commands/harness')
    const cmd = new HarnessCommands()
    const mdMode = args.includes('--md')
    const result: { success: boolean; error?: string } = await (async () => {
      if (subcommand === 'score') return cmd.score(process.cwd(), { md: mdMode })
      if (subcommand === 'retrieval') return cmd.retrieval(process.cwd(), { md: mdMode })
      if (subcommand === 'audit') return cmd.audit(process.cwd(), { md: mdMode })
      if (subcommand === 'instructions') {
        if (args[2] === 'set') {
          return cmd.instructionDisposition(args[3] ?? null, args[4] ?? null, process.cwd())
        }
        const window = args[2]?.startsWith('--') ? null : (args[2] ?? null)
        return cmd.instructions(window, process.cwd(), { md: mdMode })
      }
      if (subcommand === 'learn-from') return cmd.learnFrom(process.cwd(), { md: mdMode })
      if (subcommand === 'list') return cmd.list({ md: mdMode })
      if (subcommand === 'use') return cmd.use(args[2] ?? null, process.cwd(), { md: mdMode })
      console.error(
        `Unknown harness subcommand: ${subcommand}. Use: score, retrieval, audit, instructions [24h|7d|14d|30d|set <id> <open|resolved|false-positive>], learn-from, list, use <rig>.`
      )
      return { success: false, error: `unknown subcommand: ${subcommand}` }
    })()
    process.exitCode = result.success ? 0 : 1
  } else if (args[0] === 'doctor') {
    const done = await ctx.trackSession('doctor')
    const { doctorService } = await import('../services/doctor-service')
    const fix = args.includes('--fix') || args.includes('--heal')
    const exitCode = fix
      ? await doctorService.heal(process.cwd())
      : await doctorService.run(process.cwd())
    process.exitCode = exitCode
    done()
  } else if (args[0] === 'uninstall') {
    const { uninstall } = await import('../commands/uninstall')
    const force = args.includes('--force') || args.includes('-f')
    const backup = args.includes('--backup') || args.includes('-b')
    const dryRun = args.includes('--dry-run') || args.includes('-n')
    const keepPackage = args.includes('--keep-package')
    const result = await uninstall({ force, backup, dryRun, keepPackage })
    process.exitCode = result.success ? 0 : 1
  } else if (args[0] === 'watch') {
    const projectPath = process.cwd()
    const projectId = await requireProjectOrExit(projectPath)

    if (projectId) {
      const { watchService } = await import('../services/watch-service')
      const verbose = args.includes('--verbose') || args.includes('-v')
      const debounceArg = args.find((a) => a.startsWith('--debounce='))
      const debounceMs = debounceArg ? parseInt(debounceArg.split('=')[1], 10) : undefined
      const intervalArg = args.find((a) => a.startsWith('--interval='))
      const minIntervalMs = intervalArg ? parseInt(intervalArg.split('=')[1], 10) * 1000 : undefined

      const result = await watchService.start(projectPath, {
        verbose,
        quiet: ctx.isQuietMode,
        debounceMs,
        minIntervalMs,
      })

      if (!result.success) {
        console.error(result.error)
        process.exitCode = 1
      }
    }
  } else if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help') {
    const { getHelp } = await import('../utils/help')
    const topic = args[1]
    console.log(getHelp(topic))
    process.exitCode = 0
  } else if (args[0] === 'version' || args[0] === '-v' || args[0] === '--version') {
    const { resolveUserHome } = await import('../infrastructure/user-home')
    const path = await import('node:path')
    const chalk = (await import('chalk')).default
    const { detectAllProviders, detectAntigravity, detectCodex } = await import(
      '../infrastructure/ai-provider'
    )
    const { listAgentRuntimes } = await import('../infrastructure/agent-runtime-registry')
    const { fileExists } = await import('../utils/file-helper')
    const { VERSION } = await import('../utils/version')
    const detection = await detectAllProviders(ctx.isRefresh)
    const home = resolveUserHome()
    const cwd = process.cwd()
    const [
      claudeConfigured,
      geminiConfigured,
      cursorDetected,
      cursorConfigured,
      codexMcpConfigured,
      agentsMdConfigured,
    ] = await Promise.all([
      fileExists(path.join(home, '.claude', 'CLAUDE.md')),
      fileExists(path.join(home, '.gemini', 'GEMINI.md')),
      fileExists(path.join(cwd, '.cursor')),
      fileExists(path.join(cwd, '.cursor', 'rules', 'prjct.mdc')),
      fileExists(path.join(home, '.codex', 'config.toml')),
      fileExists(path.join(cwd, 'AGENTS.md')),
    ])
    const [codexDetection, antigravityDetection] = await Promise.all([
      detectCodex(),
      detectAntigravity(),
    ])

    const { providerStatusHeader, providerStatusLine } = await import('../utils/provider-status')
    const runtimeCount = listAgentRuntimes().filter((runtime) => runtime.id !== 'agents-md').length
    console.log(providerStatusHeader(VERSION))
    console.log(
      providerStatusLine(
        'Universal AGENTS.md',
        agentsMdConfigured ? 'ready' : 'missing',
        chalk.dim(` (${runtimeCount} runtime profiles in registry)`)
      )
    )
    console.log(
      providerStatusLine(
        'Claude Code',
        detection.claude.installed ? (claudeConfigured ? 'ready' : 'installed') : 'missing',
        detection.claude.version ? chalk.dim(` (v${detection.claude.version})`) : ''
      )
    )
    console.log(
      providerStatusLine(
        'Gemini CLI',
        detection.gemini.installed ? (geminiConfigured ? 'ready' : 'installed') : 'missing',
        detection.gemini.version ? chalk.dim(` (v${detection.gemini.version})`) : ''
      )
    )
    console.log(
      providerStatusLine(
        'OpenAI Codex',
        codexDetection.installed
          ? codexDetection.skillInstalled && codexMcpConfigured
            ? 'ready'
            : 'installed'
          : 'missing',
        codexDetection.installed && !codexDetection.skillInstalled
          ? chalk.dim(' (run prjct start)')
          : codexDetection.installed && !codexMcpConfigured
            ? chalk.dim(' (MCP pending)')
            : ''
      )
    )
    console.log(
      providerStatusLine(
        'Antigravity',
        antigravityDetection.installed
          ? antigravityDetection.skillInstalled
            ? 'ready'
            : 'detected'
          : 'missing',
        antigravityDetection.installed && !antigravityDetection.skillInstalled
          ? chalk.dim(' (run prjct start)')
          : ''
      )
    )
    console.log(
      providerStatusLine(
        'Cursor IDE',
        cursorDetected ? (cursorConfigured ? 'ready' : 'detected') : 'missing',
        cursorDetected ? chalk.dim(' (project)') : '',
        '○ not detected'
      )
    )
    console.log(`
${chalk.dim("Run 'prjct start' to configure global/runtime adapters")}
${chalk.dim("Run 'prjct init' or 'prjct sync' to refresh AGENTS.md and project-level rules")}
${chalk.cyan('https://prjct.app')}
`)
  } else {
    return false
  }
  return true
}

/**
 * Bin-dispatch-level "is this a prjct project" gate: resolves the project
 * id or prints the uniform not-found message and sets `process.exitCode`.
 * Distinct from the async command layer's `requireProject()` (in
 * `core/commands/guards.ts`) — this one is a plain resolve-or-exit for
 * subcommands routed here in `runBinCommand`, not a `Guard<T>` result.
 */
async function requireProjectOrExit(projectPath: string): Promise<string | null> {
  const configManager = (await import('../infrastructure/config-manager')).default
  const projectId = await configManager.getProjectId(projectPath)
  if (!projectId) {
    console.error('No prjct project found. Run "prjct init" first.')
    process.exitCode = 1
    return null
  }
  return projectId
}
