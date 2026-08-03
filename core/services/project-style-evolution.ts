/**
 * Project style evolution — typed snapshots of how the *repository* works,
 * progressive over time. Symmetric to developer-evolution.ts.
 *
 *   capture / getActive / getEvolution / render / recomputeOnSync
 *
 * Measurement substrate: core counters are stable columns; payload JSON +
 * metrics bag stay extensible without rewriting history.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { memoryFingerprint } from '../memory/content-fingerprint'
import { projectMemory } from '../memory/project-memory'
import { prjctDb } from '../storage/database'
import llmAnalysisStorage from '../storage/llm-analysis-storage'
import type { LLMAnalysis } from '../types/llm-analysis'
import type {
  ProjectStyleDiff,
  ProjectStylePayload,
  ProjectStyleRecomputeResult,
  ProjectStyleSnapshot,
  ProjectStyleSource,
} from '../types/project-style'
import type { ProjectCommands, ProjectStats } from '../types/project-sync'
import type { StackDetection } from '../types/stack'
import { buildArchitectureSnapshot } from './architecture-snapshot'
import { formatProjectStyleDiffMd, generateProjectStyleDiff } from './project-style-diff'
import {
  buildProjectStyleSnapshot,
  formatProjectStyleDigest,
  isRichLlmAnalysis,
} from './project-style-profile'

const HISTORY_CAP = 50

interface SnapshotRow {
  id: string
  captured_at: string
  commit_hash: string | null
  source: string
  pattern_count: number
  anti_pattern_count: number
  convention_count: number
  framework_count: number
  symbol_count: number
  file_count: number
  summary: string
  payload_json: string
  is_active: number
}

function rowToSnapshot(r: SnapshotRow): ProjectStyleSnapshot {
  let payload: ProjectStylePayload
  try {
    payload = JSON.parse(r.payload_json) as ProjectStylePayload
  } catch {
    payload = emptyPayload()
  }
  return {
    id: r.id,
    capturedAt: r.captured_at,
    commitHash: r.commit_hash,
    source: (r.source as ProjectStyleSource) || 'sync-mechanical',
    patternCount: r.pattern_count,
    antiPatternCount: r.anti_pattern_count,
    conventionCount: r.convention_count,
    frameworkCount: r.framework_count,
    symbolCount: r.symbol_count,
    fileCount: r.file_count,
    summary: r.summary,
    payload,
  }
}

function emptyPayload(): ProjectStylePayload {
  return {
    payloadVersion: 1,
    stack: {
      ecosystem: 'unknown',
      languages: [],
      frameworks: [],
      keyLibraries: [],
      hasTests: false,
      hasDocker: false,
    },
    commands: {},
    conventions: [],
    patterns: [],
    antiPatterns: [],
    structural: { symbols: 0, files: 0, packages: [] },
    metrics: {},
  }
}

export function getActiveProjectStyle(projectId: string): ProjectStyleSnapshot | null {
  try {
    const row = prjctDb.get<SnapshotRow>(
      projectId,
      'SELECT * FROM project_style_snapshots WHERE is_active = 1 ORDER BY captured_at DESC LIMIT 1'
    )
    return row ? rowToSnapshot(row) : null
  } catch {
    return null
  }
}

/** History newest-first (includes active). */
export function getProjectEvolution(projectId: string, limit = 12): ProjectStyleSnapshot[] {
  try {
    return prjctDb
      .query<SnapshotRow>(
        projectId,
        'SELECT * FROM project_style_snapshots ORDER BY captured_at DESC LIMIT ?',
        limit
      )
      .map(rowToSnapshot)
  } catch {
    return []
  }
}

export function renderProjectEvolution(projectId: string, limit = 6): string | null {
  const snaps = getProjectEvolution(projectId, limit)
  if (snaps.length === 0) return null

  const lines: string[] = ['## Project evolution']
  if (snaps.length >= 2) {
    const latest = snaps[0]!
    const prior = snaps[snaps.length - 1]!
    const pDelta = latest.patternCount - prior.patternCount
    const cDelta = latest.conventionCount - prior.conventionCount
    const fDelta = latest.fileCount - prior.fileCount
    lines.push(
      `Over ${snaps.length} snapshots: patterns ${fmtDelta(pDelta)}, ` +
        `conventions ${fmtDelta(cDelta)}, files ${fmtDelta(fDelta)}.`
    )
  }
  for (const s of snaps) {
    lines.push(`- ${s.capturedAt.slice(0, 10)} — ${s.summary}`)
  }
  return lines.join('\n')
}

