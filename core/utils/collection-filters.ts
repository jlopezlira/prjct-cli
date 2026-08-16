/**
 * Collection Filter Utilities
 */

import type { Priority, TaskSection } from '../schemas/state'

const PRIORITY_ORDER: Record<Priority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

const SECTION_ORDER: Record<TaskSection, number> = {
  active: 0,
  previously_active: 1,
  backlog: 2,
}

export function sortBySectionAndPriority<T extends { section: TaskSection; priority: Priority }>(
  items: T[]
): T[] {
  return [...items].sort((a, b) => {
    const sectionDiff = SECTION_ORDER[a.section] - SECTION_ORDER[b.section]
    if (sectionDiff !== 0) return sectionDiff
    return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
  })
}

export function uniqueBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = keyFn(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Convert a path→score map into a sorted array, highest score first.
 * Shared by the BM25 and git-cochange scorers, which both build up a
 * `Map<string, number>` while scanning candidates and need the same
 * "flatten + sort descending" tail step.
 */
export function scoresToSortedArray(
  scores: Map<string, number>
): { path: string; score: number }[] {
  return Array.from(scores.entries())
    .map(([p, s]) => ({ path: p, score: s }))
    .sort((a, b) => b.score - a.score)
}
