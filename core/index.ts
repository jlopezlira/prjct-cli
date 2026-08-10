/**
 * prjct CLI - Main Entry Point
 *
 * This file is required by bin/prjct after setup verification
 */

import { findClosestCommand } from './commands/closest-command'
import { PrjctCommands } from './commands/commands'
import { mapOptions } from './commands/option-mapper'
import { commandRegistry } from './commands/registry'
import './commands/register' // Ensure commands are registered
import os from 'node:os'
import path from 'node:path'
import chalk from 'chalk'
import { isRemovedVerb, REMOVED_VERBS } from './commands/removed-verbs'
import { routeSpec } from './commands/route-spec'
import { detectAllProviders, detectAntigravity } from './infrastructure/ai-provider'
import configManager from './infrastructure/config-manager'
import performanceTracker from './infrastructure/performance-tracker'
import { sessionTracker } from './services/session-tracker'
import type { CommandMeta, CommandResult } from './types/commands'
import { getErrorMessage, getErrorStack } from './types/fs'
import { getError } from './utils/error-messages'
import { fileExists } from './utils/file-helper'
import out from './utils/output'
import { providerStatusHeader, providerStatusLine } from './utils/provider-status'

interface ParsedCommandArgs {
  parsedArgs: string[]
  options: Record<string, string | boolean>
}

