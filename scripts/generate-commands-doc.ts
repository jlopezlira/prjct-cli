#!/usr/bin/env bun
/**
 * Generate docs/commands.md from the command manifest.
 *
 * core/commands/command-data.ts is the single source of truth for command
 * metadata; the doc drifts whenever a command is added without a docs pass.
 * Run directly (`bun scripts/generate-commands-doc.ts`) after touching the
 * manifest.
 */

import fs from 'node:fs'
import path from 'node:path'
import { CATEGORIES, COMMANDS } from '../core/commands/command-data'

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'docs', 'commands.md')

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

const lines: string[] = [
  '# CLI Commands',
  '',
  'Generated from `core/commands/command-data.ts` — do not edit by hand.',
  'Regenerate with `bun scripts/generate-commands-doc.ts`.',
  '',
]

const groups = Object.entries(CATEGORIES).sort(([, a], [, b]) => a.order - b.order)
for (const [key, category] of groups) {
  const commands = COMMANDS.filter((cmd) => cmd.group === key && cmd.implemented)
  if (commands.length === 0) continue
  lines.push(`## ${category.title}`)
  lines.push('')
  lines.push(category.description)
  lines.push('')
  lines.push('| Command | Usage | Description |')
  lines.push('|---|---|---|')
  for (const cmd of commands) {
    const usage = cmd.usage.terminal ?? `prjct ${cmd.name}`
    const description = cmd.deprecated
      ? `${cmd.description} (deprecated${cmd.replacedBy ? ` — use \`${cmd.replacedBy}\`` : ''})`
      : cmd.description
    lines.push(`| \`${cmd.name}\` | \`${cell(usage)}\` | ${cell(description)} |`)
  }
  lines.push('')
}

fs.writeFileSync(OUT, `${lines.join('\n').trimEnd()}\n`)
console.log(`  → docs/commands.md (${COMMANDS.length} commands, ${groups.length} categories)`)