function fmtDelta(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`
}

/**
 * Persist a snapshot as the new active row; mark previous active inactive.
 * Cap history at HISTORY_CAP (delete oldest inactive).
 */
export function persistProjectStyleSnapshot(
  projectId: string,
  snapshot: ProjectStyleSnapshot
): void {
  prjctDb.transaction(projectId, (db) => {
    db.prepare('UPDATE project_style_snapshots SET is_active = 0 WHERE is_active = 1').run()
    db.prepare(
      `INSERT INTO project_style_snapshots (
         id, captured_at, commit_hash, source,
         pattern_count, anti_pattern_count, convention_count, framework_count,
         symbol_count, file_count, summary, payload_json, is_active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      snapshot.id,
      snapshot.capturedAt,
      snapshot.commitHash,
      snapshot.source,
      snapshot.patternCount,
      snapshot.antiPatternCount,
      snapshot.conventionCount,
      snapshot.frameworkCount,
      snapshot.symbolCount,
      snapshot.fileCount,
      snapshot.summary,
      JSON.stringify(snapshot.payload)
    )

    // Cap history: keep newest HISTORY_CAP
    const ids = db
      .prepare('SELECT id FROM project_style_snapshots ORDER BY captured_at DESC')
      .all() as Array<{ id: string }>
    if (ids.length > HISTORY_CAP) {
      const drop = ids.slice(HISTORY_CAP)
      const del = db.prepare('DELETE FROM project_style_snapshots WHERE id = ?')
      for (const row of drop) del.run(row.id)
    }
  })
}

export interface RecomputeProjectStyleArgs {
  projectId: string
  projectPath: string
  stats: ProjectStats
  stack: StackDetection
  commands?: ProjectCommands | null
  commitHash?: string | null
  source?: ProjectStyleSource
  /** When true, UPSERT style memories for vector recall. Default true. */
  bridgeMemory?: boolean
}

/**
 * Full recompute for sync heartbeat: build style, diff vs previous, persist,
 * optional memory bridge + repo-analysis.json for context surface.
 */
export async function recomputeProjectStyle(
  args: RecomputeProjectStyleArgs
): Promise<ProjectStyleRecomputeResult> {
  const previous = getActiveProjectStyle(args.projectId)
  const llm = pickBestAnalysis(args.projectId)
  const packageMeta = await readPackageMeta(args.projectPath)
  const structural = loadStructural(args.projectId)
  const memoryStyle = loadMemoryStyle(args.projectId)

  const snapshot = buildProjectStyleSnapshot({
    stats: args.stats,
    stack: args.stack,
    commands: args.commands,
    packageDeps: packageMeta.deps,
    packageManager: packageMeta.packageManager,
    llmAnalysis: llm,
    memoryPatterns: memoryStyle.patterns,
    memoryAntiPatterns: memoryStyle.antiPatterns,
    memoryConventions: memoryStyle.conventions,
    structural,
    commitHash: args.commitHash ?? null,
    source: args.source ?? 'sync-mechanical',
  })

  // Attach styleCoverage metric for future measurement
  snapshot.payload.metrics.styleCoverage = computeStyleCoverage(snapshot)
  snapshot.payload.metrics.hasRichAnalysis = isRichLlmAnalysis(llm) ? 1 : 0

  const delta = generateProjectStyleDiff(previous, snapshot)
  const isFirst = previous === null

  // Only persist a new history row when something changed OR first capture
  if (isFirst || delta.hasChanges) {
    persistProjectStyleSnapshot(args.projectId, snapshot)
  } else {
    // Touch active payload metrics / summary without exploding history:
    // re-write the same active id's payload when only timestamps would differ.
    // For identical content, keep previous row (stable evolution series).
  }

  const active = getActiveProjectStyle(args.projectId) ?? snapshot

  if (args.bridgeMemory !== false) {
    await bridgeStyleToMemory(args.projectPath, args.projectId, active).catch(() => {
      /* best-effort */
    })
  }

  await writeRepoAnalysisArtifact(args.projectId, active).catch(() => {
    /* best-effort */
  })

  return { snapshot: active, delta, isFirst }
}

