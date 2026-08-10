/**
 * LLM Analysis Storage
 *
 * CRUD for structured LLM findings in SQLite.
 * Stores full LLMAnalysis JSON in the `llm_analysis` table.
 *
 * Lifecycle:
 * - New analysis supersedes the previous active one
 * - Only the latest active analysis is used for task context
 * - Old analyses are kept for history (status = 'superseded')
 */

import type { LLMAnalysis } from '../types/llm-analysis'
import { getTimestamp } from '../utils/date-helper'
import { prjctDb } from './database'
import type { SqliteDatabase } from './database/sqlite-compat'

/**
 * Schema v2 (C3): explode an LLMAnalysis into the normalized child tables so
 * the synthesis is queryable as relational records, not a JSON blob. Called
 * inside save()'s transaction. analysisId is the llm_analysis row id.
 */
function writeAnalysisChildren(db: SqliteDatabase, analysisId: string, a: LLMAnalysis): void {
  const finding = db.prepare(
    'INSERT INTO analysis_finding (id, analysis_id, kind, title, detail, severity, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const findingIds: string[] = []
  const addFinding = (
    kind: string,
    title: string,
    detail: string | null,
    severity: string | null
  ) => {
    if (!title) return
    const sortOrder = findingIds.length
    const findingId = `${analysisId}-f${sortOrder}`
    finding.run(findingId, analysisId, kind, title, detail, severity, sortOrder)
    findingIds.push(findingId)
  }
  for (const p of a.patterns ?? []) addFinding('pattern', p.name, p.description, null)
  for (const ap of a.antiPatterns ?? [])
    addFinding('anti_pattern', ap.issue, ap.suggestion, ap.severity)
  for (const d of a.techDebt ?? [])
    addFinding('tech_debt', d.description, `${d.area}: ${d.impact}`, d.priority)
  for (const r of a.riskAreas ?? [])
    addFinding('risk_area', r.path, `${r.reason} — ${r.risk}`, r.severity)
  for (const rf of a.refactorSuggestions ?? [])
    addFinding('refactor', rf.description, rf.benefit, null)
  for (const ins of a.projectInsights ?? []) addFinding('insight', ins, null, null)
  for (const ins2 of a.architecture?.insights ?? []) addFinding('insight', ins2, null, null)

  const conv = db.prepare(
    'INSERT INTO analysis_convention (id, analysis_id, rule, sort_order) VALUES (?, ?, ?, ?)'
  )
  ;(a.conventions ?? []).forEach((c, idx) => {
    conv.run(`${analysisId}-c${idx}`, analysisId, c.rule, idx)
  })

  const stack = db.prepare(
    'INSERT INTO analysis_stack_item (id, analysis_id, kind, name) VALUES (?, ?, ?, ?)'
  )
  const stackItems = [
    ...(a.stack?.languages ?? []).map((name) => ({ kind: 'language', name })),
    ...(a.stack?.frameworks ?? []).map((name) => ({ kind: 'framework', name })),
  ]
  stackItems.forEach((item, index) => {
    stack.run(`${analysisId}-s${index}`, analysisId, item.kind, item.name)
  })

  const cmd = db.prepare(
    'INSERT INTO analysis_command (id, analysis_id, name, command, purpose) VALUES (?, ?, ?, ?, ?)'
  )
  Object.entries(a.commands ?? {})
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .forEach(([name, command], index) => {
      cmd.run(`${analysisId}-cmd${index}`, analysisId, name, command, null)
    })

  const dom = db.prepare(
    'INSERT INTO analysis_domain (id, analysis_id, name, paths) VALUES (?, ?, ?, ?)'
  )
  ;(a.architecture?.domains ?? []).forEach((d, idx) => {
    dom.run(`${analysisId}-d${idx}`, analysisId, d, null)
  })
}

class LLMAnalysisStorage {
  /**
   * Save a new LLM analysis, superseding any previous active one.
   */
  save(projectId: string, analysis: LLMAnalysis): void {
    const db = prjctDb.getDb(projectId)
    const now = getTimestamp()

    db.transaction(() => {
      // Supersede previous active analysis
      db.prepare(
        "UPDATE llm_analysis SET status = 'superseded', superseded_at = ? WHERE status = 'active'"
      ).run(now)

      // Insert new active analysis (blob kept for the full-object consumers).
      const result = db
        .prepare(
          'INSERT INTO llm_analysis (commit_hash, status, analysis, analyzed_at) VALUES (?, ?, ?, ?)'
        )
        .run(analysis.commitHash ?? null, 'active', JSON.stringify(analysis), analysis.analyzedAt)

      // Schema v2 (C3): also store the synthesis as RELATIONAL records so it's
      // queryable field-by-field (and the archive is a WHERE, not a re-parse).
      writeAnalysisChildren(db, String(result.lastInsertRowid), analysis)
    })()
  }

  /**
   * Schema v2 (C3): read the active analysis as RELATIONAL records from the
   * child tables (no JSON blob parse). Returns null when there's no active
   * analysis OR it predates C3 (no child rows) — callers fall back to getActive.
   */
  getActiveRelational(projectId: string): {
    findings: Array<{ kind: string; title: string; detail: string | null }>
    conventions: string[]
    stack: Array<{ kind: string; name: string }>
    domains: string[]
    commands: Array<{ name: string; command: string }>
  } | null {
    const head = prjctDb.get<{ id: number }>(
      projectId,
      "SELECT id FROM llm_analysis WHERE status = 'active' LIMIT 1"
    )
    if (!head) return null
    const id = String(head.id)
    const findings = prjctDb.query<{ kind: string; title: string; detail: string | null }>(
      projectId,
      'SELECT kind, title, detail FROM analysis_finding WHERE analysis_id = ? ORDER BY kind, sort_order',
      id
    )
    const conventions = prjctDb
      .query<{ rule: string }>(
        projectId,
        'SELECT rule FROM analysis_convention WHERE analysis_id = ? ORDER BY sort_order',
        id
      )
      .map((r) => r.rule)
    const stack = prjctDb.query<{ kind: string; name: string }>(
      projectId,
      'SELECT kind, name FROM analysis_stack_item WHERE analysis_id = ?',
      id
    )
    const domains = prjctDb
      .query<{ name: string }>(
        projectId,
        'SELECT name FROM analysis_domain WHERE analysis_id = ?',
        id
      )
      .map((r) => r.name)
    const commands = prjctDb.query<{ name: string; command: string }>(
      projectId,
      'SELECT name, command FROM analysis_command WHERE analysis_id = ?',
      id
    )
    // No child rows ⇒ pre-C3 analysis; let the caller fall back to the blob.
    if (findings.length === 0 && conventions.length === 0 && stack.length === 0) return null
    return { findings, conventions, stack, domains, commands }
  }

  /**
   * Get the current active LLM analysis.
   * Returns null if no analysis exists.
   */
  getActive(projectId: string): LLMAnalysis | null {
    const row = prjctDb.get<{ analysis: string }>(
      projectId,
      "SELECT analysis FROM llm_analysis WHERE status = 'active' LIMIT 1"
    )
    if (!row) return null
    return JSON.parse(row.analysis) as LLMAnalysis
  }

  /**
   * Get a summary of the active analysis (for delta comparison).
   */
  getActiveSummary(projectId: string): {
    commitHash: string | null
    architectureStyle: string
    patternCount: number
    antiPatternCount: number
    analyzedAt: string
  } | null {
    const analysis = this.getActive(projectId)
    if (!analysis) return null

    return {
      commitHash: analysis.commitHash,
      architectureStyle: analysis.architecture.style,
      patternCount: analysis.patterns.length,
      antiPatternCount: analysis.antiPatterns.length,
      analyzedAt: analysis.analyzedAt,
    }
  }

  /**
   * Check if analysis exists and is current (matches commit hash).
   */
  isCurrent(projectId: string, commitHash: string | null): boolean {
    if (!commitHash) return false
    const row = prjctDb.get<{ commit_hash: string }>(
      projectId,
      "SELECT commit_hash FROM llm_analysis WHERE status = 'active' LIMIT 1"
    )
    return row?.commit_hash === commitHash
  }

  /**
   * Get every analysis ever saved (active + superseded) with full body.
   * Used by the wiki generator to emit per-run archive files so the vault
   * preserves a trail across analyses instead of only showing the latest.
   */
  getAllFull(projectId: string): Array<{
    id: number
    status: string
    commitHash: string | null
    analyzedAt: string
    supersededAt: string | null
    analysis: LLMAnalysis
  }> {
    const rows = prjctDb.query<{
      id: number
      commit_hash: string | null
      status: string
      analyzed_at: string
      superseded_at: string | null
      analysis: string
    }>(
      projectId,
      'SELECT id, commit_hash, status, analyzed_at, superseded_at, analysis FROM llm_analysis ORDER BY id DESC'
    )
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      commitHash: row.commit_hash,
      analyzedAt: row.analyzed_at,
      supersededAt: row.superseded_at,
      analysis: JSON.parse(row.analysis) as LLMAnalysis,
    }))
  }

  /**
   * Get history of all analyses (for debugging/audit).
   */
  getHistory(
    projectId: string,
    limit = 10
  ): Array<{
    id: number
    commitHash: string | null
    status: string
    analyzedAt: string
    patternCount: number
  }> {
    const rows = prjctDb.query<{
      id: number
      commit_hash: string | null
      status: string
      analyzed_at: string
      analysis: string
    }>(
      projectId,
      'SELECT id, commit_hash, status, analyzed_at, analysis FROM llm_analysis ORDER BY id DESC LIMIT ?',
      limit
    )

    return rows.map((row) => {
      const analysis = JSON.parse(row.analysis) as LLMAnalysis
      return {
        id: row.id,
        commitHash: row.commit_hash,
        status: row.status,
        analyzedAt: row.analyzed_at,
        patternCount: analysis.patterns.length,
      }
    })
  }
}

const llmAnalysisStorage = new LLMAnalysisStorage()
export default llmAnalysisStorage
