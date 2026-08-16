/**
 * Project style diff — pure comparison of two style snapshots.
 * Same spirit as analysis-diff.ts; keyed by stable style keys.
 */

import type {
  ProjectStyleDiff,
  ProjectStyleDiffItem,
  ProjectStyleSnapshot,
} from '../types/project-style'
import { summarizeDiffItems } from './diff-summary'

export function generateProjectStyleDiff(
  before: ProjectStyleSnapshot | null,
  after: ProjectStyleSnapshot
): ProjectStyleDiff {
  const items: ProjectStyleDiffItem[] = []

  if (!before) {
    return {
      hasChanges: true,
      items: [
        {
          field: 'Project style',
          type: 'added',
          after: after.summary,
        },
      ],
      summary: { added: 1, removed: 0, changed: 0 },
      beforeCommit: null,
      afterCommit: after.commitHash,
    }
  }

  const b = before.payload
  const a = after.payload

  // Ecosystem / package manager
  if (b.stack.ecosystem !== a.stack.ecosystem) {
    items.push({
      field: 'Ecosystem',
      type: 'changed',
      before: b.stack.ecosystem,
      after: a.stack.ecosystem,
    })
  }
  if ((b.stack.packageManager ?? '') !== (a.stack.packageManager ?? '')) {
    items.push({
      field: 'Package manager',
      type: 'changed',
      before: b.stack.packageManager ?? '(none)',
      after: a.stack.packageManager ?? '(none)',
    })
  }

  diffStringArray('Languages', b.stack.languages, a.stack.languages, items)
  diffStringArray('Frameworks', b.stack.frameworks, a.stack.frameworks, items)
  diffStringArray('Key libraries', b.stack.keyLibraries, a.stack.keyLibraries, items)

  if (b.stack.hasTests !== a.stack.hasTests) {
    items.push({
      field: 'Has tests',
      type: 'changed',
      before: String(b.stack.hasTests),
      after: String(a.stack.hasTests),
    })
  }

  // Patterns / anti / conventions by key
  diffKeyed(
    'Pattern',
    b.patterns.map((p) => [p.key, p.name]),
    a.patterns.map((p) => [p.key, p.name]),
    items
  )
  diffKeyed(
    'Anti-pattern',
    b.antiPatterns.map((p) => [p.key, p.issue]),
    a.antiPatterns.map((p) => [p.key, p.issue]),
    items
  )
  diffKeyed(
    'Convention',
    b.conventions.map((c) => [c.key, c.rule]),
    a.conventions.map((c) => [c.key, c.rule]),
    items
  )

  if (
    b.structural.symbols !== a.structural.symbols &&
    (b.structural.symbols > 0 || a.structural.symbols > 0)
  ) {
    items.push({
      field: 'Symbols',
      type: 'changed',
      before: String(b.structural.symbols),
      after: String(a.structural.symbols),
    })
  }
  if (b.structural.files !== a.structural.files) {
    items.push({
      field: 'Files',
      type: 'changed',
      before: String(b.structural.files),
      after: String(a.structural.files),
    })
  }

  return summarizeDiffItems(items, before.commitHash, after.commitHash)
}

export function formatProjectStyleDiffMd(diff: ProjectStyleDiff): string {
  if (!diff.hasChanges) {
    return '## Project evolution\n\nNo style changes since last sync.'
  }

  const lines: string[] = ['## Project evolution (this sync)']
  if (diff.beforeCommit || diff.afterCommit) {
    lines.push(`> \`${short(diff.beforeCommit)}\` → \`${short(diff.afterCommit)}\``)
  }
  lines.push('')
  lines.push(`+${diff.summary.added} · −${diff.summary.removed} · ~${diff.summary.changed}`)
  lines.push('')
  for (const item of diff.items.slice(0, 20)) {
    const icon = item.type === 'added' ? '+' : item.type === 'removed' ? '−' : '~'
    if (item.type === 'changed') {
      lines.push(`- ${icon} **${item.field}**: ${item.before} → ${item.after}`)
    } else if (item.type === 'added') {
      lines.push(`- ${icon} **${item.field}**: ${item.after}`)
    } else {
      lines.push(`- ${icon} **${item.field}**: ${item.before}`)
    }
  }
  return lines.join('\n')
}

function short(hash: string | null): string {
  if (!hash) return '(none)'
  return hash.length > 7 ? hash.slice(0, 7) : hash
}

function diffStringArray(
  field: string,
  before: string[],
  after: string[],
  items: ProjectStyleDiffItem[]
): void {
  const b = new Set(before.map((s) => s.toLowerCase()))
  const a = new Set(after.map((s) => s.toLowerCase()))
  for (const x of after) {
    if (!b.has(x.toLowerCase())) {
      items.push({ field, type: 'added', after: x })
    }
  }
  for (const x2 of before) {
    if (!a.has(x2.toLowerCase())) {
      items.push({ field, type: 'removed', before: x2 })
    }
  }
}

function diffKeyed(
  field: string,
  before: Array<[string, string]>,
  after: Array<[string, string]>,
  items: ProjectStyleDiffItem[]
): void {
  const bMap = new Map(before)
  const aMap = new Map(after)
  for (const [key, label] of aMap) {
    if (!bMap.has(key)) {
      items.push({ field, type: 'added', after: label })
    } else if (bMap.get(key) !== label) {
      items.push({
        field,
        type: 'changed',
        before: bMap.get(key),
        after: label,
      })
    }
  }
  for (const [key, label] of bMap) {
    if (!aMap.has(key)) {
      items.push({ field, type: 'removed', before: label })
    }
  }
}