function computeStyleCoverage(s: ProjectStyleSnapshot): number {
  // 0–100: stack known + patterns/conventions density
  let score = 0
  if (s.payload.stack.ecosystem !== 'unknown') score += 25
  if (s.payload.stack.frameworks.length > 0 || s.payload.stack.keyLibraries.length > 0) score += 20
  if (s.payload.stack.hasTests) score += 10
  if (s.conventionCount > 0) score += Math.min(25, s.conventionCount * 5)
  if (s.patternCount > 0) score += Math.min(15, s.patternCount * 3)
  if (s.antiPatternCount > 0) score += Math.min(5, s.antiPatternCount)
  return Math.min(100, score)
}

/** Prefer active rich LLM analysis; fall back to most recent rich superseded. */
function pickBestAnalysis(projectId: string): LLMAnalysis | null {
  try {
    const active = llmAnalysisStorage.getActive(projectId)
    if (isRichLlmAnalysis(active)) return active

    try {
      const all = llmAnalysisStorage.getAllFull(projectId)
      for (const h of all) {
        if (isRichLlmAnalysis(h.analysis)) return h.analysis
      }
    } catch {
      /* fall through */
    }
    return active
  } catch {
    return null
  }
}

function loadStructural(projectId: string): {
  symbols: number
  files: number
  packages: string[]
} {
  try {
    const snap = buildArchitectureSnapshot(projectId)
    if (!snap.ready) return { symbols: 0, files: 0, packages: [] }
    return {
      symbols: snap.symbols,
      files: snap.files,
      packages: snap.packages.slice(0, 20),
    }
  } catch {
    return { symbols: 0, files: 0, packages: [] }
  }
}

function loadMemoryStyle(projectId: string): {
  patterns: Array<{ name: string; description: string }>
  antiPatterns: Array<{ issue: string; suggestion: string }>
  conventions: Array<{ rule: string; category?: string }>
} {
  const patterns: Array<{ name: string; description: string }> = []
  const antiPatterns: Array<{ issue: string; suggestion: string }> = []
  const conventions: Array<{ rule: string; category?: string }> = []
  try {
    const entries = projectMemory.recall(projectId, {
      types: ['pattern', 'anti-pattern', 'decision'],
      limit: 40,
    })
    for (const e of entries) {
      const topic = e.tags?.topic ?? ''
      if (!topic.startsWith('style:') && e.type !== 'pattern' && e.type !== 'anti-pattern') continue
      if (e.type === 'pattern' || topic.startsWith('style:pattern:')) {
        patterns.push({
          name: e.tags?.name || topic.replace(/^style:pattern:/, '') || 'pattern',
          description: e.content.slice(0, 400),
        })
      } else if (e.type === 'anti-pattern' || topic.startsWith('style:anti:')) {
        antiPatterns.push({
          issue: e.tags?.name || topic.replace(/^style:anti:/, '') || 'anti-pattern',
          suggestion: e.content.slice(0, 400),
        })
      } else if (topic.startsWith('style:convention:')) {
        conventions.push({ rule: e.content.slice(0, 400), category: e.tags?.category })
      }
    }
  } catch {
    /* empty */
  }
  return { patterns, antiPatterns, conventions }
}

async function readPackageMeta(projectPath: string): Promise<{
  deps: Record<string, string>
  packageManager: string | null
}> {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      packageManager?: string
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    let packageManager: string | null = null
    if (pkg.packageManager) {
      packageManager = pkg.packageManager.split('@')[0] ?? null
    } else {
      const locks: Array<[string, string]> = [
        ['bun.lockb', 'bun'],
        ['bun.lock', 'bun'],
        ['pnpm-lock.yaml', 'pnpm'],
        ['yarn.lock', 'yarn'],
        ['package-lock.json', 'npm'],
      ]
      for (const [file, pm] of locks) {
        try {
          await fs.access(path.join(projectPath, file))
          packageManager = pm
          break
        } catch {
          /* next */
        }
      }
    }
    return { deps, packageManager }
  } catch {
    return { deps: {}, packageManager: null }
  }
}

/**
 * UPSERT style memories so selective embeddings can recall house rules.
 * Uses tags.topic = style:<kind>:<key> for supersession.
 */
interface StyleBridgeEntry {
  type: 'decision' | 'pattern' | 'anti-pattern'
  content: string
  tags: Record<string, string>
}

