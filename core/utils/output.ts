/**
 * Unified Output System for prjct-cli
 * Spinner while working → Single line result
 * With prjct branding
 *
 * Supports --quiet mode for CI/CD and scripting
 * Supports output tiers: silent, minimal, compact, verbose
 *
 * @see PRJ-105, PRJ-130
 */

import chalk from 'chalk'
import type { ErrorCode, ErrorWithHint } from '../types/errors'
import type { Output, OutputMetrics, OutputTier, TierConfig } from '../types/output'
import branding from './branding'
import { OUTPUT_LIMITS } from './constants'
import { getError } from './error-messages'

const SPEED = branding.spinner.speed

export const OUTPUT_TIERS: Record<OutputTier, TierConfig> = {
  silent: { maxLines: 0, maxCharsPerLine: 0, showMetrics: false },
  minimal: { maxLines: 1, maxCharsPerLine: 65, showMetrics: false },
  compact: { maxLines: 4, maxCharsPerLine: 80, showMetrics: true },
  verbose: { maxLines: Infinity, maxCharsPerLine: Infinity, showMetrics: true },
} as const

// Mutable runtime details live behind one stable binding.
const outputState: {
  currentTier: OutputTier
  interval: ReturnType<typeof setInterval> | null
  frame: number
  quietMode: boolean
} = { currentTier: 'compact', interval: null, frame: 0, quietMode: false }

/**
 * Set the output tier
 */
export function setOutputTier(tier: OutputTier): void {
  outputState.currentTier = tier
}

/**
 * Get current output tier
 */
export function getOutputTier(): OutputTier {
  return outputState.currentTier
}

/**
 * Get current tier config
 */
export function getTierConfig(): TierConfig {
  return OUTPUT_TIERS[outputState.currentTier]
}

/**
 * Centralized icons for consistent output
 */
const ICONS = {
  success: chalk.green('✓'),
  fail: chalk.red('✗'),
  warn: chalk.yellow('⚠'),
  info: chalk.blue('ℹ'),
  debug: chalk.dim('🔧'),
  bullet: chalk.dim('•'),
  arrow: chalk.dim('→'),
  check: chalk.green('✓'),
  cross: chalk.red('✗'),
  spinner: chalk.cyan('◐'),
} as const

/**
 * Enable quiet mode (no stdout, only stderr for errors)
 */
export function setQuietMode(enabled: boolean): void {
  outputState.quietMode = enabled
}

/**
 * Truncate string to max chars (uses tier config if no max specified)
 */
const truncate = (s: string | undefined | null, max?: number): string => {
  // Agent/pipe context (no TTY on either stream): never truncate — agents act
  // on full messages, and a 65-char error with an ellipsis is undebuggable.
  if (!process.stdout.isTTY && !process.stderr.isTTY) return s || ''
  const limit = max ?? (getTierConfig().maxCharsPerLine || OUTPUT_LIMITS.FALLBACK_TRUNCATE)
  return s && s.length > limit ? `${s.slice(0, limit - 1)}…` : s || ''
}

/**
 * Limit output to maxLines (respects tier config)
 * Returns truncated content with "...N more lines" indicator
 */
/**
 * Limit output to maxLines (respects tier config)
 * Returns truncated content with "...N more lines" indicator
 */
export function limitLines(content: string, maxLines?: number): string {
  const limit = maxLines ?? getTierConfig().maxLines
  if (limit === Infinity || limit === 0) return content

  const lines = content.split('\n')
  if (lines.length <= limit) return content

  const shown = lines.slice(0, limit)
  const remaining = lines.length - limit
  return `${shown.join('\n')}\n${chalk.dim(`...${remaining} more lines`)}`
}

/**
 * Format data for human-readable output (respects tier)
 * Use this instead of JSON.stringify for CLI output
 */
