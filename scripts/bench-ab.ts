/**
 * A/B performance benchmark: the installed/dev build vs a published version.
 *
 *   bun scripts/bench-ab.ts 3.20.0          # dev source vs npm version
 *   bun scripts/bench-ab.ts 3.20.0 3.21.2   # npm version vs npm version
 *
 * Real product-lifecycle commands (setup → init → work/remember/search/
 * guard/status), isolated PRJCT_CLI_HOME per side, interleaved (A,B,A,B,…)
 * median of N runs with a confirm pass before any REGRESSION verdict — the
 * same methodology used to validate the launcher and Schema v2 wins. Run it
 * before shipping perf-sensitive changes; a regression here is a regression
 * for every user turn.
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..')
const REPS = Number(process.env.BENCH_REPS ?? 15)

function fetchVersion(version: string): { bin: string; runner: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${version}-`))
  execFileSync('npm', ['pack', `prjct-cli@${version}`], { cwd: dir, stdio: 'ignore' })
  execFileSync('tar', ['-xzf', `prjct-cli-${version}.tgz`], { cwd: dir })
  const pkgDir = path.join(dir, 'package')
  // Published tarballs ship dist/ + the portable launcher, NOT core/ sources —
  // a packed version must run exactly as users run it: node bin/prjct.cjs,
  // WITH its runtime deps installed (dist keeps e.g. zod external).
  // --ignore-scripts: benchmarking must never execute a package's hooks.
  execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: pkgDir,
    stdio: 'ignore',
  })
  return { bin: path.join(pkgDir, 'bin', 'prjct.cjs'), runner: 'node' }
}

interface Side {
  label: string
  bin: string
  runner: string
  home: string
  proj: string
}

function makeSide(label: string, runner: string, bin: string): Side {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-h-'))
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-p-'))
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"bench","version":"0.1.0"}')
  execFileSync('git', ['init', '-q'], { cwd: proj })
  const env = {
    ...process.env,
    PRJCT_CLI_HOME: home,
    HOME: home,
    PRJCT_NO_DAEMON: '1',
    CI: '1',
    NO_COLOR: '1',
  }
  execFileSync(runner, [bin, 'setup', '--non-interactive', '--md'], {
    cwd: proj,
    env,
    stdio: 'ignore',
  })
  execFileSync(runner, [bin, 'init', '--md'], { cwd: proj, env, stdio: 'ignore' })
  return { label, bin, runner, home, proj }
}

function once(side: Side, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const c = spawn(side.runner, [side.bin, ...args], {
      cwd: side.proj,
      stdio: 'ignore',
      env: {
        ...process.env,
        PRJCT_CLI_HOME: side.home,
        HOME: side.home,
        PRJCT_NO_DAEMON: '1',
        CI: '1',
        NO_COLOR: '1',
      },
    })
    c.on('exit', () => resolve(performance.now() - t0))
    c.on('error', () => resolve(-1))
  })
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/**
 * Interleave A/B reps (A,B,A,B,…) instead of running each side as a
 * contiguous batch. A contiguous 7-25s batch is single-burst fragile: one
 * ambient CPU/disk wave (npm-install churn, a sibling workspace typecheck,
 * Spotlight) lands entirely on ONE side of ONE case and shifts its whole
 * median — measured live as a phantom ±40-90% on `status --md` while every
 * neighbouring case was unaffected. Alternating reps spreads any wave evenly
 * across both sides, so the Δ% stays honest even on a loaded dev machine.
 */
async function medians(a: Side, b: Side, args: string[]): Promise<[number, number]> {
  const xa: number[] = []
  const xb: number[] = []
  for (const _iteration of Array.from({ length: REPS })) {
    xa.push(await once(a, args))
    xb.push(await once(b, args))
  }
  return [median(xa), median(xb)]
}

const CASES: Array<[string, string[]]> = [
  ['--version', ['--version']],
  ['status --md', ['status', '--md']],
  ['remember --md', ['remember', 'decision', 'bench probe', '--md']],
  ['search --md', ['search', 'bench', '--md']],
  ['guard file --md', ['guard', 'package.json', '--md']],
]

const [a, b] = process.argv.slice(2)
if (!a) {
  console.error('Usage: bun scripts/bench-ab.ts <baseline-version> [candidate-version]')
  process.exit(1)
}

console.log(`Fetching baseline prjct-cli@${a}…`)
const baseFetched = fetchVersion(a)
const baseline = makeSide(`v${a}`, baseFetched.runner, baseFetched.bin)
const candidate: Side = b
  ? (() => {
      console.log(`Fetching candidate prjct-cli@${b}…`)
      const candFetched = fetchVersion(b)
      return makeSide(`v${b}`, candFetched.runner, candFetched.bin)
    })()
  : makeSide('dev', 'bun', path.join(REPO, 'bin', 'prjct.ts'))

console.log(
  `\n${'command'.padEnd(18)} ${baseline.label.padStart(10)} ${candidate.label.padStart(10)}   Δ`
)
const regressions: string[] = []
for (const [label, args] of CASES) {
  const first = await medians(baseline, candidate, args)
  const firstPct = ((first[0] - first[1]) / first[0]) * 100
  // A >10% loss must reproduce in a second independent pass before it fails
  // the gate: interleaving spreads short bursts, but a wave outlasting the
  // whole case window can still tilt one pass. Both passes regressing is a
  // real signal; one is ambient noise (report the cleaner pass).
  const [mA, mB, pct] = await (async (): Promise<[number, number, number]> => {
    if (firstPct < -10) {
      const rerun = await medians(baseline, candidate, args)
      const rerunPct = ((rerun[0] - rerun[1]) / rerun[0]) * 100
      if (rerunPct >= -10) {
        console.log(
          `${label.padEnd(18)} first pass ${firstPct.toFixed(0)}% — not reproduced, keeping re-run`
        )
        return [rerun[0], rerun[1], rerunPct]
      }
    }
    return [first[0], first[1], firstPct]
  })()
  if (pct < -10) regressions.push(label)
  console.log(
    `${label.padEnd(18)} ${`${mA.toFixed(1)}ms`.padStart(10)} ${`${mB.toFixed(1)}ms`.padStart(10)}   ${pct >= 0 ? '-' : '+'}${Math.abs(pct).toFixed(0)}%${pct < -10 ? '  ⚠ REGRESSION' : ''}`
  )
}

for (const s of [baseline, candidate]) {
  fs.rmSync(s.home, { recursive: true, force: true })
  fs.rmSync(s.proj, { recursive: true, force: true })
}
if (regressions.length > 0) {
  console.error(`\n${regressions.length} command(s) regressed >10% vs ${baseline.label}.`)
  process.exit(1)
}
console.log('\nNo regressions >10%.')
