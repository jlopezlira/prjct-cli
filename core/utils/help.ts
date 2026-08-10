/**
 * Help System - Structured help output for prjct CLI
 *
 * Provides consistent, well-formatted help text for all commands.
 *
 * @see PRJ-133
 */

import chalk from 'chalk'
import { CATEGORIES, COMMANDS } from '../commands/command-data'
import type { CommandMeta } from '../types/commands'
import { VERSION } from './version'

/**
 * Terminal commands that run directly in the shell
 */
const TERMINAL_COMMANDS = [
  {
    name: 'start',
    description: 'First-time setup wizard',
    example: 'prjct start',
  },
  {
    name: 'init',
    description: 'Initialize project in current directory',
    example: 'prjct init',
  },
  {
    name: 'sync',
    description: 'Refresh RAG indexes and context quality',
    example: 'prjct sync',
  },
  {
    name: 'search',
    description: 'Search project memory (decisions, learnings, gotchas)',
    example: 'prjct search "auth refresh"',
    options: ['--md'],
  },
  {
    name: 'forget',
    description: 'Delete a project memory entry by id',
    example: 'prjct forget mem_1234',
    options: ['--md'],
  },
  {
    name: 'close',
    description: 'Resolve a memory entry (leaves rotation + audit)',
    example: 'prjct close mem_1234 --reason "fixed"',
    options: ['--reason', '--md'],
  },
  {
    name: 'dream',
    description: 'Consolidate memory + rebuild L0 index (auto-dream)',
    example: 'prjct dream --force',
    options: ['--force', '--dry-run', '--md'],
  },
  {
    name: 'watch',
    description: 'Auto-sync on file changes',
    example: 'prjct watch',
    options: ['--verbose', '--debounce=<ms>', '--interval=<sec>'],
  },
  {
    name: 'hooks',
    description: 'Manage git hooks for auto-sync',
    example: 'prjct hooks install',
    subcommands: ['install', 'uninstall', 'status'],
  },
  {
    name: 'doctor',
    description: 'Check system health and dependencies',
    example: 'prjct doctor',
  },
  {
    name: 'context',
    description: 'Memory-bound context tools for AI',
    example: 'prjct context memory "auth"',
    subcommands: ['memory', 'learnings'],
  },
  {
    name: 'stop',
    description: 'Stop the background daemon',
    example: 'prjct stop',
    options: ['--force'],
  },
  {
    name: 'restart',
    description: 'Restart the background daemon',
    example: 'prjct restart',
  },
  {
    name: 'uninstall',
    description: 'Complete system removal of prjct',
    example: 'prjct uninstall --backup',
    options: ['--force', '--backup', '--dry-run', '--keep-package'],
  },
]

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
  lines.push('')

  // Terminal Commands
  lines.push(chalk.bold('TERMINAL COMMANDS'))
  lines.push(chalk.dim('─'.repeat(60)))
  for (const cmd of TERMINAL_COMMANDS) {
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
  lines.push('')

  // Global Flags
  lines.push(chalk.bold('FLAGS'))
  lines.push(chalk.dim('─'.repeat(60)))
  for (const flag of GLOBAL_FLAGS) {
    lines.push(`  ${flag.flag.padEnd(22)} ${flag.description}`)
  }
  lines.push('')

  // More Info
  lines.push(chalk.bold('MORE INFO'))
  lines.push(chalk.dim('─'.repeat(60)))
  lines.push(`  Documentation:  ${chalk.cyan('https://prjct.app')}`)
  lines.push(`  GitHub:         ${chalk.cyan('https://github.com/prjct-app/cli')}`)
  lines.push(`  Per-command:    prjct help <command>`)
  lines.push('')

  return lines.join('\n')
}

function formatTerminalCommandHelp(commandName: string): string | null {
  const cmd = TERMINAL_COMMANDS.find((c) => c.name === commandName)
  if (!cmd) return null

  const lines: string[] = []

  lines.push('')
  lines.push(`${chalk.cyan.bold(`prjct ${cmd.name}`)} - ${cmd.description}`)
  lines.push('')

  lines.push(chalk.bold('USAGE'))
  lines.push(`  ${cmd.example}`)
  lines.push('')

  if (cmd.options) {
    lines.push(chalk.bold('OPTIONS'))
    for (const opt of cmd.options) {
      lines.push(`  ${opt}`)
    }
    lines.push('')
  }

  if (cmd.subcommands) {
    lines.push(chalk.bold('SUBCOMMANDS'))
    for (const sub of cmd.subcommands) {
      lines.push(`  ${sub}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function manifestHelpTitle(cmd: CommandMeta): string {
  return cmd.usage?.claude ? `p. ${cmd.name}` : `prjct ${cmd.name}`
}

function manifestListLabel(cmd: CommandMeta): string {
  return cmd.usage?.claude ? `p. ${cmd.name}` : `prjct ${cmd.name}`
}

function formatAgentCommandHelp(commandName: string): string | null {
  const cmd = COMMANDS.find((c) => c.name === commandName)
  if (!cmd) return null

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
  // Try terminal command first
  const terminalHelp = formatTerminalCommandHelp(commandName)
  if (terminalHelp) return terminalHelp

  // Try agent command
  const agentHelp = formatAgentCommandHelp(commandName)
  if (agentHelp) return agentHelp

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
