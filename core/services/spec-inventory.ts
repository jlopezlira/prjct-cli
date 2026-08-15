/**
 * Spec Inventory (Phase 1.6 / B-INV).
 *
 * Per-module coverage map + drift detection over the `specs` table.
 * Called from `prjct spec inventory`; exposes both --md and --json
 * shapes (B-JSON).
 *
 * Drift definition (locked in --help):
 *   For each spec with status=shipped and shipped_sha set, diff the
 *   spec's `scope[]` paths between shipped_sha and HEAD. If any path
 *   accumulated >5 LOC of NON-cosmetic changes, drift=true. Cosmetic
 *   = commits whose subject matches `^(chore|style|format|fmt)`.
 *
 *   shipped_sha NULL (legacy / pre-migration-18) → drift=unknown.
 *   Project not a git repo → drift=unknown.
 *
 * Coverage definition:
 *   Per top-level module dir (e.g. `core/auth/`, `core/sync/`):
 *     covered_pct = files_with_spec / total_files
 *   excluding: types.ts, **​/types/**, **​/__tests__/**, *.d.ts,
 *              index.ts re-export shims, .test.ts, .spec.ts.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { specStorage } from '../storage/spec-storage'
import type { Spec } from '../types/spec'
import { execFileAsync } from '../utils/exec'
import { parseScopePath } from './spec-validate'

const DRIFT_LOC_THRESHOLD = 5
const COSMETIC_COMMIT_RE = /^(chore|style|format|fmt|docs|typo)(\(|:|!)/i
const COVERAGE_EXCLUDE_RE = [
  /(^|\/)types\.ts$/,
  /(^|\/)types\//,
  /\/__tests__\//,
  /\.d\.ts$/,
  /(^|\/)index\.ts$/,
  /\.test\.ts$/,
  /\.spec\.ts$/,
]

export type DriftStatus = true | false | 'unknown'

export interface ModuleStats {
  module: string
  specCount: number
  /** files in module that are referenced by at least one spec.scope */
  coveredFiles: number
  /** total non-excluded code files in the module */
  totalFiles: number
  /** coveredFiles / totalFiles, rounded 2 decimals; null if 0 files */
  coveredPct: number | null
  /** ISO of the most recent spec.updatedAt in this module */
  lastUpdated: string | null
  /** True iff ANY shipped spec in this module reports drift=true. */
  drift: DriftStatus
}

export interface InventoryReport {
  generatedAt: string
  projectPath: string
  totalSpecs: number
  byStatus: Record<string, number>
  modules: ModuleStats[]
  /** Per-spec drift detail (for `--json` consumers that need granularity). */
  driftDetail: Array<{
    specId: string
    title: string
    status: string
    drift: DriftStatus
    locChanged?: number
    cosmeticOnly?: boolean
  }>
  /** Top-level dirs that appear in NO spec.scope (full coverage holes). */
  uncoveredModules: string[]
}

/**
 * Build the inventory report. `git` is optional — without it, drift
 * detection degrades to `unknown` for all shipped specs.
 */
