/**
 * Sync-time persistence helpers — write-side operations triggered by
 * the main `SyncService.sync()` flow. Extracted so the orchestrator
 * file stays under 500 LOC.
 *
 *   - `recordSyncMetrics`  — tokens-saved + index stats → metrics table
 *   - `saveDraftAnalysis`  — heuristic patterns + feedback → analysis table
 *   - `archiveStaleData`   — sweep old shipped/dormant/queue/paused/memory
 *
 * Each takes the orchestrator's state explicitly as args (projectId,
 * projectPath, etc.) — no `this`, no shared singleton state.
 */

import { loadIndex as loadBm25Index } from '../../domain/bm25'
import { loadMatrix as loadCoChangeMatrix } from '../../domain/git-cochange'
import { loadGraph as loadImportGraph } from '../../domain/import-graph'
import { analysisStorage } from '../../storage/analysis-storage'
import { archiveStorage } from '../../storage/archive-storage'
import { ideasStorage } from '../../storage/ideas-storage'
import { metricsStorage } from '../../storage/metrics-storage'
import { queueStorage } from '../../storage/queue-storage'
import { shippedStorage } from '../../storage/shipped-storage'
import { stateStorage } from '../../storage/state-storage'
import { getErrorMessage } from '../../types/fs'
import type { GitData, ProjectStats, SyncMetrics } from '../../types/project-sync'
import type { StackDetection } from '../../types/stack'
import * as dateHelper from '../../utils/date-helper'
import log from '../../utils/logger'
import { memoryService } from '../memory-service'
import patternExtractor from '../pattern-extractor'

const DEFAULT_TOKENS_PER_FILE = 200

export async function recordSyncMetrics(
  projectId: string,
  stats: ProjectStats,
  duration: number
): Promise<SyncMetrics & { developerSnapshotCaptured?: boolean }> {
  // Real original size from BM25 index (actual tokens indexed from source files).
  // Loaded ONCE and reused by the index-stats block below — the second load
  // used to hit right after the sync invalidated the cache, paying a full
  // corpus deserialize twice per sync.
  const { bm25Index, originalSize } = (() => {
    try {
      const index = loadBm25Index(projectId)
      const measured = index
        ? Object.values(index.documents).reduce((total, doc) => total + doc.length, 0)
        : 0
      return {
        bm25Index: index,
        originalSize: measured || stats.fileCount * DEFAULT_TOKENS_PER_FILE,
      }
    } catch (error) {
      log.debug('Could not load BM25 index for metrics', { error: getErrorMessage(error) })
      return { bm25Index: null, originalSize: stats.fileCount * DEFAULT_TOKENS_PER_FILE }
    }
  })()

  // Skills are loaded natively by Claude Code — no agent files to measure.
  const filteredSize = 0
  const compressionRate =
    originalSize > 0 ? Math.max(0, (originalSize - filteredSize) / originalSize) : 0

  try {
    await metricsStorage.recordSync(projectId, {
      originalSize,
      filteredSize,
      duration,
      isWatch: false,
    })
  } catch (error) {
    log.debug('Failed to record sync metrics', { error: getErrorMessage(error) })
  }

  // Delivery velocity (weekly sprints from tasks+ships) and the weekly
  // developer-evolution snapshot. Both typed, both idempotent, both
  // best-effort — a failure never degrades the sync itself.
  // Isolated try/catch per rollup: a failure in one must not silently skip
  // the others (a shared block once let a single bad timestamp starve BOTH
  // velocity and the weekly snapshot on every sync).
  try {
    const { velocityStorage } = await import('../../storage/velocity-storage')
    await velocityStorage.recompute(projectId)
  } catch (error) {
    log.debug('Failed to recompute velocity', { error: getErrorMessage(error) })
  }
  const developerSnapshotCaptured = await import('../developer-evolution')
    .then(({ captureDeveloperSnapshot }) => captureDeveloperSnapshot(projectId))
    .catch((error) => {
      log.debug('Failed to capture dev snapshot', { error: getErrorMessage(error) })
      return false
    })

  const indexes: NonNullable<SyncMetrics['indexes']> = {}
  try {
    const bm25 = bm25Index
    if (bm25) {
      indexes.bm25Files = bm25.totalDocs
      indexes.bm25AvgTokens = Math.round(bm25.avgDocLength)
      indexes.bm25VocabSize = Object.keys(bm25.invertedIndex).length
    }
    const graph = loadImportGraph(projectId)
    if (graph) {
      indexes.importEdges = graph.edgeCount
      indexes.importFiles = graph.fileCount
    }
    const cochange = loadCoChangeMatrix(projectId)
    if (cochange) {
      indexes.cochangeCommits = cochange.commitsAnalyzed
      indexes.cochangeFiles = cochange.filesAnalyzed
    }
  } catch (error) {
    log.debug('Could not load index stats', { error: getErrorMessage(error) })
  }

  return {
    duration,
    originalSize,
    filteredSize,
    compressionRate,
    indexes,
    developerSnapshotCaptured,
  }
}

