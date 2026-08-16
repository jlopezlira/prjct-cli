/**
 * Diff Summary
 *
 * Shared added/removed/changed tally + result wrapping for services that
 * diff two snapshots into a flat `{type}[]` item list (analysis-diff,
 * project-style-diff). Pure — no side effects.
 */

export interface DiffSummary<T> {
  hasChanges: boolean
  items: T[]
  summary: { added: number; removed: number; changed: number }
  beforeCommit: string | null
  afterCommit: string | null
}

/**
 * Tally a list of diff items by type and wrap it with the before/after
 * commit pointers. Callers normalize their own commit hash source (which
 * may be `string | undefined` or already `string | null`) before calling.
 */
export function summarizeDiffItems<T extends { type: 'added' | 'removed' | 'changed' }>(
  items: T[],
  beforeCommit: string | null,
  afterCommit: string | null
): DiffSummary<T> {
  const added = items.filter((i) => i.type === 'added').length
  const removed = items.filter((i) => i.type === 'removed').length
  const changed = items.filter((i) => i.type === 'changed').length

  return {
    hasChanges: items.length > 0,
    items,
    summary: { added, removed, changed },
    beforeCommit,
    afterCommit,
  }
}