function desiredStyleBridgeEntries(snapshot: ProjectStyleSnapshot): StyleBridgeEntry[] {
  const p = snapshot.payload
  const entries = [
    ...p.conventions.slice(0, 25).map((c) => ({
      type: 'decision' as const,
      content: c.rule,
      tags: {
        topic: `style:convention:${c.key}`,
        category: c.category ?? 'convention',
        source: 'project-style',
      },
    })),
    ...p.patterns.slice(0, 25).map((pat) => ({
      type: 'pattern' as const,
      content: `${pat.name}: ${pat.description}`,
      tags: {
        topic: `style:pattern:${pat.key}`,
        name: pat.name,
        source: 'project-style',
        ...(pat.category ? { category: pat.category } : {}),
      },
    })),
    ...p.antiPatterns.slice(0, 25).map((a) => ({
      type: 'anti-pattern' as const,
      content: `${a.issue}. Suggestion: ${a.suggestion}`,
      tags: {
        topic: `style:anti:${a.key}`,
        name: a.issue,
        source: 'project-style',
        ...(a.severity ? { severity: a.severity } : {}),
      },
    })),
  ]

  // memory_entries intentionally deduplicates the same (type, content) across
  // a project. Mirror that identity here so two style keys with identical
  // knowledge do not keep reassigning the single stored row's topic_key on
  // every sync. First occurrence wins, preserving the existing deterministic
  // convention -> pattern -> anti-pattern order.
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const identity = `${entry.type}\0${memoryFingerprint(entry.content)}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

function styleBridgeIdentity(type: string, topic: string, contentHash: string): string {
  return `${type}\0${topic}\0${contentHash}`
}

export async function bridgeStyleToMemory(
  projectPath: string,
  projectId: string,
  snapshot: ProjectStyleSnapshot
): Promise<number> {
  const desired = desiredStyleBridgeEntries(snapshot)
  if (desired.length === 0) return 0

  let activeIdentities: Set<string> | null = null
  try {
    const topics = [...new Set(desired.map((entry) => entry.tags.topic!))]
    const placeholders = topics.map(() => '?').join(',')
    const rows = prjctDb.query<{
      type: string
      topic_key: string
      content_hash: string
    }>(
      projectId,
      `SELECT type, topic_key, content_hash
       FROM memory_entries
       WHERE project_id = ? AND deleted_at IS NULL
         AND topic_key IN (${placeholders})`,
      projectId,
      ...topics
    )
    activeIdentities = new Set(
      rows.map((row) => styleBridgeIdentity(row.type, row.topic_key, row.content_hash))
    )
  } catch {
    // A preflight miss is cheaper than dropping style self-heal.
    activeIdentities = null
  }

  let attempted = 0
  for (const entry of desired) {
    const topic = entry.tags.topic!
    const identity = styleBridgeIdentity(entry.type, topic, memoryFingerprint(entry.content))
    if (activeIdentities?.has(identity)) continue
    await projectMemory.remember(projectPath, {
      ...entry,
      projectId,
      provenance: 'extracted',
    })
    attempted++
  }
  return attempted
}

/** Write analysis/repo-analysis.json so legacy context readers work. */
async function writeRepoAnalysisArtifact(
  projectId: string,
  snapshot: ProjectStyleSnapshot
): Promise<void> {
  const { default: pathManager } = await import('../infrastructure/path-manager')
  const globalPath = pathManager.getGlobalProjectPath(projectId)
  const dir = path.join(globalPath, 'analysis')
  await fs.mkdir(dir, { recursive: true })
  const stack = snapshot.payload.stack
  const body = {
    ecosystem: stack.ecosystem,
    frameworks: stack.frameworks,
    hasTests: stack.hasTests,
    technologies: [...stack.languages, ...stack.frameworks, ...stack.keyLibraries].filter(
      (v, i, arr) => arr.indexOf(v) === i
    ),
    packageManager: stack.packageManager ?? null,
    updatedAt: snapshot.capturedAt,
    styleSummary: snapshot.summary,
  }
  await fs.writeFile(path.join(dir, 'repo-analysis.json'), JSON.stringify(body, null, 2), 'utf-8')
}

export function formatProjectStyleForSync(result: ProjectStyleRecomputeResult): {
  evolutionMd: string | null
  digestMd: string | null
  delta: ProjectStyleDiff
} {
  const evolutionMd =
    result.delta.hasChanges || result.isFirst ? formatProjectStyleDiffMd(result.delta) : null
  const digestMd = formatProjectStyleDigest(result.snapshot, {
    maxConventions: 4,
    maxPatterns: 3,
    maxAnti: 2,
  })
  return { evolutionMd, digestMd, delta: result.delta }
}