async function main(): Promise<void> {
  const [initialCommandName, ...initialRawArgs] = process.argv.slice(2)

  // === SPECIAL COMMANDS (version, help) ===

  if (['-v', '--version', 'version'].includes(initialCommandName)) {
    const packageJson = await import('../package.json')
    await displayVersion(packageJson.version)
    process.exit(0)
  }

  if (['-h', '--help', undefined].includes(initialCommandName)) {
    displayHelp()
    process.exit(0)
  }

  // === v2 removed verbs: short-circuit with migration message ===
  // Workflow verbs that existed in v1.x (done/pause/resume/next/bug/idea/
  // linear/jira/…) were deleted during the v2 cleanup. They must not
  // reach the GTD auto-route below, which would silently capture them as
  // inbox notes — a quiet data-loss bug since users expect `prjct done`
  // to complete the active task. See `core/commands/removed-verbs.ts`.
  if (
    initialCommandName &&
    isRemovedVerb(initialCommandName) &&
    !commandRegistry.getByName(initialCommandName)
  ) {
    const entry = REMOVED_VERBS[initialCommandName]
    if (entry) {
      out.failWithHint({
        message: `'prjct ${initialCommandName}' was removed in v2. ${entry.note}`,
        hint: `Use: ${entry.replacement}`,
      })
      process.exit(1)
    }
  }

  // === v2 auto-route: unknown verb → prjct capture "<full args>" ===
  // GTD-style: 80% of dumps during the day aren't commitments — they're
  // inbox items. Capture writes memory with `type=inbox` without the
  // ceremony of a task (no id, no branch, no worktree). If Claude
  // later wants structure, it can retype via a clarify workflow.
  //
  // Explicit verbs (task, ship, tag, capture, …) still win.
  //
  // Exception: a single-word input that's a near-match of a real verb
  // (edit distance ≤ 2, no whitespace) is probably a typo. Surface the
  // did-you-mean instead of silently capturing "shipp".
  const shouldCapture =
    Boolean(initialCommandName) &&
    !commandRegistry.getByName(initialCommandName) &&
    !(initialRawArgs.length === 0 && findClosestCommand(initialCommandName as string) !== null)
  const commandName = shouldCapture ? 'capture' : initialCommandName
  const rawArgs = shouldCapture
    ? [
        [initialCommandName, ...initialRawArgs.filter((arg) => !arg.startsWith('-'))].join(' '),
        ...initialRawArgs.filter((arg) => arg.startsWith('-')),
      ]
    : initialRawArgs

  // === DYNAMIC COMMAND EXECUTION ===

  // Show branding header (skip in --md mode — LLM output is self-contained)
  const isMdMode = rawArgs.includes('--md')
  if (!isMdMode) out.start()

  try {
    // 1. Find command in registry
    const cmd = commandRegistry.getByName(commandName)

    if (!cmd) {
      const suggestion = findClosestCommand(commandName)
      const hint = suggestion
        ? `Did you mean 'prjct ${suggestion}'? Run 'prjct --help' for all commands`
        : "Run 'prjct --help' to see available commands"
      out.failWithHint(
        getError('UNKNOWN_COMMAND', { message: `Unknown command: ${commandName}`, hint })
      )
      if (!isMdMode) out.end()
      process.exit(1)
    }

    // 2. Check if deprecated
    if (cmd.deprecated) {
      const hint = cmd.replacedBy
        ? `Use 'prjct ${cmd.replacedBy}' instead`
        : "Run 'prjct --help' to see available commands"
      out.failWithHint({ message: `Command '${commandName}' is deprecated`, hint })
      if (!isMdMode) out.end()
      process.exit(1)
    }

    // 3. Check if implemented
    if (!cmd.implemented) {
      out.failWithHint({
        message: `Command '${commandName}' is not yet implemented`,
        hint: "Run 'prjct --help' to see available commands",
        docs: 'https://github.com/prjct-app/cli',
      })
      if (!isMdMode) out.end()
      process.exit(1)
    }

    // 4. Parse arguments
    const { parsedArgs, options } = parseCommandArgs(cmd, rawArgs)

    // 4.5. Block commands that require LLM processing when run in raw terminal
    const isLlmContext = !process.stdin.isTTY || options.md === true || options.json === true
    if (cmd.requiresLlm && !isLlmContext) {
      out.failWithHint({
        message: `'prjct ${commandName}' requires an AI agent to process its output`,
        hint: `Use 'p. ${commandName}' inside Claude/Cursor, or add --md flag`,
      })
      if (!isMdMode) out.end()
      process.exit(1)
    }

    // 4.6. Validate required params
    const paramError = validateCommandParams(cmd, parsedArgs)
    if (paramError) {
      out.failWithHint(paramError)
      if (!isMdMode) out.end()
      process.exit(1)
    }

    // 4.6. Session tracking — touch/create session before command execution
    const commandStartTime = Date.now()
    const projectId = await (async (): Promise<string | null> => {
      try {
        const id = await configManager.getProjectId(process.cwd())
        if (id) {
          await sessionTracker.expireIfStale(id)
          await sessionTracker.touch(id)
        }
        return id
      } catch {
        return null
      }
    })()

    // 5. Instantiate commands handler
    const commands = new PrjctCommands()

    // 6. Execute command
    const result: CommandResult | undefined = await (async () => {
      if (commandName === 'analyze') return commands.analyze(options)
      if (commandName === 'setup') return commands.setup(options)
      if (commandName === 'update' || commandName === 'upgrade') return commands.update(options)

      // Standard commands - type-safe invocation
      const param = parsedArgs.join(' ') || null
      const md = options.md === true

      // Manifest-driven: a schema-covered command routes through the SAME
      // generic mapper as the daemon path (dispatch.ts), so cold and daemon
      // flag handling cannot diverge — the historical "works in terminal,
      // broken via daemon" class.
      const meta = commandRegistry.getByName(commandName)
      if (meta?.optionSchema) {
        return commandRegistry.executeWithOptions(
          commandName,
          param,
          process.cwd(),
          mapOptions(options, meta.optionSchema)
        )
      } else {
        // Complex-signature commands only (object params, no-projectPath
        // shapes, multi-positional routing) — everything else belongs in
        // the manifest's optionSchema.
        const standardCommands: Record<string, (p: string | null) => Promise<CommandResult>> = {
          // SDD: spec verb. The CLI uses `prjct spec ...`, but Claude
          // typically calls `prjct spec list/show/audit/...` via subcommand
          // syntax — `parsedArgs[0]` carries the subverb when present.
          spec: (p) =>
            routeSpec(
              commands,
              (p ?? '').trim().split(/\s+/).filter(Boolean),
              options,
              process.cwd()
            ),
          intent: (p) =>
            routeSpec(
              commands,
              (p ?? '').trim().split(/\s+/).filter(Boolean),
              options,
              process.cwd()
            ),
          'audit-spec': (p) =>
            p
              ? commands.specAudit(p, process.cwd(), {
                  md,
                  lenses: options.lenses ? String(options.lenses) : undefined,
                })
              : Promise.resolve({ success: false, error: 'audit-spec requires a spec id' }),
          // Planning — init accepts --pack / --persona / --yes to pre-seed
          // packs and persona without the interactive wizard.
          init: (p) =>
            commands.init({
              idea: p,
              yes: options.yes === true,
              pack: options.pack ? String(options.pack) : undefined,
              persona: options.persona ? String(options.persona) : undefined,
            }),
          sync: () =>
            commands.sync(process.cwd(), {
              preview: options.preview === true || options['dry-run'] === true,
              yes: options.yes === true,
              json: options.json === true,
              md,
              package: options.package ? String(options.package) : undefined,
              full: options.full === true,
            }),
          'analysis-save-llm': (p) =>
            p
              ? commands.saveLlmAnalysis(p, process.cwd(), { md })
              : Promise.resolve({
                  success: false,
                  error: 'analysis-save-llm requires analysis text, JSON, or a file path',
                }),
          start: () => commands.start(),
          // Auth (cloud sync)
          login: () => commands.login({ md }),
          logout: () => commands.logout(),
          auth: (p) => commands.auth(p, { md }),
        }

        const handler = standardCommands[commandName]
        if (handler) return handler(param)
        throw new Error(`Command '${commandName}' has no handler`)
      }
    })()

    // 7. Track command in session + performance metrics
    if (projectId) {
      const durationMs = Date.now() - commandStartTime
      try {
        await sessionTracker.trackCommand(projectId, commandName, durationMs)
      } catch {
        // Non-critical
      }

      // Performance tracking (non-critical)
      try {
        // Record command duration
        await performanceTracker.recordTiming(projectId, 'command_duration', durationMs, {
          command: commandName,
        })

        // Record startup time (from bin/prjct.ts marker if available)
        const perfStartNs = (globalThis as Record<string, unknown>).__perfStartNs as
          | bigint
          | undefined
        if (perfStartNs) {
          const startupMs = Number(process.hrtime.bigint() - perfStartNs) / 1_000_000
          await performanceTracker.recordTiming(projectId, 'startup_time', startupMs)
        }

        // Record memory snapshot
        await performanceTracker.recordMemory(projectId, { command: commandName })
      } catch {
        // Performance tracking is non-critical
      }
    }

    // 8. Display result
    if (result?.message) {
      console.log(result.message)
    } else if (result?.error) {
      console.error(result.error)
    }

    // Show branding footer
    if (!isMdMode) out.end()
    process.exit(result?.success ? 0 : 1)
  } catch (error) {
    console.error('Error:', getErrorMessage(error))
    if (process.env.DEBUG) {
      console.error(getErrorStack(error))
    }
    // Show branding footer even on error
    if (!isMdMode) out.end()
    process.exit(1)
  }
}

