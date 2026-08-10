/**
 * Substrate health + capture density — honesty metrics for living memory.
 *
 * Pure over MemoryEntry[]. Used by insights quality / memory doctor and as a
 * compact-brief coverage footer so consumers never confuse "listed risks"
 * with "complete knowledge of the zone".
 *
 * ── signal_ratio v1 (FROZEN — do not mutate silently) ────────────────────
 * Metric id: {@link SIGNAL_RATIO_METRIC_VERSION} === "v1"
 *
 * Denominator = live entries whose type ∈ JUDGMENT_TYPES
 *   (decision, gotcha, learning, fact, feedback, pattern, anti-pattern,
 *    red-herring, spec, shipped). These are rows already in the vault —
 *   refused captures (junk, bare-id, empty-spec, inbox_no_substance) never
 *   enter the store, so they are NOT in the denominator.
 *
 * Numerador (signal) = judgment entries for which
 *   classifyCapturePrecision(content, type).action === "accept"
 *   (typed correctly as stored; shape still valid).
 *
 * precisionFail = judgment − signal (action !== accept as currently typed).
 * signal_ratio_v1 = 1 − precisionFail / |judgment|   (1 when judgment empty)
 *
 * Demotions:
 *   - At write time, open-narration gotcha → stored as context (not judgment)
 *     → does not enter denominator. Conserved as context = not counted as noise.
 *   - If a gotcha still sits in the vault with open-narration shape, it is
 *     precisionFail (noise still graduated) until dream cleans it.
 *   - red-herring is a judgment type; correctly typed red-herrings are signal.
 *
 * Future formula changes MUST bump to signal_ratio_v2 (new field/version id),
 * never rewrite v1 semantics — so 88→82 always means substrate worsened.
 *
 * Other metrics: unshaped_gotcha_rate · empty_spec_rate · junk_like_rate
 *   recency bands · blind_spots[] · score 0–100
 */

/** Frozen metric version for signal_ratio. Bump only with a new formula. */
export const SIGNAL_RATIO_METRIC_VERSION = 'v1' as const

import type { MemoryEntry } from './entries'
import { classifyCapturePrecision } from './precision-classifier'
import { clusterMemoryEntries, extractKeyEntities } from './semantic-cluster'

/** Types that carry judgment authority on briefs. */
export const JUDGMENT_TYPES = new Set([
  'decision',
  'gotcha',
  'learning',
  'fact',
  'feedback',
  'pattern',
  'anti-pattern',
  'red-herring',
  'spec',
  'shipped',
])

const DAY_MS = 24 * 60 * 60 * 1000

export interface DensityBand {
  d7: number
  d30: number
  older: number
}

export interface BlindSpot {
  kind: 'type' | 'entity' | 'recency' | 'empty'
  label: string
  reason: string
}

export interface SubstrateHealth {
  live: number
  judgment: number
  /**
   * signal_ratio v1: share of judgment rows that pass precision as-typed.
   * See module header for frozen formula. Version: {@link SIGNAL_RATIO_METRIC_VERSION}.
   */
  signalRatio: number
  /** Always "v1" until a deliberate metric bump. */
  signalRatioVersion: typeof SIGNAL_RATIO_METRIC_VERSION
  unshapedGotchaRate: number
  emptySpecRate: number
  junkLikeRate: number
  /** Entries that would collapse under semantic cluster (within-type). */
  clusterCollapsedEstimate: number
  byType: Record<string, number>
  recency: DensityBand
  blindSpots: BlindSpot[]
  /** 0–100 composite for doctor / gates. */
  score: number
  issues: string[]
}

function ageMs(e: MemoryEntry, now: number): number {
  const t = Date.parse(e.rememberedAt)
  return Number.isFinite(t) ? Math.max(0, now - t) : Number.POSITIVE_INFINITY
}

/**
 * Compute substrate health for a vault slice (full index or recall set).
 */
