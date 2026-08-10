/**
 * Context Feedback Storage
 *
 * Records suggested vs actual files per task to improve future file suggestions.
 * Three-phase loop: Record (task start) → Collect (task done) → Boost (next task).
 */

import { prjctDb } from './database'

// Types

interface ContextFeedbackRow {
  id: number
  task_id: string
  keywords: string
  suggested_files: string
  actual_files: string | null
  precision: number | null
  recall: number | null
  created_at: string
  completed_at: string | null
}

// Context Feedback Storage

class ContextFeedbackStorage {
  /**
   * Record file suggestions at task start.
   */
  recordSuggestions(
    projectId: string,
    taskId: string,
    keywords: string[],
    suggestedFiles: string[]
  ): void {
    prjctDb.run(
      projectId,
      `INSERT INTO context_feedback (task_id, keywords, suggested_files, created_at)
       VALUES (?, ?, ?, ?)`,
      taskId,
      JSON.stringify(keywords),
      JSON.stringify(suggestedFiles),
      new Date().toISOString()
    )
  }

  /**
   * Complete feedback at task done with actual files used.
   * Calculates precision and recall.
   */
  completeFeedback(projectId: string, taskId: string, actualFiles: string[]): void {
    const row = prjctDb.get<ContextFeedbackRow>(
      projectId,
      'SELECT * FROM context_feedback WHERE task_id = ? ORDER BY id DESC LIMIT 1',
      taskId
    )
    if (!row) return

    const suggested = new Set<string>(JSON.parse(row.suggested_files))
    const actual = new Set<string>(actualFiles)

    // Precision: what fraction of suggested files were actually used
    const truePositives = [...suggested].filter((f) => actual.has(f)).length
    const precision = suggested.size > 0 ? truePositives / suggested.size : 0

    // Recall: what fraction of actual files were suggested
    const recall = actual.size > 0 ? truePositives / actual.size : 0

    prjctDb.run(
      projectId,
      `UPDATE context_feedback
       SET actual_files = ?, precision = ?, recall = ?, completed_at = ?
       WHERE id = ?`,
      JSON.stringify(actualFiles),
      precision,
      recall,
      new Date().toISOString(),
      row.id
    )
  }

  /**
   * Get the most recent feedback row for a task (to read precision/recall after completeFeedback).
   */
  getFeedback(
    projectId: string,
    taskId: string
  ): { precision: number | null; recall: number | null } | null {
    const row = prjctDb.get<ContextFeedbackRow>(
      projectId,
      'SELECT precision, recall FROM context_feedback WHERE task_id = ? ORDER BY id DESC LIMIT 1',
      taskId
    )
    return row ? { precision: row.precision, recall: row.recall } : null
  }

  /**
   * Get historical boost scores for file suggestions.
   *
   * Analyzes last 50 completed feedback records, weights by keyword overlap
   * (Jaccard similarity), and returns boost scores in [-1, 1] range.
   *
   * Files in actual_files get positive signal; files suggested but not used
   * get negative signal.
   */
  getHistoricalBoosts(projectId: string, keywords: string[]): Map<string, number> {
    const boosts = new Map<string, number>()

    if (keywords.length === 0) return boosts

    const rows = prjctDb.query<ContextFeedbackRow>(
      projectId,
      `SELECT * FROM context_feedback
       WHERE actual_files IS NOT NULL
       ORDER BY id DESC LIMIT 50`
    )

    if (rows.length === 0) return boosts

    const inputSet = new Set(keywords)
    const rawScores = new Map<string, number>()

    for (const row of rows) {
      const rowKeywords = JSON.parse(row.keywords) as string[]
      const rowKeywordSet = new Set(rowKeywords)

      // Jaccard similarity between input keywords and row keywords
      const intersection = [...inputSet].filter((k) => rowKeywordSet.has(k)).length
      const union = new Set([...inputSet, ...rowKeywordSet]).size
      const overlap = union > 0 ? intersection / union : 0

      if (overlap === 0) continue

      const suggested = new Set<string>(JSON.parse(row.suggested_files))
      const actual = new Set<string>(JSON.parse(row.actual_files!))

      // Positive signal for files that were actually used
      for (const file of actual) {
        const current = rawScores.get(file) ?? 0
        rawScores.set(file, current + overlap)
      }

      // Negative signal for false positives (suggested but not used)
      for (const file2 of suggested) {
        if (!actual.has(file2)) {
          const current = rawScores.get(file2) ?? 0
          rawScores.set(file2, current - overlap * 0.5)
        }
      }
    }

    if (rawScores.size === 0) return boosts

    // Normalize to [-1, 1]
    const maxAbs = Math.max(...[...rawScores.values()].map(Math.abs), 1)
    for (const [file, score] of rawScores) {
      boosts.set(file, score / maxAbs)
    }

    return boosts
  }
}

// Singleton Export

export const contextFeedbackStorage = new ContextFeedbackStorage()
export { ContextFeedbackStorage }
