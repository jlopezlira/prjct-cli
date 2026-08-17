/**
 * Markdown formatter utilities for --md flag output
 *
 * Produces lean, structured markdown for LLM consumption.
 * Zero emojis. Zero filler. Every token earns its place.
 */

import { getVersion } from './version'

// Output Wrapper

/**
 * Join --md sections into one payload — no branded header/footer (3 lines
 * of pure noise per call; the contract above is zero filler). The version
 * footer survives only under PRJCT_DEBUG for support debugging.
 */
export function mdOutput(...sections: (string | null | undefined | false)[]): string {
  const body = mdJoin(...sections.filter(Boolean))
  return process.env.PRJCT_DEBUG ? mdJoin(body, `---\nprjct v${getVersion()}`) : body
}

// Generic Utilities

/** Build a markdown table from headers and rows */
function mdTable(headers: string[], rows: string[][]): string {
  const headerRow = `| ${headers.join(' | ')} |`
  const separator = `|${headers.map(() => '---').join('|')}|`
  const bodyRows = rows.map((row) => `| ${row.join(' | ')} |`)
  return [headerRow, separator, ...bodyRows].join('\n')
}

/** Format a fenced code block */
export function mdCodeBlock(code: string, lang = ''): string {
  return `\`\`\`${lang}\n${code}\n\`\`\``
}

/** Inline key-value badge */
export function mdBadge(label: string, value: string): string {
  return `**${label}**: \`${value}\``
}

// Section Formatters

/** Format a section heading with content */
export function mdSection(title: string, content: string, _level: 2 | 3 = 3): string {
  return `### ${title}\n${content}`
}

/** Format an ordered or unordered list */
export function mdList(items: string[], ordered = false): string {
  return items.map((item, i) => (ordered ? `${i + 1}. ${item}` : `- ${item}`)).join('\n')
}

// Task Formatters

interface TaskInfo {
  description: string
  status?: string
  type?: string
  branch?: string
  linearId?: string
  duration?: string
  startedAt?: string
  estimatedPoints?: number
  estimatedMinutes?: number
  estimateSource?: string
  domains?: string[]
}

/** Format task header block as H2 with metadata blockquote */
export function mdTaskHeader(task: TaskInfo): string {
  const parts: string[] = []
  if (task.branch) parts.push(`Branch: \`${task.branch}\``)
  if (task.linearId) parts.push(`Linear: \`${task.linearId}\``)
  if (task.type) parts.push(`Type: ${task.type}`)
  if (task.estimatedPoints) parts.push(`~${task.estimatedPoints}pts`)
  if (task.estimatedMinutes) parts.push(`~${task.estimatedMinutes}min`)
  if (task.domains && task.domains.length > 0) parts.push(`Domains: ${task.domains.join(', ')}`)
  if (task.duration) parts.push(`Duration: ${task.duration}`)
  if (task.status) parts.push(`Status: ${task.status}`)

  const meta = parts.length > 0 ? `\n> ${parts.join(' | ')}` : ''
  return `## ${task.description}${meta}`
}

// Context Formatters

// Navigation Formatters

interface NextStep {
  label: string
  command: string
}

/** Format next steps as a table */
export function mdNextSteps(steps: NextStep[]): string {
  const headers = ['Command', 'Action']
  const rows = steps.map((s) => [`\`${s.command}\``, s.label])
  return `### Next\n${mdTable(headers, rows)}`
}

// Status Formatters

/** Format a key-value stats block as a table */
export function mdStats(stats: Record<string, string | number | null | undefined>): string {
  const entries = Object.entries(stats).filter(([, value]) => value != null)
  if (entries.length === 0) return ''
  const headers = ['Metric', 'Value']
  const rows = entries.map(([key, value]) => [key, String(value)])
  return mdTable(headers, rows)
}

/** Format a success/completion message */
export function mdDone(message: string, details?: string): string {
  return details ? `## ${message}\n> ${details}` : `## ${message}`
}

/** Format a warning message (bold) */
export function mdWarn(message: string): string {
  return `> **WARNING:** ${message}`
}

// Composition Helper

/** Join multiple markdown sections with blank lines */
export function mdJoin(...sections: (string | null | undefined | false)[]): string {
  return sections.filter(Boolean).join('\n\n')
}

// Actionable Response (for LLM consumption)

interface MdOption {
  label: string
  command?: string
}

/**
 * Output a structured response when an action is blocked.
 */
export function mdActionRequired(
  status: string,
  reason: string,
  options: MdOption[],
  context?: Record<string, string>
): void {
  const reasonText = reason.replace(/_/g, ' ')
  const lines = [`> **${status}**: ${reasonText}`]
  if (context) {
    for (const [k, v] of Object.entries(context)) {
      lines.push(`> ${k}: ${v}`)
    }
  }
  if (options.length > 0) {
    lines.push('')
    for (const opt of options) {
      lines.push(`- ${opt.label}: \`${opt.command}\``)
    }
  }
  console.log(lines.join('\n'))
}