export function computeSubstrateHealth(
  entries: MemoryEntry[],
  nowMs: number = Date.now()
): SubstrateHealth {
  const live = entries.length
  const byType: Record<string, number> = {}
  for (const e of entries) {
    byType[e.type] = (byType[e.type] ?? 0) + 1
  }

  const judgment = entries.filter((e) => JUDGMENT_TYPES.has(e.type))
  const gotchas = judgment.filter((e) => e.type === 'gotcha')
  const specs = judgment.filter((e) => e.type === 'spec')
  const { unshapedGotcha, emptySpec, junkLike, precisionFail } = judgment.reduce(
    (counts, entry) => {
      const verdict = classifyCapturePrecision(entry.content, entry.type)
      if (verdict.action === 'accept') return counts
      counts.precisionFail++
      if (entry.type === 'gotcha' && verdict.reasonCode === 'gotcha_open_narration') {
        counts.unshapedGotcha++
      }
      if (
        entry.type === 'spec' &&
        (verdict.reasonCode === 'empty_spec_mirror' || verdict.reasonCode === 'bare_id_body')
      ) {
        counts.emptySpec++
      }
      if (verdict.reasonCode === 'junk' || verdict.reasonCode === 'inbox_no_substance') {
        counts.junkLike++
      }
      return counts
    },
    { unshapedGotcha: 0, emptySpec: 0, junkLike: 0, precisionFail: 0 }
  )

  const unshapedGotchaRate = gotchas.length === 0 ? 0 : unshapedGotcha / gotchas.length
  const emptySpecRate = specs.length === 0 ? 0 : emptySpec / specs.length
  const junkLikeRate = judgment.length === 0 ? 0 : junkLike / judgment.length
  const signalRatio =
    judgment.length === 0 ? 1 : Math.max(0, Math.min(1, 1 - precisionFail / judgment.length))

  // Cluster estimate within judgment types only
  const byJType = new Map<string, MemoryEntry[]>()
  for (const e2 of judgment) {
    const list = byJType.get(e2.type) ?? []
    list.push(e2)
    byJType.set(e2.type, list)
  }
  const clusterCollapsedEstimate = [...byJType.values()].reduce(
    (total, group) =>
      total +
      (group.length < 2
        ? 0
        : clusterMemoryEntries(group).reduce(
            (collapsed, cluster) => collapsed + Math.max(0, cluster.seenInN - 1),
            0
          )),
    0
  )

  const recency: DensityBand = { d7: 0, d30: 0, older: 0 }
  for (const e3 of entries) {
    const age = ageMs(e3, nowMs)
    if (age <= 7 * DAY_MS) recency.d7++
    else if (age <= 30 * DAY_MS) recency.d30++
    else recency.older++
  }

  const blindSpots: BlindSpot[] = []
  if (live === 0) {
    blindSpots.push({
      kind: 'empty',
      label: 'vault',
      reason: 'no live memory — every zone is a blind spot',
    })
  }
  if (judgment.length > 0 && recency.d30 === 0 && recency.d7 === 0) {
    blindSpots.push({
      kind: 'recency',
      label: 'stale-vault',
      reason: 'no captures in the last 30 days — knowledge may be rotten',
    })
  }
  // Judgment types missing entirely but others present
  for (const need of ['decision', 'gotcha'] as const) {
    if (live >= 8 && (byType[need] ?? 0) === 0) {
      blindSpots.push({
        kind: 'type',
        label: need,
        reason: `no ${need} entries in a non-empty vault — risk surface is incomplete`,
      })
    }
  }

  // Entity density: entities that appear only once and only in old entries
  // are thin — surface top thin anchors when judgment exists.
  if (judgment.length >= 3) {
    const entityHits = new Map<string, { count: number; fresh: number }>()
    for (const e4 of judgment) {
      const fresh = ageMs(e4, nowMs) <= 30 * DAY_MS ? 1 : 0
      for (const ent of extractKeyEntities(e4.content)) {
        if (ent.length < 6 && !['rls', 'jwt', 'csrf'].includes(ent)) continue
        const cur = entityHits.get(ent) ?? { count: 0, fresh: 0 }
        cur.count++
        cur.fresh += fresh
        entityHits.set(ent, cur)
      }
    }
    // Prefer reporting lack of multi-capture on high-signal single-hit entities
    // only when we have enough data that sparsity is meaningful.
    const thinEntities = [...entityHits].filter(([, hit]) => hit.count === 1 && hit.fresh === 0)
    for (const [entity] of thinEntities.slice(0, 3)) {
      blindSpots.push({
        kind: 'entity',
        label: entity,
        reason: `single stale capture for "${entity}" — validate before trusting`,
      })
    }
    if (thinEntities.length > 3) {
      blindSpots.push({
        kind: 'entity',
        label: `${thinEntities.length} thin anchors`,
        reason: `${thinEntities.length} entities appear only once in stale captures — density is low`,
      })
    }
  }

  const issues: string[] = []
  if (unshapedGotcha > 0) {
    issues.push(`${unshapedGotcha} open-narration gotcha(s) fail precision (should be context).`)
  }
  if (emptySpec > 0) {
    issues.push(`${emptySpec} empty-spec mirror(s) still live.`)
  }
  if (junkLike > 0) {
    issues.push(`${junkLike} junk-like judgment row(s) should be forgotten.`)
  }
  if (clusterCollapsedEstimate > 0) {
    issues.push(
      `${clusterCollapsedEstimate} near-duplicate(s) would collapse on brief (semantic cluster).`
    )
  }
  for (const b of blindSpots) {
    if (b.kind !== 'entity' || blindSpots.filter((x) => x.kind === 'entity').indexOf(b) < 2) {
      issues.push(`Blind spot (${b.kind}): ${b.reason}`)
    }
  }

  // Score: start 100, penalize precision failures and blind spots
  const score = Math.max(
    0,
    Math.min(
      100,
      100 -
        Math.round((1 - signalRatio) * 40) -
        Math.min(20, Math.round(unshapedGotchaRate * 20)) -
        Math.min(15, Math.round(emptySpecRate * 15)) -
        Math.min(15, blindSpots.length * 3)
    )
  )

  return {
    live,
    judgment: judgment.length,
    signalRatio,
    signalRatioVersion: SIGNAL_RATIO_METRIC_VERSION,
    unshapedGotchaRate,
    emptySpecRate,
    junkLikeRate,
    clusterCollapsedEstimate,
    byType,
    recency,
    blindSpots,
    score,
    issues,
  }
}