/**
 * Save sync results as a draft analysis. Preserves existing sealed
 * analysis — only the draft is overwritten. Incorporates task
 * feedback from completed tasks (PRJ-272).
 */
export async function saveDraftAnalysis(
  projectId: string,
  projectPath: string,
  git: GitData,
  stats: ProjectStats,
  stack: StackDetection,
  context7Verified: boolean
): Promise<void> {
  try {
    const commitHash = git.recentCommits[0]?.hash || null

    type CodePattern = {
      name: string
      description: string
      location?: string
      severity?: 'low' | 'medium' | 'high'
      language?: string
      framework?: string
      source?: 'baseline' | 'repo' | 'context7' | 'feedback'
      confidence?: number
    }
    type AntiPattern = {
      issue: string
      file: string
      suggestion: string
      severity?: 'low' | 'medium' | 'high'
      language?: string
      framework?: string
      source?: 'baseline' | 'repo' | 'context7' | 'feedback'
      confidence?: number
    }

    const feedback: { patternsDiscovered: string[]; knownGotchas: string[] } | undefined =
      await stateStorage.getAggregatedFeedback(projectId).catch(() => undefined)

    // Refresh the skill index alongside analysis — both need projectPath and
    // both are per-sync catalog rebuilds (best-effort; never blocks the sync).
    try {
      const { refreshSkillIndex } = await import('../skill-index')
      await refreshSkillIndex(projectId, projectPath)
    } catch {
      /* index refresh is best-effort */
    }

    const extracted = await patternExtractor.extract({
      projectId,
      projectPath,
      languages: stats.languages,
      frameworks: Array.from(new Set([...stats.frameworks, ...stack.frameworks])),
      feedback,
      context7Verified,
    })

    await analysisStorage.saveDraft(projectId, {
      projectId,
      languages: stats.languages,
      frameworks: stats.frameworks,
      configFiles: [],
      fileCount: stats.fileCount,
      patterns: extracted.patterns as CodePattern[],
      antiPatterns: extracted.antiPatterns as AntiPattern[],
      analyzedAt: dateHelper.getTimestamp(),
      status: 'draft',
      commitHash: commitHash ?? undefined,
    })
  } catch (error) {
    log.debug('Failed to save draft analysis (non-critical)', {
      error: getErrorMessage(error),
    })
  }
}

/**
 * Sweep old shipped/dormant/queue/paused records during sync to keep
 * active storage lean. Each sub-archive is best-effort.
 */
export async function archiveStaleData(projectId: string): Promise<void> {
  try {
    const [shipped, dormant, staleQueue, stalePaused, memoryCapped] = await Promise.all([
      shippedStorage.archiveOldShipped(projectId).catch(() => 0),
      ideasStorage.markDormantIdeas(projectId).catch(() => 0),
      queueStorage.removeStaleCompleted(projectId).catch(() => 0),
      stateStorage.archiveStalePausedTasks(projectId).catch(() => []),
      memoryService.capEntries(projectId).catch(() => 0),
    ])

    const totalArchived =
      shipped + dormant + staleQueue + (stalePaused as unknown[]).length + memoryCapped

    if (totalArchived > 0) {
      log.info('Archived stale data', {
        shipped,
        dormant,
        staleQueue,
        stalePaused: (stalePaused as unknown[]).length,
        memoryCapped,
        total: totalArchived,
      })
      const stats = archiveStorage.getStats(projectId)
      log.debug('Archive stats', stats)
    }
  } catch (error) {
    log.debug('Archival failed (non-critical)', { error: getErrorMessage(error) })
  }
}
