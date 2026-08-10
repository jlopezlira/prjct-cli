/**
 * Impact-ordered ready frontier — Dynasty D4 / C1.
 *
 * Base frontier (work-graph) is structural: unblocked + unblocks + priority.
 * This layer re-ranks with world-model impact + SoT pressure so `prjct next`
 * picks high-leverage work and prints a one-line "why this next".
 *
 * Pure scoring is unit-tested without DB; enrich uses breakImpact best-effort.
 */

import type { ReadyItem } from './work-graph'
import { breakImpact } from './world-model-impact'

export interface ImpactRankFactors {
  unblocks: number
  priorityPts: number
  ageDays: number
  impactNeighbors: number
  impactTraps: number
  sotPressure: number
}

export interface RankedReadyItem extends ReadyItem {
  impactScore: number
  factors: ImpactRankFactors
  /** One scannable rationale for agents. */
  why: string
}

const PRIORITY_PTS: Record<string, number> = {
  high: 50,
  medium: 25,
  low: 5,
}

/**
 * Higher = do sooner.
 * Leverage (unblocks) dominates; SoT traps and graph blast raise priority
 * so multi-agent cast clears landmines and unlocks parallel work.
 */
export function scoreReadyFactors(f: ImpactRankFactors): number {
  return (
    f.unblocks * 100 +
    f.priorityPts +
    f.ageDays * 2 +
    f.impactNeighbors * 5 +
    f.impactTraps * 15 +
    f.sotPressure * 20
  )
}

export function priorityPoints(priority: string | null | undefined): number {
  if (!priority) return 15
  return PRIORITY_PTS[priority.toLowerCase()] ?? 15
}

export function ageDaysSince(createdAt: string, nowMs: number): number {
  const t = Date.parse(createdAt)
  if (Number.isNaN(t)) return 0
  return Math.max(0, Math.floor((nowMs - t) / (24 * 60 * 60 * 1000)))
}

export function formatWhyNext(factors: ImpactRankFactors, score: number): string {
  const bits: string[] = []
  if (factors.unblocks > 0) bits.push(`unblocks ${factors.unblocks}`)
  if (factors.impactTraps > 0) bits.push(`${factors.impactTraps} trap(s)`)
  if (factors.impactNeighbors > 0) bits.push(`${factors.impactNeighbors} blast neighbor(s)`)
  if (factors.sotPressure > 0) bits.push(`SoT pressure ${factors.sotPressure}`)
  if (factors.priorityPts >= 50) bits.push('high priority')
  if (bits.length === 0) bits.push('oldest ready / default rank')
  return `why next: ${bits.join(' · ')} (score=${Math.round(score)})`
}

/**
 * Pure re-rank: stable sort by impactScore desc, then unblocks, then age.
 * Callers supply precomputed factors (tests) or use {@link rankReadyWithImpact}.
 */
export function rankByFactors(
  items: ReadonlyArray<ReadyItem & { factors: ImpactRankFactors }>
): RankedReadyItem[] {
  const ranked: RankedReadyItem[] = items.map((i) => {
    const impactScore = scoreReadyFactors(i.factors)
    return {
      ...i,
      impactScore,
      why: formatWhyNext(i.factors, impactScore),
    }
  })
  ranked.sort((a, b) => {
    if (b.impactScore !== a.impactScore) return b.impactScore - a.impactScore
    if (b.unblocks !== a.unblocks) return b.unblocks - a.unblocks
    return a.createdAt.localeCompare(b.createdAt)
  })
  return ranked
}

/** Extract crude seed paths/tokens from a backlog description for breakImpact. */
export function seedHintsFromDescription(description: string): string[] {
  const pathRe = /\b[\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sh|toml|yml|yaml)\b/g
  const paths = description.match(pathRe) ?? []
  const tokens = description
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length >= 4 && !STOP.has(t))
    .slice(0, 6)
  return [...new Set([...paths, ...tokens])].slice(0, 8)
}

const STOP = new Set([
  'that',
  'this',
  'with',
  'from',
  'into',
  'have',
  'should',
  'must',
  'will',
  'task',
  'work',
  'item',
  'build',
  'implement',
  'feature',
  'fix',
])

/**
 * Enrich ready frontier with world-model signals and re-rank.
 * Fail-open: missing indexes → structural scores only (unblocks/priority/age).
 */
export function rankReadyWithImpact(
  projectId: string,
  items: readonly ReadyItem[],
  opts: { nowMs?: number } = {}
): RankedReadyItem[] {
  const now = opts.nowMs ?? Date.now()
  const withFactors = items.map((item) => {
    const seeds = seedHintsFromDescription(item.description)
    const impactFactors = (() => {
      if (seeds.length === 0) return { impactNeighbors: 0, impactTraps: 0, sotPressure: 0 }
      try {
        const impact = breakImpact(projectId, seeds, 6)
        return {
          impactNeighbors: impact.neighbors.length,
          impactTraps: impact.traps.length,
          sotPressure: impact.traps.filter(
            (t) => t.type === 'gotcha' || t.type === 'decision' || t.type === 'fact'
          ).length,
        }
      } catch {
        return { impactNeighbors: 0, impactTraps: 0, sotPressure: 0 }
      }
    })()
    const { impactNeighbors, impactTraps, sotPressure } = impactFactors
    const factors: ImpactRankFactors = {
      unblocks: item.unblocks,
      priorityPts: priorityPoints(item.priority),
      ageDays: ageDaysSince(item.createdAt, now),
      impactNeighbors,
      impactTraps,
      sotPressure,
    }
    return { ...item, factors }
  })
  return rankByFactors(withFactors)
}