/**
 * One-line coverage footer for compact memory surfaces (honest density).
 */
export function formatCoverageFooter(entries: MemoryEntry[], nowMs: number = Date.now()): string {
  if (entries.length === 0) {
    return '_Coverage: empty set — full blind spot; do not treat absence of risks as safety._'
  }
  const h = computeSubstrateHealth(entries, nowMs)
  const density =
    h.recency.d7 + h.recency.d30 >= Math.max(3, Math.ceil(entries.length * 0.4))
      ? 'dense'
      : h.recency.d7 + h.recency.d30 >= 1
        ? 'mixed'
        : 'thin/stale'
  const topTypes = Object.entries(h.byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([t, n]) => `${t}:${n}`)
    .join(' ')
  const blind =
    h.blindSpots.length === 0
      ? 'no structural blind spots in this slice'
      : `${h.blindSpots.length} blind-spot signal(s) — not complete coverage`
  return `_Coverage: ${entries.length} shown · density=${density} · signal≈${Math.round(h.signalRatio * 100)}% · ${topTypes} · ${blind}_`
}

/**
 * Markdown block for memory doctor / insights quality.
 */
export function formatSubstrateHealthMd(h: SubstrateHealth): string {
  const lines = [
    '## Substrate health',
    '',
    `| Metric | Value |`,
    `|---|---:|`,
    `| Score | ${h.score}/100 |`,
    `| Live | ${h.live} |`,
    `| Judgment | ${h.judgment} |`,
    `| Signal ratio (${h.signalRatioVersion}) | ${Math.round(h.signalRatio * 100)}% |`,
    `| Unshaped gotcha rate | ${Math.round(h.unshapedGotchaRate * 100)}% |`,
    `| Empty-spec rate | ${Math.round(h.emptySpecRate * 100)}% |`,
    `| Cluster collapse estimate | ${h.clusterCollapsedEstimate} |`,
    `| Recency 7d / 30d / older | ${h.recency.d7} / ${h.recency.d30} / ${h.recency.older} |`,
    '',
  ]
  if (h.issues.length === 0) {
    lines.push('- No substrate precision issues detected in this slice.')
  } else {
    lines.push('### Issues')
    for (const i of h.issues) lines.push(`- ${i}`)
  }
  if (h.blindSpots.length > 0) {
    lines.push('', '### Blind spots')
    for (const b of h.blindSpots) {
      lines.push(`- **${b.label}** (${b.kind}): ${b.reason}`)
    }
  }
  lines.push(
    '',
    '_This is captured knowledge only — absence of a risk is not proof it does not exist._'
  )
  return lines.join('\n')
}