/**
 * Route `prjct spec [<sub-verb>] [args...]` to the right SDD method.
 *
 * Subverbs: list | show | update | set-status | record-review | link-task |
 *           ship | audit
 *
 * Bare `prjct spec "<title>"` falls through to the default `draft` action.
 * `param` is the joined positional args (subverb + spec id when present).
 */

/**
 * Validate that required params are provided
 * Parses CommandMeta.params: <required> vs [optional]
 */
function validateCommandParams(
  cmd: CommandMeta,
  parsedArgs: string[]
): import('./types/errors').ErrorWithHint | null {
  if (!cmd.params) return null

  // Extract required params: tokens wrapped in <angle brackets>, ignoring
  // optional groups such as `[--flag <value>]`.
  const requiredParamSource = cmd.params.replace(/\[[^\]]*\]/g, '')
  const requiredParams = requiredParamSource.match(/<[^>]+>/g)
  if (!requiredParams || requiredParams.length === 0) return null

  if (parsedArgs.length < requiredParams.length) {
    const paramNames = requiredParams.map((p) => p.slice(1, -1)).join(', ')
    const usage = cmd.usage.terminal || `prjct ${cmd.name} ${cmd.params}`
    return getError('MISSING_PARAM', {
      message: `Missing required parameter: ${paramNames}`,
      hint: `Usage: ${usage}`,
    })
  }

  return null
}

/**
 * Parse command arguments dynamically
 */
function parseCommandArgs(_cmd: CommandMeta, rawArgs: string[]): ParsedCommandArgs {
  const parsedArgs: string[] = []
  const options: Record<string, string | boolean> = {}

  const parseAt = (index: number): void => {
    if (index >= rawArgs.length) return
    const arg = rawArgs[index]
    if (arg.startsWith('--')) {
      // Handle flags
      const flagName = arg.slice(2)

      if (index + 1 < rawArgs.length && !rawArgs[index + 1].startsWith('--')) {
        options[flagName] = rawArgs[index + 1]
        parseAt(index + 2)
      } else {
        options[flagName] = true
        parseAt(index + 1)
      }
    } else {
      parsedArgs.push(arg)
      parseAt(index + 1)
    }
  }
  parseAt(0)

  return { parsedArgs, options }
}