export function formatForHuman(data: unknown): string {
  const tier = getTierConfig()

  if (outputState.currentTier === 'silent') return ''
  if (outputState.currentTier === 'verbose') return JSON.stringify(data, null, 2)

  // For minimal/compact: extract key info
  if (typeof data !== 'object' || data === null) {
    return truncate(String(data), tier.maxCharsPerLine)
  }

  const obj = data as Record<string, unknown>

  // Linear issue format
  if ('identifier' in obj && 'title' in obj) {
    const lines: string[] = []
    lines.push(`${obj.identifier}: ${truncate(String(obj.title), tier.maxCharsPerLine - 10)}`)
    if (obj.status) lines.push(`Status: ${obj.status}`)
    if (obj.priority && obj.priority !== 'none') lines.push(`Priority: ${obj.priority}`)
    if (obj.url && outputState.currentTier === 'compact') lines.push(chalk.dim(String(obj.url)))
    return limitLines(lines.join('\n'), tier.maxLines)
  }

  // Issue list format
  if ('issues' in obj && Array.isArray(obj.issues)) {
    const issues = obj.issues as Array<Record<string, unknown>>
    const lines = issues.slice(0, tier.maxLines).map((i) => {
      const priority = i.priority && i.priority !== 'none' ? ` [${i.priority}]` : ''
      return `${i.identifier}  ${truncate(String(i.title), OUTPUT_LIMITS.ISSUE_TITLE)}${priority}`
    })
    if (issues.length > tier.maxLines) {
      lines.push(chalk.dim(`...${issues.length - tier.maxLines} more`))
    }
    return lines.join('\n')
  }

  // Generic object: show key fields only
  const keyFields = ['id', 'name', 'title', 'status', 'message', 'success', 'error']
  const relevant = keyFields.filter((k) => k in obj)
  if (relevant.length > 0) {
    return limitLines(
      relevant
        .map((k) => `${k}: ${truncate(String(obj[k]), tier.maxCharsPerLine - k.length - 2)}`)
        .join('\n'),
      tier.maxLines
    )
  }

  // Fallback: compact JSON
  return limitLines(JSON.stringify(data, null, 2), tier.maxLines)
}

const clear = (): boolean =>
  process.stdout.isTTY ? process.stdout.write(`\r${' '.repeat(OUTPUT_LIMITS.CLEAR_WIDTH)}\r`) : true

