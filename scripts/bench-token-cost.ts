#!/usr/bin/env bun
/**
 * Token-cost bench — what non-caching hosts (Kimi/Codex) re-pay for prjct.
 * Logic SSOT: core/services/token-cost-bench.ts
 *
 * Usage: bun scripts/bench-token-cost.ts [turns]
 */

import {
  formatHarnessMarkdown,
  formatTokenCostMarkdown,
  type HarnessSessionCost,
  runTokenCostBench,
  simulateHarnessSession,
} from '../core/services/token-cost-bench'

const turns = Number.parseInt(process.argv[2] ?? '', 10) || undefined
const report = await runTokenCostBench(turns)
console.log(formatTokenCostMarkdown(report))

const harness: HarnessSessionCost[] = []
for (const host of ['claude', 'kimi', 'codex'] as const) {
  harness.push(await simulateHarnessSession(host, turns))
}
console.log('')
console.log(formatHarnessMarkdown(harness))
