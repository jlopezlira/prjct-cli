/**
 * Historical token backfill: reconstruct per-task token usage from the Claude
 * Code transcripts still on disk (~/.claude/projects/<sanitized-path>/*.jsonl).
 *
 * Every transcript line carries a timestamp, model id and usage block, and
 * every completed task carries its [started_at, completed_at] window — so the
 * attribution that the (previously broken) live path never captured is fully
 * recoverable: sum usage lines inside each task's window, per model.
 *
 * Idempotent: writes go through recordTaskTokenUsage, whose token_usage rows
 * upsert by event_key (task + source) with latest-total-wins semantics.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserHome } from '../infrastructure/user-home'
import { prjctDb } from '../storage/database'
import {
  parseTranscriptJsonl,
  sumTranscriptUsage,
  sumTranscriptUsageByModel,
  type TranscriptJsonlLine,
} from './transcript-jsonl'
import { recordTaskTokenUsage } from './work-cost-service'

export interface BackfillResult {
  transcriptsScanned: number
  tasksBackfilled: number
  tokensRecovered: number
  tasksSkipped: number
}

/** Claude Code stores transcripts under a path-derived directory name. */
function transcriptDirFor(projectPath: string): string {
  const sanitized = projectPath.replace(/[/.]/g, '-')
  return path.join(resolveUserHome(), '.claude', 'projects', sanitized)
}

export async function backfillTaskTokens(
  projectId: string,
  projectPath: string
): Promise<BackfillResult> {
  const result: BackfillResult = {
    transcriptsScanned: 0,
    tasksBackfilled: 0,
    tokensRecovered: 0,
    tasksSkipped: 0,
  }

  // Completed cycles with a real window and no measured tokens yet.
  const tasks = prjctDb.query<{ id: string; started_at: string; completed_at: string }>(
    projectId,
    `SELECT id, started_at, COALESCE(completed_at, shipped_at) AS completed_at
     FROM tasks
     WHERE status IN ('completed', 'shipped')
       AND started_at IS NOT NULL
       AND COALESCE(completed_at, shipped_at) IS NOT NULL
       AND COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) = 0`
  )
  if (tasks.length === 0) return result

  const dir = transcriptDirFor(projectPath)
  const files = await fs
    .readdir(dir)
    .then((entries) => entries.filter((file) => file.endsWith('.jsonl')))
    .catch(() => null)
  if (!files) return result

  // Load all transcripts once (they are line-independent, so concatenating
  // across sessions is safe: the window filter does the attribution).
  const allLines: TranscriptJsonlLine[] = []
  for (const f2 of files) {
    try {
      const raw = await fs.readFile(path.join(dir, f2), 'utf-8')
      allLines.push(...parseTranscriptJsonl(raw))
      result.transcriptsScanned++
    } catch {
      /* unreadable transcript — skip */
    }
  }
  if (allLines.length === 0) return result

  for (const task of tasks) {
    const window = {
      sinceIso: task.started_at,
      untilIso: task.completed_at,
    }
    const usage = sumTranscriptUsage(allLines, window)
    if (usage.tokensIn + usage.tokensOut <= 0) {
      result.tasksSkipped++
      continue
    }
    recordTaskTokenUsage(projectId, task.id, usage.tokensIn, usage.tokensOut, {
      agent: 'claude',
      source: 'claude-transcript',
      // Reconstructed from windowed sums across archived transcripts — exact
      // provider counts, but attribution is time-window inference.
      isEstimated: true,
    })
    for (const [model, u] of sumTranscriptUsageByModel(allLines, window)) {
      if (u.tokensIn + u.tokensOut <= 0) continue
      recordTaskTokenUsage(projectId, task.id, u.tokensIn, u.tokensOut, {
        model,
        agent: 'claude',
        source: `claude-transcript:${model}`,
        isEstimated: true,
      })
    }
    result.tasksBackfilled++
    result.tokensRecovered += usage.tokensIn + usage.tokensOut
  }
  return result
}