const out: Output = {
  // Branding: Show header at start
  start() {
    if (!outputState.quietMode) console.log(branding.cli.header())
    return this
  },

  // Branding: Show footer at end
  end() {
    if (!outputState.quietMode) console.log(branding.cli.footer())
    return this
  },

  // Branded spinner: prjct message...
  // In non-TTY (CI, Claude Code), prints a static line instead of animating
  spin(msg: string) {
    if (outputState.quietMode) return this
    this.stop()
    if (!process.stdout.isTTY) {
      process.stdout.write(`${branding.cli.spin(0, truncate(msg, OUTPUT_LIMITS.SPINNER_MSG))}\n`)
      return this
    }
    outputState.interval = setInterval(() => {
      process.stdout.write(
        `\r${branding.cli.spin(outputState.frame++, truncate(msg, OUTPUT_LIMITS.SPINNER_MSG))}`
      )
    }, SPEED)
    return this
  },

  done(msg: string, metrics?: OutputMetrics) {
    this.stop()
    if (!outputState.quietMode) {
      // Build metrics suffix if provided: [2a | 97% | 45K]
      const parts: string[] = []
      if (metrics?.agents !== undefined) parts.push(`${metrics.agents}a`)
      if (metrics?.reduction !== undefined) parts.push(`${metrics.reduction}%`)
      if (metrics?.tokens !== undefined) parts.push(`${Math.round(metrics.tokens)}K`)
      const suffix = parts.length > 0 ? chalk.dim(` [${parts.join(' | ')}]`) : ''
      console.log(`${ICONS.success} ${truncate(msg, OUTPUT_LIMITS.DONE_MSG)}${suffix}`)
    }
    return this
  },

  // Errors go to stderr even in quiet mode
  fail(msg: string) {
    this.stop()
    console.error(`${ICONS.fail} ${truncate(msg, OUTPUT_LIMITS.FAIL_MSG)}`)
    return this
  },

  // Rich error with context and recovery hint
  failWithHint(error: ErrorWithHint | ErrorCode) {
    this.stop()
    const err = typeof error === 'string' ? getError(error as ErrorCode) : error
    console.error()
    console.error(`${ICONS.fail} ${err.message}`)
    if (err.file) {
      console.error(chalk.dim(`  File: ${err.file}`))
    }
    if (err.hint) {
      console.error(chalk.yellow(`  💡 ${err.hint}`))
    }
    if (err.docs) {
      console.error(chalk.dim(`  Docs: ${err.docs}`))
    }
    console.error()
    return this
  },

  warn(msg: string) {
    this.stop()
    if (!outputState.quietMode)
      console.log(`${ICONS.warn} ${truncate(msg, OUTPUT_LIMITS.WARN_MSG)}`)
    return this
  },

  // Informational message
  info(msg: string) {
    this.stop()
    if (!outputState.quietMode) console.log(`${ICONS.info} ${msg}`)
    return this
  },

  // Debug message (only if DEBUG=1 or DEBUG=true)
  debug(msg: string) {
    this.stop()
    // DEBUG: Enable debug output (values: '1' or 'true')
    const debugEnabled = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
    if (!outputState.quietMode && debugEnabled) {
      console.log(`${ICONS.debug} ${chalk.dim(msg)}`)
    }
    return this
  },

  // Alias for done - explicit success indicator
  success(msg: string, metrics?: OutputMetrics) {
    return this.done(msg, metrics)
  },

  // Bulleted list
  list(items: string[], options: { bullet?: string; indent?: number } = {}) {
    this.stop()
    if (outputState.quietMode) return this
    const bullet = options.bullet || ICONS.bullet
    const indent = ' '.repeat(options.indent || 0)
    for (const item of items) {
      console.log(`${indent}${bullet} ${item}`)
    }
    return this
  },

  // Simple table output
  table(rows: Array<Record<string, string | number>>, options: { header?: boolean } = {}) {
    this.stop()
    if (outputState.quietMode || rows.length === 0) return this

    const keys = Object.keys(rows[0])
    const colWidths: Record<string, number> = {}

    // Calculate column widths
    for (const key of keys) {
      colWidths[key] = key.length
      for (const row of rows) {
        const val = String(row[key] ?? '')
        if (val.length > colWidths[key]) colWidths[key] = val.length
      }
    }

    // Print header if requested
    if (options.header !== false) {
      const headerLine = keys.map((k) => k.padEnd(colWidths[k])).join('  ')
      console.log(chalk.dim(headerLine))
      console.log(chalk.dim('─'.repeat(headerLine.length)))
    }

    // Print rows
    for (const row2 of rows) {
      const line = keys.map((k) => String(row2[k] ?? '').padEnd(colWidths[k])).join('  ')
      console.log(line)
    }
    return this
  },

  // Boxed content
  box(title: string, content: string) {
    this.stop()
    if (outputState.quietMode) return this
    const lines = content.split('\n')
    const maxLen = Math.max(title.length, ...lines.map((l) => l.length))
    const border = '─'.repeat(maxLen + 2)

    console.log(chalk.dim(`┌${border}┐`))
    console.log(`${chalk.dim('│')} ${chalk.bold(title.padEnd(maxLen))} ${chalk.dim('│')}`)
    console.log(chalk.dim(`├${border}┤`))
    for (const line of lines) {
      console.log(`${chalk.dim('│')} ${line.padEnd(maxLen)} ${chalk.dim('│')}`)
    }
    console.log(chalk.dim(`└${border}┘`))
    return this
  },

  // Section header: bold title + underline
  section(title: string) {
    this.stop()
    if (outputState.quietMode) return this
    console.log(`\n${chalk.bold(title)}`)
    console.log(chalk.dim('─'.repeat(title.length)))
    return this
  },

  stop() {
    if (outputState.interval) {
      clearInterval(outputState.interval)
      outputState.interval = null
      clear()
    }
    return this
  },

  // Step counter: [3/7] Running tests...
  step(current: number, total: number, msg: string) {
    if (outputState.quietMode) return this
    this.stop()
    const counter = chalk.dim(`[${current}/${total}]`)
    if (!process.stdout.isTTY) {
      process.stdout.write(
        `${branding.cli.spin(0, `${counter} ${truncate(msg, OUTPUT_LIMITS.STEP_MSG)}`)}\n`
      )
      return this
    }
    outputState.interval = setInterval(() => {
      process.stdout.write(
        `\r${branding.cli.spin(outputState.frame++, `${counter} ${truncate(msg, OUTPUT_LIMITS.STEP_MSG)}`)}`
      )
    }, SPEED)
    return this
  },

  // Progress bar: [████░░░░] 50% Analyzing...
  progress(current: number, total: number, msg?: string) {
    if (outputState.quietMode) return this
    this.stop()
    const percent = Math.round((current / total) * 100)
    const filled = Math.round(percent / 10)
    const empty = 10 - filled
    const bar = chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(empty))
    const text = msg ? ` ${truncate(msg, OUTPUT_LIMITS.PROGRESS_TEXT)}` : ''
    if (!process.stdout.isTTY) {
      process.stdout.write(`${branding.cli.spin(0, `[${bar}] ${percent}%${text}`)}\n`)
      return this
    }
    outputState.interval = setInterval(() => {
      process.stdout.write(
        `\r${branding.cli.spin(outputState.frame++, `[${bar}] ${percent}%${text}`)}`
      )
    }, SPEED)
    return this
  },
}

export default out
