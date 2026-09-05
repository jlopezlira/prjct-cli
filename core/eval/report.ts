/**
 * Retrieval baseline report — the structured yardstick behind the
 * `prjct harness retrieval` verb, the `scripts/eval-retrieval.mjs` script, and
 * the CI baseline test. Scores the retrievers prjct actually serves (BM25 over
 * the real FTS5 index; the local hashing embedder) over a project's own
 * distinct queries. The served pipeline disables attribution; comparison gates
 * use explicit references only. Date cohorts rank the current frozen corpus,
 * not a historical replay. A configured HTTP embedder may consume provider tokens.
 */

import configManager from '../infrastructure/config-manager'
import { enrichedRecall } from '../memory/enriched-recall'
import type { MemoryEntry } from '../memory/entries'
import { hashBlobContent } from '../services/content-bound-stamp'
import type { EmbeddingProvider } from '../services/embeddings'
import { LocalSubwordEmbeddingProvider } from '../services/embeddings'
import prjctDb from '../storage/database'
import { exportLedgerPairs, type LabeledPair, temporalSplit } from './ledger-pairs'
import { evalBm25, evalFused, evalProvider } from './retrieval-eval'
import {
  type AggregateMetrics,
  aggregate,
  evaluateImprovementGate,
  type ImprovementGateResult,
} from './retrieval-metrics'

export interface RetrievalLeg {
  bm25: AggregateMetrics
  hashing: AggregateMetrics
  /** RRF over both legs — the candidate that has to beat each leg alone. */
  fused: AggregateMetrics
  /** Would swapping the lexical baseline for the hashing encoder clear the gate? */
  gate: ImprovementGateResult
  /** The decision gate that matters: fused vs the BM25 baseline prjct serves. */
  fusionGate: ImprovementGateResult
}

export interface RetrievalReport {
  snapshotHash: string
  served: {
    all: AggregateMetrics
    explicit: AggregateMetrics
    proxy: AggregateMetrics
    heldOutExplicit: AggregateMetrics
  }
  servedCost: 'local' | 'configured-provider'

  projectId: string
  k: number
  corpusSize: number
  pairCount: number
  labelSources: Record<string, number>
  cutoff: string
  trainSize: number
  evalSize: number
  /** All distinct explicit-reference queries; proxies never qualify a swap. */
  all: RetrievalLeg | null
  /** Newest 20% of explicit queries against the current frozen corpus. */
  heldOut: RetrievalLeg | null
}

async function scoreLeg(
  projectId: string,
  entries: MemoryEntry[],
  pairs: LabeledPair[],
  k: number,
  provider: EmbeddingProvider
): Promise<RetrievalLeg | null> {
  if (pairs.length === 0) return null
  const bm25 = evalBm25(projectId, pairs, k)
  const hashing = await evalProvider(entries, pairs, provider, k)
  const fused = await evalFused(projectId, entries, pairs, provider, k)
  return {
    bm25,
    hashing,
    fused,
    gate: evaluateImprovementGate(bm25, hashing),
    fusionGate: evaluateImprovementGate(bm25, fused),
  }
}

