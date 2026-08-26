/**
 * Retrieval baseline report — the structured yardstick behind the
 * `prjct harness retrieval` verb, the `scripts/eval-retrieval.mjs` script, and
 * the CI baseline test. Scores the retrievers prjct actually serves (BM25 over
 * the real FTS5 index; the local hashing embedder) over a project's own
 * author-declared ledger pairs, with a leak-free temporal split. No LLM, no API
 * tokens.
 *
 * Phase 0 scores the LEGS. Scoring the blended `enrichedRecall` pipeline needs a
 * side-effect-free recall (it records fetches today) — that lands in Phase 2
 * alongside the RRF fusion this baseline exists to gate.
 */

import type { MemoryEntry } from '../memory/entries'
import { LocalSubwordEmbeddingProvider } from '../services/embeddings'
import { exportLedgerPairs, type LabeledPair, temporalSplit } from './ledger-pairs'
import { evalBm25, evalFused, evalProvider } from './retrieval-eval'
import {
  type AggregateMetrics,
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
  projectId: string
  k: number
  corpusSize: number
  pairCount: number
  labelSources: Record<string, number>
  cutoff: string
  trainSize: number
  evalSize: number
  /** All labeled pairs — more signal at low volume. */
  all: RetrievalLeg | null
  /** Held-out newest 20% — the honest, leak-free number. */
  heldOut: RetrievalLeg | null
}

async function scoreLeg(
  projectId: string,
  entries: MemoryEntry[],
  pairs: LabeledPair[],
  k: number
): Promise<RetrievalLeg | null> {
  if (pairs.length === 0) return null
  const provider = new LocalSubwordEmbeddingProvider()
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

export async function buildRetrievalReport(projectId: string, k = 10): Promise<RetrievalReport> {
  const { entries, pairs } = exportLedgerPairs(projectId)
  const split = temporalSplit(pairs, 0.2)
  const labelSources = pairs.reduce<Record<string, number>>((acc, pair) => {
    const source = pair.source ?? 'reference-edge'
    acc[source] = (acc[source] ?? 0) + 1
    return acc
  }, {})
  return {
    projectId,
    k,
    corpusSize: entries.length,
    pairCount: pairs.length,
    labelSources,
    cutoff: split.cutoff,
    trainSize: split.train.length,
    evalSize: split.evalSet.length,
    all: await scoreLeg(projectId, entries, pairs, k),
    heldOut: await scoreLeg(projectId, entries, split.evalSet, k),
  }
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
  const rows = [['ALL', report.all] as const, ['held-out', report.heldOut] as const]
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
    `- labeled pairs: ${report.pairCount} (${sources})`,
    `- temporal split @ ${report.cutoff || 'n/a'} — train ${report.trainSize} / held-out ${report.evalSize}`,
    '- cost: local CPU + SQLite; no LLM/API tokens',
    '',
    report.pairCount === 0
      ? '_No labeled pairs yet — reference an older `mem_N` when you capture, or ship work that surfaces memory._'
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
    `  corpus ${report.corpusSize} · pairs ${report.pairCount} · split @ ${report.cutoff || 'n/a'} (train ${report.trainSize}, held-out ${report.evalSize})`,
  ]
  for (const [label, leg] of [
    ['ALL', report.all],
    ['held-out', report.heldOut],
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