export async function buildInventory(
  projectPath: string,
  projectId: string
): Promise<InventoryReport> {
  const allSpecs = specStorage.list(projectId, { includeArchived: true })
  const byStatus: Record<string, number> = {}
  for (const s of allSpecs) {
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1
  }

  // Group specs by inferred module (top 2 path segments of first scope entry).
  const specsByModule = new Map<string, Spec[]>()
  const allModuleDirs = new Set<string>()
  for (const s2 of allSpecs) {
    const mod = inferModule(s2)
    if (!mod) continue
    allModuleDirs.add(mod)
    const bucket = specsByModule.get(mod) ?? []
    bucket.push(s2)
    specsByModule.set(mod, bucket)
  }

  // Discover candidate top-level dirs from the project tree (`core/*`).
  const candidateModules = await listTopLevelModules(projectPath)
  for (const m of candidateModules) allModuleDirs.add(m)

  const modules: ModuleStats[] = []
  const driftDetail: InventoryReport['driftDetail'] = []

  for (const mod of [...allModuleDirs].sort()) {
    const specs = specsByModule.get(mod) ?? []
    const totalFiles = await countModuleFiles(projectPath, mod)
    const coveredFiles = await countCoveredFiles(projectPath, mod, specs)
    const lastUpdated =
      specs.length > 0 ? specs.reduce((m, s) => (s.updatedAt > m ? s.updatedAt : m), '') : null

    const shippedDrift: DriftStatus[] = []
    for (const s3 of specs.filter((sp) => sp.status === 'shipped')) {
      const detail = await driftForSpec(projectPath, s3)
      shippedDrift.push(detail.drift)
      driftDetail.push({
        specId: s3.id,
        title: s3.title,
        status: s3.status,
        drift: detail.drift,
        locChanged: detail.locChanged,
        cosmeticOnly: detail.cosmeticOnly,
      })
    }
    const drift: DriftStatus = shippedDrift.includes(true)
      ? true
      : shippedDrift.includes('unknown')
        ? 'unknown'
        : false

    modules.push({
      module: mod,
      specCount: specs.length,
      coveredFiles,
      totalFiles,
      coveredPct: totalFiles === 0 ? null : Math.round((coveredFiles / totalFiles) * 10000) / 100,
      lastUpdated: lastUpdated || null,
      drift,
    })
  }

  const uncoveredModules = modules.filter((m) => m.specCount === 0).map((m) => m.module)

  return {
    generatedAt: new Date().toISOString(),
    projectPath,
    totalSpecs: allSpecs.length,
    byStatus,
    modules,
    driftDetail,
    uncoveredModules,
  }
}

/** Pick the top-2-segment module path from the spec's scope. */
function inferModule(spec: Spec): string | null {
  const first = spec.content.scope[0]
  if (!first) return null
  // scope items are often "core/sync/sync-manager.ts — desc" — peel
  // off the path-like prefix (shared helper, see spec-validate.ts).
  const peeled = parseScopePath(first)
  if (!peeled) return null
  const segments = peeled.split('/').filter(Boolean).slice(0, 2)
  return segments.length === 2 ? segments.join('/') : null
}

async function listTopLevelModules(projectPath: string): Promise<string[]> {
  // Project layout convention: `core/*` is where modules live.
  const coreDir = path.join(projectPath, 'core')
  try {
    const entries = await fs.readdir(coreDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('__'))
      .map((e) => `core/${e.name}`)
  } catch {
    return []
  }
}

async function countModuleFiles(projectPath: string, mod: string): Promise<number> {
  const dir = path.join(projectPath, mod)
  const files: string[] = []
  try {
    await walk(dir, async (full) => {
      const rel = path.relative(projectPath, full)
      if (excluded(rel)) return
      if (!isCodeFile(rel)) return
      files.push(rel)
    })
  } catch {
    // Directory missing — counts as 0
  }
  return files.length
}

async function countCoveredFiles(projectPath: string, mod: string, specs: Spec[]): Promise<number> {
  // A file is "covered" if at least one spec.scope entry references it
  // (either by full path or by parent dir).
  const dir = path.join(projectPath, mod)
  const refs = new Set<string>()
  for (const s of specs) {
    for (const entry of s.content.scope) {
      const m = entry.match(/[a-zA-Z0-9_./-]+\.[a-z]+/)
      if (m) refs.add(m[0])
    }
  }
  const covered = new Set<string>()
  try {
    await walk(dir, async (full) => {
      const rel = path.relative(projectPath, full)
      if (excluded(rel)) return
      if (!isCodeFile(rel)) return
      for (const ref of refs) {
        if (rel === ref || rel.startsWith(ref.endsWith('/') ? ref : `${ref}/`)) {
          covered.add(rel)
          break
        }
      }
    })
  } catch {
    // Directory missing
  }
  return covered.size
}