export async function buildRetrievalReport(
  projectId: string,
  k = 10,
  projectPath = process.cwd()
): Promise<RetrievalReport> {
  const { entries, pairs } = exportLedgerPairs(projectId)
  const explicitPairs = pairs.filter((pair) => pair.source !== 'ship-surfaced')
  const split = temporalSplit(explicitPairs, 0.2)
  const labelSources = pairs.reduce<Record<string, number>>((acc, pair) => {
    const source = pair.source ?? 'reference-edge'
    acc[source] = (acc[source] ?? 0) + 1
    return acc
  }, {})
  const config = await configManager.readConfig(projectPath)
  const usefulness = () =>
    JSON.stringify(prjctDb.query(projectId, 'SELECT * FROM memory_usefulness ORDER BY memory_id'))
  const semanticIndex = () =>
    prjctDb.query(
      projectId,
      'SELECT rowid, memory_id, hex(vector) AS vector, model, dims, norm, created_at FROM memory_embeddings ORDER BY rowid'
    )
  const before = JSON.stringify({
    entries,
    pairs,
    usefulness: usefulness(),
    config,
    semanticIndex: semanticIndex(),
  })
  const allowedIds = new Set(entries.map((e) => e.id))
  const nowMs = Date.now()
  const servedCases: Array<{ pair: LabeledPair; ranked: string[]; relevant: Set<string> }> = []
  for (const pair of pairs) {
    const recalled = await enrichedRecall(projectPath, projectId, {
      topic: pair.queryText,
      limit: k,
      recordAttribution: false,
      excludeIds: [pair.anchorId, ...(pair.excludeIds ?? [])],
      allowedIds,
      nowMs,
      configSnapshot: config,
    })
    servedCases.push({ pair, ranked: recalled.map((e) => e.id), relevant: new Set(pair.positives) })
  }
  const explicit = servedCases.filter((c) => c.pair.source !== 'ship-surfaced')
  const heldOutAnchors = new Set(
    temporalSplit(
      explicit.map((c) => c.pair),
      0.2
    ).evalSet.map((p) => p.anchorId)
  )
  const local = new LocalSubwordEmbeddingProvider()
  const cache = new Map<string, number[]>()
  const provider: EmbeddingProvider = {
    model: local.model,
    isLocal: true,
    embed: async (texts) => {
      const missing = [...new Set(texts.filter((text) => !cache.has(text)))]
      const vectors = await local.embed(missing)
      missing.forEach((text, i) => {
        cache.set(text, vectors[i]!)
      })
      return texts.map((text) => cache.get(text)!)
    },
  }
  const report: RetrievalReport = {
    projectId,
    k,
    corpusSize: entries.length,
    pairCount: pairs.length,
    labelSources,
    cutoff: split.cutoff,
    trainSize: split.train.length,
    evalSize: split.evalSet.length,
    all: await scoreLeg(projectId, entries, explicitPairs, k, provider),
    heldOut: await scoreLeg(projectId, entries, split.evalSet, k, provider),
    snapshotHash: hashBlobContent(before),
    servedCost:
      config?.embeddings?.provider === 'openai-compatible' ? 'configured-provider' : 'local',
    served: {
      all: aggregate(servedCases, k),
      explicit: aggregate(explicit, k),
      proxy: aggregate(
        servedCases.filter((c) => c.pair.source === 'ship-surfaced'),
        k
      ),
      heldOutExplicit: aggregate(
        explicit.filter((c) => heldOutAnchors.has(c.pair.anchorId)),
        k
      ),
    },
  }
  const after = exportLedgerPairs(projectId)
  if (
    before !==
    JSON.stringify({
      entries: after.entries,
      pairs: after.pairs,
      usefulness: usefulness(),
      config: await configManager.readConfig(projectPath),
      semanticIndex: semanticIndex(),
    })
  )
    throw new Error(
      'Retrieval corpus, configuration or usefulness changed during evaluation; discard this run and retry on a stable snapshot.'
    )
  return report
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

function gateLine(gate: ImprovementGateResult): string {
  const lift = gate.lifts.find((l) => l.metric === gate.primaryMetric)
  const liftStr = lift
    ? lift.relativeLift === Number.POSITIVE_INFINITY
      ? '+∞'
      : `${lift.relativeLift >= 0 ? '+' : ''}${(lift.relativeLift * 100).toFixed(1)}%`
    : 'n/a'
  const status = gate.passed ? 'PASS' : 'FAIL'
  const detail =
    gate.sampleCount < gate.minCases
      ? `need ${gate.minCases - gate.sampleCount} more labeled pairs`
      : `${gate.primaryMetric} lift ${liftStr}, required +${(gate.minRelativeLift * 100).toFixed(0)}%`
  return `${status} (${detail}; sample ${gate.sampleCount}/${gate.minCases})`
}

export function renderRetrievalReportMd(report: RetrievalReport): string {
  const sources =
    Object.entries(report.labelSources)
      .map(([source, n]) => `${source}=${n}`)
      .join(', ') || 'none'
  const rows = [['explicit', report.all] as const, ['held-out explicit', report.heldOut] as const]
    .filter(([, leg]) => leg !== null)
    .flatMap(([label, leg]) => {
      const l = leg as RetrievalLeg
      return [
        `| ${label} | BM25 (FTS5) | ${pct(l.bm25.recallAtK)} | ${pct(l.bm25.mrr)} | ${pct(l.bm25.ndcgAtK)} |`,
        `| ${label} | hashing (local) | ${pct(l.hashing.recallAtK)} | ${pct(l.hashing.mrr)} | ${pct(l.hashing.ndcgAtK)} |`,
        `| ${label} | **RRF fused** | ${pct(l.fused.recallAtK)} | ${pct(l.fused.mrr)} | ${pct(l.fused.ndcgAtK)} |`,
      ]
    })
  const gate = report.heldOut?.gate ?? report.all?.gate
  return [
    `## Retrieval baseline — project ${report.projectId}`,
    '',
    `- corpus (model-worthy): ${report.corpusSize} entries`,
    `- distinct labeled queries: ${report.pairCount} (${sources})`,
    `- explicit date split @ ${report.cutoff || 'n/a'} — train ${report.trainSize} / held-out ${report.evalSize}`,
    '- Date cohorts use the current frozen corpus; this is not a historical replay.',
    `- served retrieval cost: ${report.servedCost === 'local' ? 'local CPU + SQLite' : 'configured embedding provider; provider usage is not measured here'}`,
    `- frozen inputs: ${report.snapshotHash}; evaluation attribution disabled`,
    '- Ship-surfaced labels are proxy relevance, not explicit usage evidence.',
    '- Comparison gates use distinct explicit-reference queries only; proxy counts cannot satisfy their sample threshold.',
    '',
    `| served pipeline label set | queries | Recall@${report.k} | MRR | nDCG |`,
    '|---|---:|---:|---:|---:|',
    ...Object.entries(report.served).map(
      ([name, m]) =>
        `| ${name} | ${m.queries} | ${pct(m.recallAtK)} | ${pct(m.mrr)} | ${pct(m.ndcgAtK)} |`
    ),
    '',
    report.pairCount === 0
      ? '_No labeled pairs yet — reference an older `mem_N` when you capture, or ship work that surfaces memory._'
      : !report.all
        ? '_No explicit-reference queries; proxy diagnostics cannot qualify a comparison gate._'
        : [
            `| set | retriever | Recall@${report.k} | MRR | nDCG@${report.k} |`,
            '|---|---|---|---|---|',
            ...rows,
            '',
            `Swap gate (hashing vs BM25): ${gate ? gateLine(gate) : 'n/a'}`,
            `**Fusion gate (RRF vs BM25): ${gate ? gateLine((report.heldOut ?? report.all)?.fusionGate ?? gate) : 'n/a'}**`,
          ].join('\n'),
    '',
  ].join('\n')
}

export function renderRetrievalReportText(report: RetrievalReport): string {
  const fmt = (m: AggregateMetrics): string =>
    `Recall@${report.k}=${pct(m.recallAtK)}  MRR=${pct(m.mrr)}  nDCG@${report.k}=${pct(m.ndcgAtK)}`
  const lines = [
    `Retrieval baseline · project ${report.projectId}`,
    `  served explicit n=${report.served.explicit.queries}; proxy n=${report.served.proxy.queries}; snapshot=${report.snapshotHash}`,
    `  corpus ${report.corpusSize} · distinct queries ${report.pairCount} · explicit split @ ${report.cutoff || 'n/a'} (train ${report.trainSize}, held-out ${report.evalSize})`,
    '  Comparison gates exclude proxies. Date cohorts use the current frozen corpus, not historical replay.',
  ]
  for (const [label, leg] of [
    ['explicit', report.all],
    ['held-out explicit', report.heldOut],
  ] as const) {
    if (!leg) continue
    lines.push(`  ${label}`)
    lines.push(`    BM25 (FTS5)     ${fmt(leg.bm25)}  n=${leg.bm25.queries}`)
    lines.push(`    hashing (local) ${fmt(leg.hashing)}  n=${leg.hashing.queries}`)
    lines.push(`    RRF fused       ${fmt(leg.fused)}  n=${leg.fused.queries}`)
    lines.push(`    swap gate       ${gateLine(leg.gate)}`)
    lines.push(`    fusion gate     ${gateLine(leg.fusionGate)}`)
  }
  if (report.pairCount === 0) lines.push('  no labeled pairs yet')
  return lines.join('\n')
}