// Colors via chalk (respects NO_COLOR env)

/**
 * Display version with provider status
 */
async function displayVersion(version: string): Promise<void> {
  const detection = await detectAllProviders()

  const claudeCommandPath = path.join(os.homedir(), '.claude', 'commands', 'p.md')
  const geminiCommandPath = path.join(os.homedir(), '.gemini', 'commands', 'p.toml')
  const [claudeConfigured, geminiConfigured, cursorConfigured, cursorExists] = await Promise.all([
    fileExists(claudeCommandPath),
    fileExists(geminiCommandPath),
    fileExists(path.join(process.cwd(), '.cursor', 'commands', 'sync.md')),
    fileExists(path.join(process.cwd(), '.cursor')),
  ])

  // Antigravity status (global, skills-based)
  const antigravityDetection = await detectAntigravity()

  console.log(providerStatusHeader(version))
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
      'Antigravity',
      antigravityDetection.installed
        ? antigravityDetection.skillInstalled
          ? 'ready'
          : 'detected'
        : 'missing',
      antigravityDetection.installed && !antigravityDetection.skillInstalled
        ? ` ${chalk.dim('(run prjct start)')}`
        : ''
    )
  )
  console.log(
    providerStatusLine(
      'Cursor IDE',
      cursorConfigured ? 'ready' : cursorExists ? 'detected' : 'missing',
      cursorConfigured
        ? ` ${chalk.dim('(use prjct router)')}`
        : cursorExists
          ? ` ${chalk.dim('(run prjct init)')}`
          : '',
      '○ no .cursor/ folder'
    )
  )

  console.log(`
${chalk.dim("Run 'prjct start' for Claude/Gemini, 'prjct init' for Cursor")}
${chalk.cyan('https://prjct.app')}
`)
}

/**
 * Display help using registry
 */
function displayHelp(): void {
  console.log(`
prjct - Context layer for AI coding agents
Works with Claude Code, Gemini CLI, Antigravity, Cursor IDE, and more.

QUICK START
-----------
  Claude/Gemini:
    1. prjct start              Configure your AI provider
    2. cd my-project && prjct init
    3. Open in Claude Code or Gemini CLI
    4. Type: p. sync            Analyze project

  Cursor IDE:
    1. cd my-project && prjct init
    2. Open in Cursor
    3. Use router command: /sync or run prjct sync --md

COMMANDS (inside your AI agent)
-------------------------------
  Claude/Gemini          Cursor            Description
  ─────────────────────────────────────────────────────
  p. sync                /sync             Analyze project
  p. work "intent"       /work "intent"    Start a work cycle
  p. performance         /performance      Measure work efficiency
  p. ship "name"         /ship "name"      Ship with PR

TERMINAL COMMANDS (this CLI)
----------------------------
  prjct start            First-time setup (Claude/Gemini global config)
  prjct init             Initialize project (required for Cursor)
  prjct setup            Reconfigure installations
  prjct sync             Sync project state
  prjct search "<q>"     Search project memory (decisions, learnings, gotchas)
  prjct watch            Auto-sync on file changes (Ctrl+C to stop)
  prjct hooks            Manage git hooks for auto-sync
  prjct doctor           Check system health and dependencies

EXAMPLES
--------
  # Claude Code / Gemini CLI (global setup, then per-project)
  $ prjct start
  $ cd my-project && prjct init
  > p. sync
  > p. work "add user authentication"

  # Cursor IDE (per-project only)
  $ cd my-project && prjct init
  > /sync
  > /task "add user authentication"

FLAGS
-----
  --quiet, -q            Suppress all output (only errors to stderr)
  --version, -v          Show version
  --help, -h             Show this help

MORE INFO
---------
  Documentation:  https://prjct.app
  GitHub:         https://github.com/prjct-app/cli
`)
}

// Run CLI
main().catch((error) => {
  console.error('Fatal error:', getErrorMessage(error))
  if (process.env.DEBUG) {
    console.error(getErrorStack(error))
  }
  process.exit(1)
})