async function walk(dir: string, visit: (full: string) => Promise<void>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      await walk(full, visit)
    } else if (e.isFile()) {
      await visit(full)
    }
  }
}

function excluded(rel: string): boolean {
  return COVERAGE_EXCLUDE_RE.some((re) => re.test(rel))
}

function isCodeFile(rel: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)
}

async function driftForSpec(
  projectPath: string,
  spec: Spec
): Promise<{ drift: DriftStatus; locChanged?: number; cosmeticOnly?: boolean }> {
  if (!spec.shippedSha) return { drift: 'unknown' }

  const scopePaths = spec.content.scope
    .map((s) => s.match(/[a-zA-Z0-9_./-]+\.[a-z]+/)?.[0] ?? s.match(/[a-zA-Z0-9_./-]+\//)?.[0])
    .filter((s): s is string => Boolean(s))
  if (scopePaths.length === 0) return { drift: 'unknown' }

  // Total LOC delta in the scope between shipped_sha and HEAD.
  const locChanged = await execFileAsync(
    'git',
    ['diff', '--shortstat', `${spec.shippedSha}..HEAD`, '--', ...scopePaths],
    { cwd: projectPath }
  )
    .then(({ stdout }) => {
      // Format: " 3 files changed, 42 insertions(+), 17 deletions(-)"
      const ins = stdout.match(/(\d+) insertions?/)
      const del = stdout.match(/(\d+) deletions?/)
      return (ins ? Number.parseInt(ins[1], 10) : 0) + (del ? Number.parseInt(del[1], 10) : 0)
    })
    .catch(() => null)
  if (locChanged === null) return { drift: 'unknown' }

  if (locChanged <= DRIFT_LOC_THRESHOLD) {
    return { drift: false, locChanged, cosmeticOnly: false }
  }

  // Check if all the commits that touched the scope are cosmetic-only.
  const cosmeticOnly = await execFileAsync(
    'git',
    ['log', '--format=%s', `${spec.shippedSha}..HEAD`, '--', ...scopePaths],
    { cwd: projectPath }
  )
    .then(({ stdout }) =>
      stdout
        .split('\n')
        .filter(Boolean)
        .every((s) => COSMETIC_COMMIT_RE.test(s))
    )
    .catch(() => false)

  return {
    drift: !cosmeticOnly,
    locChanged,
    cosmeticOnly,
  }
}

/** Render the inventory report as a Markdown table. */
export function renderInventoryMd(report: InventoryReport): string {
  const lines: string[] = []
  lines.push('# Spec inventory')
  lines.push('')
  lines.push(
    `_${report.totalSpecs} specs across ${report.modules.length} modules · generated ${report.generatedAt}_`
  )
  lines.push('')

  if (Object.keys(report.byStatus).length > 0) {
    lines.push('## By status')
    for (const [status, count] of Object.entries(report.byStatus)) {
      lines.push(`- ${status}: ${count}`)
    }
    lines.push('')
  }

  lines.push('## Coverage by module')
  lines.push('')
  lines.push('| Module | Specs | Files | Covered | % | Drift | Last updated |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const m of report.modules) {
    const pct = m.coveredPct === null ? 'n/a' : `${m.coveredPct}%`
    const drift = m.drift === true ? '⚠️ yes' : m.drift === 'unknown' ? '❔' : '✓'
    const updated = m.lastUpdated ? m.lastUpdated.slice(0, 10) : '—'
    lines.push(
      `| \`${m.module}\` | ${m.specCount} | ${m.totalFiles} | ${m.coveredFiles} | ${pct} | ${drift} | ${updated} |`
    )
  }

  if (report.uncoveredModules.length > 0) {
    lines.push('')
    lines.push('## Modules with NO specs')
    for (const m2 of report.uncoveredModules) lines.push(`- \`${m2}\``)
  }

  return lines.join('\n')
}
