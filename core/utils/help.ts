/**
 * Help System - Structured help output for prjct CLI
 *
 * Provides consistent, well-formatted help text for all commands.
 * Every command list/detail below is derived from the COMMANDS manifest
 * (core/commands/command-data.ts) — there is NO hand-maintained duplicate
 * list to drift out of sync with the registry.
 *
 * @see PRJ-133
 */

import chalk from 'chalk'
import { CATEGORIES, COMMANDS } from '../commands/command-data'
import type { CommandMeta } from '../types/commands'
import { VERSION } from './version'

/**
 * Terminal commands that run directly in the shell. Derived from the
 * manifest: a command is terminal-facing when it is handled by the bin
 * dispatcher (`routingMode: 'bin-only'` — the daemon never sees it) or
 * when it simply has no in-agent (`p.`) usage. Legacy aliases and
 * internal commands stay hidden.
 */
function terminalCommands(): CommandMeta[] {
  return COMMANDS.filter(
    (c) =>
      Boolean(c.usage?.terminal) &&
      (c.routingMode === 'bin-only' || !c.usage?.claude) &&
      c.surface !== 'legacy' &&
      c.surface !== 'internal'
  )
}

/**
 * Global CLI flags
 */
const GLOBAL_FLAGS = [
  { flag: '-q, --quiet', description: 'Suppress all output (errors to stderr only)' },
  { flag: '-v, --version', description: 'Show version and provider status' },
  { flag: '-h, --help', description: 'Show this help message' },
]

function formatMainHelp(): string {
  const lines: string[] = []

  // Header
  lines.push('')
  lines.push(`${chalk.cyan.bold('prjct')} v${VERSION} - The agentic harness for AI coding agents`)
  lines.push(chalk.dim('Intent → context → execution → learning → performance improvement.'))
  lines.push('')

  // Quick Start
  lines.push(chalk.bold('QUICK START'))
  lines.push(chalk.dim('─'.repeat(60)))
  lines.push(
    `  ${chalk.green('1.')} prjct start              ${chalk.dim('# Configure AI providers')}`
  )
  lines.push(`  ${chalk.green('2.')} cd my-project && prjct init`)
  lines.push(`  ${chalk.green('3.')} Open in Claude Code / Gemini CLI / Cursor`)
  lines.push(`  ${chalk.green('4.')} p. work "improve auth"   ${chalk.dim('# Start a work cycle')}`)
  lines.push(
    chalk.dim('     p. = the in-agent command router; from a shell use `prjct work "…"` instead')
  )
  lines.push('')

  // Terminal Commands (derived from the manifest — cannot drift from it)
  lines.push(chalk.bold('TERMINAL COMMANDS'))
  lines.push(chalk.dim('─'.repeat(60)))
  for (const cmd of terminalCommands()) {
    const name = `prjct ${cmd.name}`.padEnd(22)
    lines.push(`  ${name} ${cmd.description}`)
  }
  lines.push('')

  // AI Agent Commands
  lines.push(`${chalk.bold('AI AGENT COMMANDS')} ${chalk.dim('(inside Claude/Gemini/Cursor)')}`)
  lines.push(chalk.dim('─'.repeat(60)))
  lines.push(`  ${'Command'.padEnd(22)} Description`)
  lines.push(`  ${chalk.dim('─'.repeat(56))}`)

  // Core commands
  const coreCommands = COMMANDS.filter((c) => c.surface === 'ai-agile' && c.usage?.claude)
  for (const cmd2 of coreCommands.slice(0, 10)) {
    const usage = `p. ${cmd2.name}`.padEnd(22)
    lines.push(`  ${usage} ${cmd2.description}`)
  }
  if (coreCommands.length > 10) {
    lines.push(
      `  ${chalk.dim(`... and ${coreCommands.length - 10} more (run 'prjct help commands')`)}`
    )
  }
  lines.push(
    chalk.dim('  These also run from the terminal (`prjct work "…"`) — see prjct help <command>.')
  )
  lines.push('')

  // Global Flags
  lines.push(chalk.bold('FLAGS'))
  lines.push(chalk.dim('─'.repeat(60)))
  for (const flag of GLOBAL_FLAGS) {
    lines.push(`  ${flag.flag.padEnd(22)} ${flag.description}`)
  }
  lines.push('')
  lines.push(
    chalk.dim(
      '  Short flags are per-command: -v is --version globally but verbose in `prjct watch`;'
    )
  )
  lines.push(
    chalk.dim('  -f is force (stop/uninstall), follow (daemon logs) or foreground (daemon start);')
  )
  lines.push(chalk.dim('  -n is dry-run (uninstall) but line count (daemon logs).'))
  lines.push('')

  // More Info
  lines.push(chalk.bold('MORE INFO'))
  lines.push(chalk.dim('─'.repeat(60)))
  lines.push(`  Documentation:  ${chalk.cyan('https://prjct.app')}`)
  lines.push(`  GitHub:         ${chalk.cyan('https://github.com/prjct-app/cli')}`)
  lines.push(`  Per-command:    prjct help <command>  (or: prjct <command> --help)`)
  lines.push('')

  return lines.join('\n')
}

