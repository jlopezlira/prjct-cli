/**
 * Retrieval eval CLI (scripts/eval-retrieval.mjs). Prints the baseline
 * Recall@k / MRR / nDCG@k for a project's recall pipeline over its own ledger
 * pairs, with a leak-free temporal split — the yardstick to run before and after
 * any retrieval change. The structured report + renderers live in ./report and
 * back the `prjct harness retrieval` verb and the CI baseline test too.
 *
 *   bun run scripts/eval-retrieval.mjs <projectId> [k]
 */

import { buildRetrievalReport, renderRetrievalReportText } from './report'

export async function runEval(projectId: string, k = 10): Promise<void> {
  const report = await buildRetrievalReport(projectId, k)
  console.log(`\n${renderRetrievalReportText(report)}\n`)
  console.log('Drop a pretrained ONNX provider into evalProvider() to compare on the same pairs.\n')
}
