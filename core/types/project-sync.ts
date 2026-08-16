/**
 * Project Sync Types
 *
 * Shared types for sync-service and context-generator.
 * Single source of truth for GitData, ProjectStats, ProjectCommands.
 */

import type { WorkCostSnapshot } from '../services/work-cost-service'
import type { SyncDiff } from './diff'
import type { StackDetection } from './stack'
import type { VerificationReport } from './sync-verifier'

// Git & Project Data

export interface GitData {
  branch: string
  commits: number
  contributors: number
  hasChanges: boolean
  stagedFiles: string[]
  modifiedFiles: string[]
  untrackedFiles: string[]
  recentCommits: { hash: string; message: string; date: string }[]
  weeklyCommits: number
}

export interface ProjectStats {
  fileCount: number
  version: string
  name: string
  ecosystem: string
  projectType: string
  languages: string[]
  frameworks: string[]
}

/** Project command strings (install, dev, test, etc.). Distinct from Command/CommandResult. */
export interface ProjectCommands {
  install: string
  run?: string
  test: string
  build: string
  dev: string
  lint: string
  format: string
}

// Sync Metrics & Options

export interface SyncMetrics {
  duration: number
  /** Real total tokens from BM25 index (actual project source tokens) */
  originalSize: number
  /** Tokens in agent context files loaded into AI conversation */
  filteredSize: number
  /** Compression ratio: (original - filtered) / original */
  compressionRate: number
  /** Index statistics from BM25, import graph, co-change */
  indexes?: {
    /** BM25: total files indexed */
    bm25Files?: number
    /** BM25: average tokens per file */
    bm25AvgTokens?: number
    /** BM25: vocabulary size (unique terms) */
    bm25VocabSize?: number
    /** Import graph: total import edges */
    importEdges?: number
    /** Import graph: files in graph */
    importFiles?: number
    /** Co-change: commits analyzed */
    cochangeCommits?: number
    /** Co-change: files with change history */
    cochangeFiles?: number
  }
}

export interface SyncOptions {
  preview?: boolean
  skipConfirmation?: boolean
  packagePath?: string
  packageName?: string
  /** Force full re-analysis, bypassing incremental cache */
  full?: boolean
  /** Pre-computed list of changed files (from watch service) */
  changedFiles?: string[]
}

export interface SyncContext7Status {
  installed: boolean
  verified: boolean
  message?: string
}

export interface SyncAnalysisSummary {
  patterns: number
  antiPatterns: number
  criticalAntiPatterns: number
}

export interface ContextQualitySummary {
  score: number
  threshold: number
  passed: boolean
  iterations: number
  livingContextCount: number
  legacyContextCount: number
  irrelevantRemoved: number
  repairEntriesCreated: number
  issues: string[]
}

/** Retention phase summary (dry-run or applied). See core/services/retention. */
export interface RetentionDryRunSummary {
  evaluated: number
  active: number
  archive: number
  delete: number
  /** Actions actually performed this pass (0 when dry-run). */
  archived?: number
  deleted?: number
  inboxMerged?: number
  inboxArchived?: number
  dryRun?: boolean
  /** Worst-scored flagged entries, capped for the sync report. */
  samples: Array<{
    id: string
    type: string
    verdict: string
    score: number
    reasons: string[]
    excess?: number
  }>
  referenceSize?: number
  /** Cold purge + vault inventory (sync maintenance). */
  vault?: {
    live: number
    softDeleted: number
    archives: number
    rememberEvents: number
    autoSourceLive: number
    softDeletedPurged?: number
    orphanEventsPurged?: number
    archivesPruned?: number
    autoSourceTrimmed?: number
    distilledDiscarded?: number
    digestsWritten?: number
  }
}

// Sync Result & Context Generator Config

export interface IncrementalInfo {
  /** Whether this was an incremental sync (vs full) */
  isIncremental: boolean
  /** Number of files that changed */
  filesChanged: number
  /** Number of files unchanged (skipped) */
  filesUnchanged: number
  /** Whether indexes were rebuilt */
  indexesRebuilt: boolean
  /** Domains affected by changes */
  affectedDomains: string[]
}

export interface ProjectStyleSyncSummary {
  /** One-line digest of current project style */
  summary: string
  /** Markdown delta section for this sync (null when unchanged) */
  evolutionMd: string | null
  patternCount: number
  antiPatternCount: number
  conventionCount: number
  styleCoverage: number
  isFirst: boolean
  hasChanges: boolean
}

export interface ProjectSyncResult {
  success: boolean
  projectId: string
  cliVersion: string
  git: GitData
  stats: ProjectStats
  commands: ProjectCommands
  stack: StackDetection
  context7?: SyncContext7Status
  analysisSummary?: SyncAnalysisSummary
  contextQuality?: ContextQualitySummary
  retentionDryRun?: RetentionDryRunSummary
  syncMetrics?: SyncMetrics
  workCost?: WorkCostSnapshot[]
  verification?: VerificationReport
  incremental?: IncrementalInfo
  /** Dual evolution: project style recompute on this sync */
  projectStyle?: ProjectStyleSyncSummary
  /** True when a new weekly developer snapshot was captured this sync */
  developerSnapshotCaptured?: boolean
  generatedSkills?: {
    generated: { name: string; path: string }[]
    skipped: { name: string; reason: string }[]
  }
  error?: string
  isPreview?: boolean
  previewDiff?: SyncDiff
  /** Per-phase wall-clock timing, slowest first, for `--md`/verbose diagnosis. */
  phaseTimings?: { phase: string; ms: number }[]
}

export interface ContextGeneratorConfig {
  projectId: string
  projectPath: string
  globalPath: string
}