function manifestHelpTitle(cmd: CommandMeta): string {
  return cmd.usage?.claude ? `p. ${cmd.name}` : `prjct ${cmd.name}`
}

function manifestListLabel(cmd: CommandMeta): string {
  return cmd.usage?.claude ? `p. ${cmd.name}` : `prjct ${cmd.name}`
}

function formatManifestCommandHelp(cmd: CommandMeta): string {
  const lines: string[] = []

  lines.push('')
  lines.push(`${chalk.cyan.bold(manifestHelpTitle(cmd))} - ${cmd.description}`)
  lines.push('')

  lines.push(chalk.bold('USAGE'))
  if (cmd.usage?.claude) {
    lines.push(`  Claude/Gemini:  ${cmd.usage.claude}`)
  }
  if (cmd.usage?.terminal) {
    lines.push(`  Terminal:       ${cmd.usage.terminal}`)
  }
  lines.push('')

  if (cmd.params) {
    lines.push(chalk.bold('PARAMETERS'))
    lines.push(`  ${cmd.params}`)
    lines.push('')
  }

  if (cmd.features && cmd.features.length > 0) {
    lines.push(chalk.bold('FEATURES'))
    for (const feature of cmd.features) {
      lines.push(`  • ${feature}`)
    }
    lines.push('')
  }

  if (cmd.blockingRules) {
    lines.push(chalk.bold('REQUIREMENTS'))
    lines.push(`  ${chalk.yellow('⚠')} ${cmd.blockingRules.check}`)
    lines.push('')
  }

  // Category info
  const category = CATEGORIES[cmd.group]
  if (category) {
    lines.push(chalk.dim(`Category: ${category.title}`))
    if (cmd.isOptional) {
      lines.push(chalk.dim('This is an optional command.'))
    }
    lines.push('')
  }

  return lines.join('\n')
}

function formatCommandHelp(commandName: string): string {
  const cmd = COMMANDS.find((c) => c.name === commandName)
  if (cmd) return formatManifestCommandHelp(cmd)

  // Command not found
  return `
${chalk.yellow(`Command '${commandName}' not found.`)}

Run 'prjct help' to see all available commands.
`
}

function formatCommandList(): string {
  const lines: string[] = []

  lines.push('')
  lines.push(chalk.cyan.bold('Harness Commands'))
  lines.push('')

  // Group by category
  const categories = Object.entries(CATEGORIES).sort((a, b) => a[1].order - b[1].order)

  for (const [categoryKey, category] of categories) {
    const categoryCommands = COMMANDS.filter(
      (c) => c.group === categoryKey && c.surface !== 'legacy' && c.surface !== 'internal'
    )
    if (categoryCommands.length === 0) continue

    lines.push(
      `${chalk.bold(category.title)} ${chalk.dim(`(${categoryCommands.length} commands)`)}`
    )
    lines.push(chalk.dim(category.description))
    lines.push('')

    for (const cmd of categoryCommands) {
      const name = manifestListLabel(cmd).padEnd(18)
      const desc =
        cmd.description.length > 45 ? `${cmd.description.slice(0, 42)}...` : cmd.description
      lines.push(`  ${name} ${desc}`)
    }
    lines.push('')
  }

  lines.push(chalk.dim("Run 'prjct help <command>' for detailed help on a specific command."))
  lines.push('')

  return lines.join('\n')
}

/**
 * Get help output based on topic
 */
export function getHelp(topic?: string): string {
  if (!topic) {
    return formatMainHelp()
  }

  if (topic === 'commands' || topic === 'all') {
    return formatCommandList()
  }

  return formatCommandHelp(topic)
}
