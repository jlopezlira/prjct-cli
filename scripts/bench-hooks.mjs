#!/usr/bin/env node
/**
 * Hook hot-path benchmark (Phase 0 instrumentation).
 *
 * Measures the REAL wall-clock cost a user pays per hook: the full
 * spawn → module load → hook body → exit cycle of `prjct hook <event>`,
 * exactly as Claude Code invokes it (`<bin> hook <subcommand>` with the
 * event JSON on stdin). This is the number that decides whether routing
 * hooks through the daemon is worth its complexity — run it before and
 * after any such change.
 *
 * It does NOT instrument the hot path itself (that would add overhead to
 * the thing we're trying to keep lean); it black-box-times the production
 * artifact in `dist/`.
 *
 * Usage:
 *   node scripts/bench-hooks.mjs [--iterations N] [--runtime node|bun|both] [--no-fail]
 *
 * Notes:
 *   - PRJCT_NO_DAEMON=1 deliberately measures the cold-path SLO. Warm-path
 *     percentiles are continuously visible through `prjct perf --md`.
 *   - Run from inside a real prjct project so the DB/config/vault paths are
 *     exercised. Defaults to the repo itself.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const distEntry = path.join(repoRoot, 'dist', 'bin', 'prjct.mjs')

function parseArgs(argv) {
  const out = { iterations: 20, runtime: 'both', failOnBudget: true }
  const parseAt = (index) => {
    if (index >= argv.length) return
    const arg = argv[index]
    if (arg === '--iterations' || arg === '-n') {
      out.iterations = Number.parseInt(argv[index + 1], 10) || 30
      return parseAt(index + 2)
    }
    if (arg === '--runtime') {
      out.runtime = argv[index + 1] ?? 'both'
      return parseAt(index + 2)
    }
    if (arg === '--no-fail') {
      out.failOnBudget = false
      return parseAt(index + 1)
    }
    parseAt(index + 1)
  }
  parseAt(0)
  return out
}

/** Realistic event payloads (the hook reads these from stdin). */
const EVENTS = [
  { name: 'session-start', stdin: JSON.stringify({ source: 'startup' }) },
  {
    name: 'prompt',
    stdin: JSON.stringify({ prompt: 'how should we cache the auth token responses?' }),
  },
  {
    name: 'pre-bash',
    stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status --short' } }),
  },
  {
    name: 'pre-edit',
    stdin: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'package.json' } }),
  },
  {
    name: 'pre-search',
    stdin: JSON.stringify({ tool_name: 'Grep', tool_input: { pattern: 'daemon' } }),
  },
  {
    name: 'post-edit',
    stdin: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'package.json' } }),
  },
  { name: 'stop', stdin: JSON.stringify({}) },
  { name: 'subagent-start', stdin: JSON.stringify({ agent_id: 'bench' }) },
  { name: 'subagent-stop', stdin: JSON.stringify({ agent_id: 'bench' }) },
  { name: 'notification', stdin: JSON.stringify({ message: 'bench' }) },
  { name: 'cwd-changed', stdin: JSON.stringify({ cwd: repoRoot }) },
]

const BUDGETS = {
  node: {
    p50: Number(process.env.PRJCT_HOOK_COLD_P50_MS ?? 400),
    p95: Number(process.env.PRJCT_HOOK_COLD_P95_MS ?? 800),
  },
  bun: {
    p50: Number(process.env.PRJCT_HOOK_COLD_P50_MS ?? 400),
    p95: Number(process.env.PRJCT_HOOK_COLD_P95_MS ?? 800),
  },
}

function hasBun() {
  return spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0
}

function stats(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
  const mean = sorted.reduce((s, x) => s + x, 0) / sorted.length
  return { min: sorted[0], p50: at(50), p95: at(95), max: sorted.at(-1), mean }
}

function timeOnce(runtime, event) {
  const start = process.hrtime.bigint()
  const res = spawnSync(runtime, [distEntry, 'hook', event.name], {
    input: event.stdin,
    cwd: repoRoot,
    env: {
      ...process.env,
      PRJCT_NO_DAEMON: '1',
      PRJCT_NO_UPDATE_NOTICE: '1',
      PRJCT_HOOK_BENCH: '1',
    },
    encoding: 'utf-8',
  })
  const ms = Number(process.hrtime.bigint() - start) / 1_000_000
  return { ms, ok: res.status === 0 }
}

function benchRuntime(runtime, iterations) {
  console.log(`\n── runtime: ${runtime} ──`)
  const regressions = []
  for (const event of EVENTS) {
    // Warm the filesystem cache; discard.
    Array.from({ length: 3 }, () => timeOnce(runtime, event))
    const measurements = Array.from({ length: iterations }, () => timeOnce(runtime, event))
    const samples = measurements.map(({ ms }) => ms)
    const failures = measurements.filter(({ ok }) => !ok).length
    const s = stats(samples)
    const f = failures > 0 ? `  ⚠ ${failures} non-zero exits` : ''
    console.log(
      `  ${event.name.padEnd(14)} ` +
        `min ${s.min.toFixed(1)}ms  p50 ${s.p50.toFixed(1)}ms  ` +
        `p95 ${s.p95.toFixed(1)}ms  max ${s.max.toFixed(1)}ms  mean ${s.mean.toFixed(1)}ms${f}`
    )
    const budget = BUDGETS[runtime] ?? BUDGETS.node
    if (failures > 0 || s.p50 > budget.p50 || s.p95 > budget.p95) {
      regressions.push({ event: event.name, failures, stats: s, budget })
    }
  }
  return regressions
}

function main() {
  const { iterations, runtime, failOnBudget } = parseArgs(process.argv.slice(2))
  if (!existsSync(distEntry)) {
    console.error(`dist not built: ${distEntry}\nRun \`npm run build\` first.`)
    process.exit(1)
  }
  console.log(`prjct hook hot-path benchmark — ${iterations} iterations/event, cwd=${repoRoot}`)
  const runtimes = runtime === 'both' ? ['node', ...(hasBun() ? ['bun'] : [])] : [runtime]
  const regressions = runtimes.flatMap((rt) =>
    benchRuntime(rt, iterations).map((regression) => ({ runtime: rt, ...regression }))
  )
  console.log(
    '\nCold SLO: p50 ≤ 400ms, p95 ≤ 800ms per installed hook. ' +
      'Warm production samples: `prjct perf --md`.'
  )
  if (regressions.length > 0) {
    for (const regression of regressions) {
      console.error(
        `REGRESSION ${regression.runtime}/${regression.event}: ` +
          `p50 ${regression.stats.p50.toFixed(1)}ms (≤${regression.budget.p50}), ` +
          `p95 ${regression.stats.p95.toFixed(1)}ms (≤${regression.budget.p95}), ` +
          `exits=${regression.failures}`
      )
    }
    if (failOnBudget) process.exitCode = 1
  }
}

main()
