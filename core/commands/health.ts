/**
 * Health Command — `prjct health`
 *
 * Composite quality dashboard. Wraps the project's existing tools
 * (typecheck, lint, tests, dead-code) and reports a per-dimension
 * pass/fail with a weighted overall score. Inspired by gstack's
 * `/health` SKILL.md (garrytan/gstack/health).
 *
 * Distinct from `prjct doctor` — doctor checks the *system* state
 * (binaries, configs, staleness). Health checks *code* quality.
 */

import path from 'node:path'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { execAsync } from '../utils/exec'
import { fileExists, readJson } from '../utils/file-helper'
import { failHard } from '../utils/md-aware'
import { PrjctCommandsBase } from './base'

interface HealthDimension {
  name: string
  /** The script name in package.json — e.g. `typecheck`, `lint`, `test`. */
  scriptName: string
  command: string | null
  /** ISO-ish narrative description shown to the user. */
  description: string
  weight: number
}

interface HealthResult {
  dimension: HealthDimension
  status: 'pass' | 'fail' | 'skipped'
  durationMs: number
  /** Captured first error line / diagnostic when status=fail. */
  diagnostic?: string
}

/**
 * The known dimensions and their package.json script names. The
 * runtime resolves a runner (bun preferred when available) and writes
 * the final command at detection time.
 */
const KNOWN_DIMENSIONS: ReadonlyArray<Omit<HealthDimension, 'command'>> = [
  { name: 'typecheck', scriptName: 'typecheck', description: 'TypeScript types', weight: 25 },
  { name: 'lint', scriptName: 'lint', description: 'Lint rules', weight: 20 },
  { name: 'tests', scriptName: 'test', description: 'Test suite', weight: 35 },
  { name: 'dead-code', scriptName: 'knip', description: 'Dead-code scan', weight: 20 },
]

export class HealthCommands extends PrjctCommandsBase {
  async health(
    _arg: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const dimensions = await detectDimensions(projectPath)
      const results: HealthResult[] = []
      for (const dim of dimensions) {
        results.push(await runDimension(projectPath, dim))
      }
      const score = computeScore(results)

      if (options.md) {
        console.log(formatMarkdown(score, results))
      } else {
        console.log(formatText(score, results))
      }

      // Exit non-zero on any FAIL so CI can gate on `prjct health`.
      const allPass = results.every((r) => r.status !== 'fail')
      return { success: allPass, score, results: results.length }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }
}

// Detection

async function detectDimensions(projectPath: string): Promise<HealthDimension[]> {
  const pkgPath = path.join(projectPath, 'package.json')
  if (!(await fileExists(pkgPath))) {
    return []
  }
  const pkg = await readJson<{ scripts?: Record<string, string> }>(pkgPath, null)
  const scripts = pkg?.scripts ?? {}

  // Pick the runner. We resolve to the script value DIRECTLY (sh -c
  // <script>) rather than `bun run <name>` / `npm run <name>` so the
  // health command works regardless of which package manager is on PATH.
  // This also dodges the "global npm not installed" failure mode in CI
  // / sandboxed test environments.
  return KNOWN_DIMENSIONS.filter((d) => Boolean(scripts[d.scriptName])).map((d) => ({
    ...d,
    command: scripts[d.scriptName] ?? null,
  }))
}

// Dimension execution

// Default budget per dimension. Overridable — a loaded machine (e.g. this
// process itself running concurrent agent work) can legitimately push a
// 2864-test suite (~130s isolated) well past a tight default; a fixed
// timeout with no escape hatch turns transient contention into a false FAIL.
const DEFAULT_DIM_TIMEOUT_MS = 5 * 60 * 1000

function dimensionTimeoutMs(): number {
  const raw = process.env.PRJCT_HEALTH_DIM_TIMEOUT_MS
  const parsed = raw ? Number(raw) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DIM_TIMEOUT_MS
}

