/**
 * Analysis Diff Service (PRJ-275)
 *
 * Computes a structured diff between two AnalysisSchema objects.
 * Used to show what changed between consecutive analysis runs
 * (e.g., draft vs sealed, or sealed vs previous sealed).
 *
 * Pure functions — no side effects, no storage access.
 */

import type { AnalysisSchema } from '../schemas/analysis'
import type { AnalysisDiff, AnalysisDiffItem } from '../types/services/extracted'
import { summarizeDiffItems } from './diff-summary'

// Diff Logic

/**
 * Compute diff between two analysis objects.
 * `before` is the older analysis (e.g., sealed), `after` is the newer (e.g., draft).
 */
export function generateAnalysisDiff(before: AnalysisSchema, after: AnalysisSchema): AnalysisDiff {
  const items: AnalysisDiffItem[] = []

  // Languages
  diffStringArray('Languages', before.languages, after.languages, items)

  // Frameworks
  diffStringArray('Frameworks', before.frameworks, after.frameworks, items)

  // Package manager
  if ((before.packageManager ?? '') !== (after.packageManager ?? '')) {
    items.push({
      field: 'Package manager',
      type: 'changed',
      before: before.packageManager ?? '(none)',
      after: after.packageManager ?? '(none)',
    })
  }

  // Source dir
  if ((before.sourceDir ?? '') !== (after.sourceDir ?? '')) {
    items.push({
      field: 'Source directory',
      type: 'changed',
      before: before.sourceDir ?? '(none)',
      after: after.sourceDir ?? '(none)',
    })
  }

  // Test dir
  if ((before.testDir ?? '') !== (after.testDir ?? '')) {
    items.push({
      field: 'Test directory',
      type: 'changed',
      before: before.testDir ?? '(none)',
      after: after.testDir ?? '(none)',
    })
  }

  // Config files
  diffStringArray('Config files', before.configFiles, after.configFiles, items)

  // File count
  if (before.fileCount !== after.fileCount) {
    items.push({
      field: 'File count',
      type: 'changed',
      before: String(before.fileCount),
      after: String(after.fileCount),
    })
  }

  // Patterns (by name)
  const beforePatternNames = before.patterns.map((p) => p.name)
  const afterPatternNames = after.patterns.map((p) => p.name)
  diffStringArray('Patterns', beforePatternNames, afterPatternNames, items)

  // Anti-patterns (by issue)
  const beforeAntiNames = before.antiPatterns.map((a) => a.issue)
  const afterAntiNames = after.antiPatterns.map((a) => a.issue)
  diffStringArray('Anti-patterns', beforeAntiNames, afterAntiNames, items)

  return summarizeDiffItems(items, before.commitHash ?? null, after.commitHash ?? null)
}

// Formatting

/**
 * Format analysis diff as markdown (for --md output).
 */
export function formatAnalysisDiffMd(diff: AnalysisDiff): string {
  if (!diff.hasChanges) {
    return '## Analysis Diff\n\nNo changes between runs.'
  }

  const lines: string[] = []
  lines.push('## Analysis Diff')

  if (diff.beforeCommit || diff.afterCommit) {
    lines.push(
      `> \`${diff.beforeCommit?.substring(0, 7) ?? '(none)'}\` → \`${diff.afterCommit?.substring(0, 7) ?? '(none)'}\``
    )
  }

  lines.push('')
  lines.push('| Change | Field | Detail |')
  lines.push('|--------|-------|--------|')

  for (const item of diff.items) {
    const icon = item.type === 'added' ? '+' : item.type === 'removed' ? '-' : '~'
    const detail =
      item.type === 'changed' ? `${item.before} → ${item.after}` : (item.after ?? item.before ?? '')
    lines.push(`| ${icon} | ${item.field} | ${detail} |`)
  }

  lines.push('')
  const parts: string[] = []
  if (diff.summary.added > 0) parts.push(`${diff.summary.added} added`)
  if (diff.summary.removed > 0) parts.push(`${diff.summary.removed} removed`)
  if (diff.summary.changed > 0) parts.push(`${diff.summary.changed} changed`)
  lines.push(`**Summary**: ${parts.join(', ')}`)

  return lines.join('\n')
}

/**
 * Format analysis diff as plain text (for terminal).
 */
export function formatAnalysisDiffText(diff: AnalysisDiff): string {
  if (!diff.hasChanges) {
    return 'No changes between analysis runs.'
  }

  const lines: string[] = []

  if (diff.beforeCommit || diff.afterCommit) {
    lines.push(
      `  ${diff.beforeCommit?.substring(0, 7) ?? '(none)'} → ${diff.afterCommit?.substring(0, 7) ?? '(none)'}`
    )
    lines.push('')
  }

  for (const item of diff.items) {
    if (item.type === 'added') {
      lines.push(`  + ${item.field}: ${item.after}`)
    } else if (item.type === 'removed') {
      lines.push(`  - ${item.field}: ${item.before}`)
    } else {
      lines.push(`  ~ ${item.field}: ${item.before} → ${item.after}`)
    }
  }

  return lines.join('\n')
}

// Helpers

function diffStringArray(
  label: string,
  before: string[],
  after: string[],
  items: AnalysisDiffItem[]
): void {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)

  for (const val of after) {
    if (!beforeSet.has(val)) {
      items.push({ field: label, type: 'added', after: val })
    }
  }

  for (const val2 of before) {
    if (!afterSet.has(val2)) {
      items.push({ field: label, type: 'removed', before: val2 })
    }
  }
}
