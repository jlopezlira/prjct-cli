/**
 * Live project world-model signals — "if I touch X, what else matters?"
 *
 * Pure reads over import graph + co-change matrix + file-linked preventive
 * memory. No new CLI verb: guard / pre-edit / prime pull this brief.
 * Drift refresh stays on `prjct sync` (already rebuilds indexes + analysis).
 */

import { scoreFromSeeds as cochangeFromSeeds, loadMatrix } from '../domain/git-cochange'
import { scoreFromSeeds as importFromSeeds, loadGraph } from '../domain/import-graph'
import { projectMemory } from '../memory/project-memory'

export interface ImpactNeighbor {
  path: string
  score: number
  via: 'imports' | 'cochange' | 'both'
}

export interface WorldModelImpact {
  seeds: string[]
  neighbors: ImpactNeighbor[]
  traps: Array<{ id: string; type: string; title: string; file: string }>
  /** One scannable line for hooks/prime. */
  line: string
  hasIndexes: { imports: boolean; cochange: boolean }
}

/**
 * Rank related files + traps for a set of seed paths (or basenames).
 * Best-effort: empty indexes → traps-only or empty.
 */
export function breakImpact(
  projectId: string,
  seedFiles: string[],
  limit = 8,
  opts: { traps?: boolean } = {}
): WorldModelImpact {
  const seeds = seedFiles.map((s) => s.trim()).filter(Boolean)
  const graph = loadGraph(projectId)
  const matrix = loadMatrix(projectId)
  const hasImports = Boolean(graph)
  const hasCochange = Boolean(matrix)
  const neighborScores = new Map<string, { score: number; via: Set<'imports' | 'cochange'> }>()

  if (seeds.length > 0 && graph) {
    try {
      for (const s of importFromSeeds(seeds, graph, 2)) {
        if (seeds.some((seed) => seed.endsWith(s.path) || s.path.endsWith(seed))) continue
        const cur = neighborScores.get(s.path) ?? { score: 0, via: new Set() }
        cur.score += s.score
        cur.via.add('imports')
        neighborScores.set(s.path, cur)
      }
    } catch {
      /* best-effort */
    }
  }
  if (seeds.length > 0 && matrix) {
    try {
      for (const s2 of cochangeFromSeeds(seeds, matrix)) {
        if (seeds.some((seed) => seed.endsWith(s2.path) || s2.path.endsWith(seed))) continue
        const cur = neighborScores.get(s2.path) ?? { score: 0, via: new Set() }
        cur.score += s2.score
        cur.via.add('cochange')
        neighborScores.set(s2.path, cur)
      }
    } catch {
      /* best-effort */
    }
  }

  const neighbors: ImpactNeighbor[] = [...neighborScores.entries()]
    .map(([path, v]) => ({
      path,
      score: v.score,
      via: v.via.size > 1 ? ('both' as const) : ([...v.via][0] ?? 'imports'),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const traps: WorldModelImpact['traps'] = []
  if (opts.traps !== false) {
    try {
      // One batched query for every seed instead of one scan per seed.
      const bySeed = projectMemory.recallForFiles(projectId, seeds.slice(0, 5), 2, {
        preventiveOnly: true,
      })
      for (const [seed, hits] of bySeed) {
        for (const h of hits) {
          traps.push({
            id: h.id,
            type: h.type,
            title: h.content.replace(/\s+/g, ' ').trim().slice(0, 100),
            file: seed,
          })
        }
      }
    } catch {
      /* ignore */
    }
  }

  const nBit =
    neighbors.length > 0
      ? `related=${neighbors
          .slice(0, 3)
          .map((n) => n.path.split('/').pop())
          .join(',')}`
      : hasImports || hasCochange
        ? 'related=none-strong'
        : 'indexes=cold'
  const tBit = traps.length > 0 ? `traps=${traps.length}` : 'traps=0'
  const line =
    seeds.length === 0
      ? 'World model: no seed files'
      : `World model impact: seeds=${seeds.length} · ${nBit} · ${tBit}`

  return {
    seeds,
    neighbors,
    traps: traps.slice(0, limit),
    line,
    hasIndexes: { imports: hasImports, cochange: hasCochange },
  }
}

/** Markdown block for guard / prime. */
export function formatImpactMd(impact: WorldModelImpact): string {
  if (impact.seeds.length === 0) return ''
  const lines = [`# prjct: world-model impact`, impact.line, '']
  if (impact.neighbors.length > 0) {
    lines.push('Related (imports/co-change):')
    for (const n of impact.neighbors.slice(0, 6)) {
      lines.push(`- \`${n.path}\` (${n.via}, score=${n.score.toFixed(2)})`)
    }
    lines.push('')
  }
  if (impact.traps.length > 0) {
    lines.push('Judgment on seed files:')
    for (const t of impact.traps.slice(0, 5)) {
      lines.push(`- **[${t.type}]** ${t.title} \`${t.id}\``)
    }
  }
  return lines.join('\n').trim()
}