async function runDimension(projectPath: string, dim: HealthDimension): Promise<HealthResult> {
  if (!dim.command) {
    return { dimension: dim, status: 'skipped', durationMs: 0 }
  }
  const start = Date.now()
  const timeoutMs = dimensionTimeoutMs()
  // Prepend node_modules/.bin so locally-installed binaries (knip,
  // biome, vitest, etc.) resolve regardless of the parent process'
  // PATH. Without this, `prjct health` from a globally-installed
  // daemon misses every devDependency-installed tool. The user's
  // shell PATH is preserved as the suffix.
  const localBin = path.join(projectPath, 'node_modules', '.bin')
  const env = {
    ...process.env,
    PATH: `${localBin}:${process.env.PATH ?? ''}`,
  }
  try {
    await execAsync(dim.command, {
      cwd: projectPath,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env,
    })
    return { dimension: dim, status: 'pass', durationMs: Date.now() - start }
  } catch (error) {
    // Node's child_process sets `killed: true` (and usually `signal:
    // 'SIGTERM'`) when the `timeout` option fires. Without this check the
    // catch-all below scrapes "first non-empty line of stdout/stderr" —
    // for a killed test run that's whatever line the reporter happened to
    // be mid-flush on, which reads as "this file failed" when nothing
    // actually failed; the run just didn't finish in time.
    const errWithMeta = error as {
      killed?: boolean
      signal?: string
      stderr?: string
      stdout?: string
    }
    if (errWithMeta.killed) {
      return {
        dimension: dim,
        status: 'fail',
        durationMs: Date.now() - start,
        diagnostic: `timed out after ${(timeoutMs / 1000).toFixed(0)}s (raise via PRJCT_HEALTH_DIM_TIMEOUT_MS)`,
      }
    }
    const stderr = errWithMeta.stderr ?? ''
    const stdout = errWithMeta.stdout ?? ''
    const firstNonEmpty = `${stderr}\n${stdout}`
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0)
    return {
      dimension: dim,
      status: 'fail',
      durationMs: Date.now() - start,
      diagnostic: firstNonEmpty ?? getErrorMessage(error),
    }
  }
}

// Scoring

function computeScore(results: HealthResult[]): number {
  if (results.length === 0) return 0
  // Weighted: each pass contributes its full weight, fails contribute 0,
  // skipped don't change the denominator (we only count present dimensions).
  const { pts, denom } = results.reduce(
    (score, result) =>
      result.status === 'skipped'
        ? score
        : {
            pts: score.pts + (result.status === 'pass' ? result.dimension.weight : 0),
            denom: score.denom + result.dimension.weight,
          },
    { pts: 0, denom: 0 }
  )
  if (denom === 0) return 0
  return Math.round((pts / denom) * 100)
}

// Output

function statusIcon(status: HealthResult['status']): string {
  if (status === 'pass') return '✓'
  if (status === 'fail') return '✗'
  return '·'
}

function formatText(score: number, results: HealthResult[]): string {
  if (results.length === 0) {
    return 'health: no quality dimensions detected (add typecheck/lint/test/knip scripts to package.json)'
  }
  const lines: string[] = []
  lines.push(`health: ${score}/100`)
  for (const r of results) {
    const dur = r.durationMs > 1000 ? `${(r.durationMs / 1000).toFixed(1)}s` : `${r.durationMs}ms`
    const tail = r.status === 'fail' && r.diagnostic ? ` — ${r.diagnostic.slice(0, 80)}` : ''
    lines.push(`  ${statusIcon(r.status)} ${r.dimension.name.padEnd(10)} ${dur}${tail}`)
  }
  return lines.join('\n')
}

function formatMarkdown(score: number, results: HealthResult[]): string {
  if (results.length === 0) {
    return `## Health\n\n_No quality dimensions detected. Add \`typecheck\`, \`lint\`, \`test\`, or \`knip\` scripts to \`package.json\`._\n`
  }
  const lines: string[] = []
  lines.push(`## Health — ${score}/100`)
  lines.push('')
  lines.push('| Dimension | Status | Duration | Notes |')
  lines.push('|---|---|---|---|')
  for (const r of results) {
    const dur = r.durationMs > 1000 ? `${(r.durationMs / 1000).toFixed(1)}s` : `${r.durationMs}ms`
    const note =
      r.status === 'fail' && r.diagnostic ? r.diagnostic.slice(0, 100).replaceAll('|', '\\|') : ''
    lines.push(`| ${r.dimension.name} | ${r.status} | ${dur} | ${note} |`)
  }
  return lines.join('\n')
}
