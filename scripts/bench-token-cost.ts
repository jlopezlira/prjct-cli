#!/usr/bin/env bun
/**
 * Token-cost bench — what non-caching hosts (Kimi/Codex) re-pay for prjct.
 * Logic SSOT: core/services/token-cost-bench.ts
 *
 * Usage: bun scripts/bench-token-cost.ts [turns]
 */

import { formatTokenCostMarkdown, runTokenCostBench } from '../core/services/token-cost-bench'

const turns = Number.parseInt(process.argv[2] ?? '', 10) || undefined
const report = await runTokenCostBench(turns)
console.log(formatTokenCostMarkdown(report))
