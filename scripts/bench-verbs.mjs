#!/usr/bin/env node
/**
 * Verb hot-path benchmark (Phase 0 baseline; Phase 1 ratchet).
 *
 * Black-box times the interactive latency a user pays per `prjct <verb>` — the
 * full spawn → runtime boot → daemon round-trip → render → exit cycle for the
 * hot read verbs. This is the number the Phase 1 native daemon-first client is
 * built to crush: today every verb boots a JS runtime just to CONNECT to the
 * daemon (~250-400ms warm). Run before/after that change to prove it with a
 * number. --cold adds PRJCT_NO_DAEMON=1 to isolate pure boot.
 *
 * Usage: node scripts/bench-verbs.mjs [--iterations N] [--runtime node|bun|both] [--cold] [--fail]
 *
 * Needs a built dist and a real prjct project (defaults to this repo).
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const distEntry = path.join(repoRoot, 'dist', 'bin', 'prjct.mjs')

function parseArgs(argv) {
  const out = { iterations: 15, runtime: 'both', cold: false, failOnBudget: false }
  const parseAt = (index) => {
    if (index >= argv.length) return
    const arg = argv[index]
    if (arg === '--iterations' || arg === '-n') {
      out.iterations = Number.parseInt(argv[index + 1], 10) || 15
      return parseAt(index + 2)
    }
    if (arg === '--runtime') {
      out.runtime = argv[index + 1] ?? 'both'
      return parseAt(index + 2)
    }
    if (arg === '--cold') {
      out.cold = true
      return parseAt(index + 1)
    }
    if (arg === '--fail') {
      out.failOnBudget = true
      return parseAt(index + 1)
    }
    parseAt(index + 1)
  }
  parseAt(0)
  return out
}

/** Hot read verbs an agent hits every turn. All read-only. */
const VERBS = [
  { name: 'version', args: ['--version'] },
  { name: 'context', args: ['context', '--md'] },
  { name: 'work', args: ['work', '--md'] },
  { name: 'search', args: ['search', 'daemon'] },
  { name: 'guard', args: ['guard', 'core/commands/update.ts'] },
]

// Advisory baseline. Phase 0 measures; Phase 1 (native client) sets the hard
// ratchet once real numbers exist. Warm interactive p50 today ~250-400ms.
const BUDGET = {
  p50: Number(process.env.PRJCT_VERB_P50_MS ?? 500),
  p95: Number(process.env.PRJCT_VERB_P95_MS ?? 900),
}

function hasBun() {
  return spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0
}

function stats(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
  const mean = sorted.reduce((sum, x) => sum + x, 0) / sorted.length
  return { min: sorted[0], p50: at(50), p95: at(95), max: sorted.at(-1), mean }
}

function timeOnce(runtime, verb, cold) {
  const env = { ...process.env, PRJCT_NO_UPDATE_NOTICE: '1' }
  if (cold) env.PRJCT_NO_DAEMON = '1'
  const start = process.hrtime.bigint()
  const res = spawnSync(runtime, [distEntry, ...verb.args], {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
  })
  const ms = Number(process.hrtime.bigint() - start) / 1_000_000
  return { ms, ok: res.status === 0 }
}

function benchRuntime(runtime, iterations, cold) {
  console.log(`\n── runtime: ${runtime}${cold ? ' (cold, no daemon)' : ' (warm daemon)'} ──`)
  const regressions = []
  for (const verb of VERBS) {
    // Warm the fs cache and start the daemon; discard.
    Array.from({ length: 3 }, () => timeOnce(runtime, verb, cold))
    const measurements = Array.from({ length: iterations }, () => timeOnce(runtime, verb, cold))
    const samples = measurements.map(({ ms }) => ms)
    const failures = measurements.filter(({ ok }) => !ok).length
    const s = stats(samples)
    const f = failures > 0 ? `  ⚠ ${failures} non-zero exits` : ''
    console.log(
      `  prjct ${verb.name.padEnd(9)} ` +
        `min ${s.min.toFixed(1)}ms  p50 ${s.p50.toFixed(1)}ms  ` +
        `p95 ${s.p95.toFixed(1)}ms  max ${s.max.toFixed(1)}ms  mean ${s.mean.toFixed(1)}ms${f}`
    )
    if (failures > 0 || s.p50 > BUDGET.p50 || s.p95 > BUDGET.p95) {
      regressions.push({ verb: verb.name, failures, stats: s })
    }
  }
  return regressions
}

function main() {
  const { iterations, runtime, cold, failOnBudget } = parseArgs(process.argv.slice(2))
  if (!existsSync(distEntry)) {
    console.error(`dist not built: ${distEntry}\nRun \`npm run build\` first.`)
    process.exit(1)
  }
  console.log(`prjct verb hot-path benchmark — ${iterations} iterations/verb, cwd=${repoRoot}`)
  const runtimes = runtime === 'both' ? ['node', ...(hasBun() ? ['bun'] : [])] : [runtime]
  const regressions = runtimes.flatMap((rt) =>
    benchRuntime(rt, iterations, cold).map((regression) => ({ runtime: rt, ...regression }))
  )
  console.log(
    '\nPhase 1 native daemon-first client target: <30ms p50 warm. Baseline today: ~250-400ms.'
  )
  if (regressions.length > 0) {
    for (const regression of regressions) {
      console.error(
        `OVER-BUDGET ${regression.runtime}/${regression.verb}: ` +
          `p50 ${regression.stats.p50.toFixed(1)}ms (≤${BUDGET.p50}), ` +
          `p95 ${regression.stats.p95.toFixed(1)}ms (≤${BUDGET.p95}), exits=${regression.failures}`
      )
    }
    if (failOnBudget) process.exitCode = 1
  }
}

main()
