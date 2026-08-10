/**
 * ProjectIndex - Persistent Project Scanner with Scoring
 *
 * Features:
 * - Full scan: Analyzes entire project, caches results
 * - Incremental update: Only re-scans changed files
 * - Relevance scoring: Prioritizes important files
 * - Pattern detection: Identifies project architecture
 *
 * Usage:
 * - sync-service calls fullScan() on first sync
 * - Subsequent syncs use incrementalUpdate() or cached index
 * - watch-service uses incrementalUpdate() for changed files
 *
 * Storage location: ~/.prjct-cli/projects/{projectId}/index/
 */

import path from 'node:path'
import { CONFIG_FILES } from '../constants/file-patterns'
import { CHARS_PER_TOKEN } from '../constants/token'
import { getDefaultIndex, INDEX_VERSION, indexStorage } from '../storage/index-storage'
import type {
  FileStats,
  IndexOptions,
  RelevantContext,
  ScanResult,
  ScoringContext,
} from '../types/services.js'
import type { LanguageStats, ProjectIndex, ScoredFile } from '../types/storage/extended'
import { getTimestamp } from '../utils/date-helper'
import { fileScorer, RELEVANCE_THRESHOLD } from './file-scorer'
import { detectPatterns, detectStack } from './project-index/analyzers'
import {
  analyzeDirectories,
  findConfigFiles,
  scanAllFiles,
  scanFiles,
} from './project-index/scanners'

class ProjectIndexer {
  constructor(
    private projectPath: string,
    private projectId: string
  ) {}

  // MAIN METHODS

  async fullScan(options: IndexOptions = {}): Promise<ScanResult> {
    const startTime = Date.now()
    const index = getDefaultIndex(this.projectPath)

    const allFiles = await scanAllFiles(this.projectPath, options)
    const filesArray = Array.from(allFiles.values())

    index.languages = buildLanguageStats(filesArray)
    index.configFiles = await findConfigFiles(this.projectPath, this.projectId)
    index.directories = await analyzeDirectories(this.projectPath)
    index.detectedStack = await detectStack(index.configFiles, this.projectPath)

    const context = buildScoringContext(allFiles)
    const scores = fileScorer.getRelevantFiles(context, RELEVANCE_THRESHOLD)

    index.relevantFiles = scores.map((s) => ({
      path: s.path,
      score: s.score,
      size: allFiles.get(s.path)?.size || 0,
      mtime: allFiles.get(s.path)?.mtime.toISOString() || '',
    }))

    index.patterns = detectPatterns(index)
    index.totalFiles = allFiles.size
    index.totalSize = filesArray.reduce((sum, f) => sum + f.size, 0)
    index.totalLines = filesArray.reduce((sum, f) => sum + (f.lines || 0), 0)
    index.scanDuration = Date.now() - startTime

    const now = getTimestamp()
    index.lastFullScan = now
    index.lastIncrementalUpdate = now

    await indexStorage.writeIndex(this.projectId, index)
    await this.saveChecksums(allFiles)
    await indexStorage.writeScores(this.projectId, index.relevantFiles)

    return {
      index,
      fromCache: false,
      changedFiles: allFiles.size,
      scanDuration: index.scanDuration,
    }
  }

  async incrementalUpdate(changedPaths?: string[]): Promise<ScanResult> {
    const startTime = Date.now()

    const index = await indexStorage.readIndex(this.projectId)
    if (!index) return this.fullScan()

    const filesToUpdate = await (async () => {
      if (changedPaths && changedPaths.length > 0) return changedPaths
      const changes = await this.detectFileChanges()
      if (changes.deleted.length > 0) {
        index.relevantFiles = index.relevantFiles.filter((f) => !changes.deleted.includes(f.path))
      }
      return [...changes.added, ...changes.modified]
    })()

    if (filesToUpdate.length === 0) {
      return {
        index,
        fromCache: true,
        changedFiles: 0,
        scanDuration: Date.now() - startTime,
      }
    }

    const updatedFiles = await scanFiles(this.projectPath, filesToUpdate)
    const existingFiles = loadExistingFileStats(index)
    for (const [p, stats] of updatedFiles) {
      existingFiles.set(p, stats)
    }

    const context = buildScoringContext(existingFiles)
    const scores = fileScorer.getRelevantFiles(context, RELEVANCE_THRESHOLD)

    index.relevantFiles = scores.map((s) => ({
      path: s.path,
      score: s.score,
      size: existingFiles.get(s.path)?.size || 0,
      mtime: existingFiles.get(s.path)?.mtime.toISOString() || '',
    }))

    index.lastIncrementalUpdate = getTimestamp()
    index.scanDuration = Date.now() - startTime

    await indexStorage.writeIndex(this.projectId, index)
    await indexStorage.writeScores(this.projectId, index.relevantFiles)

    return {
      index,
      fromCache: false,
      changedFiles: filesToUpdate.length,
      scanDuration: index.scanDuration,
    }
  }

  async loadOrScan(options: IndexOptions = {}): Promise<ScanResult> {
    if (options.forceFullScan) return this.fullScan(options)

    const index = await indexStorage.readIndex(this.projectId)
    if (index?.lastFullScan) {
      const age = await indexStorage.getIndexAge(this.projectId)
      if (age < 24) {
        return { index, fromCache: true, changedFiles: 0, scanDuration: 0 }
      }
    }

    return this.fullScan(options)
  }

  async getRelevantContext(maxTokens: number = 50000): Promise<RelevantContext> {
    const index = await indexStorage.readIndex(this.projectId)
    if (!index) {
      return { files: [], estimatedTokens: 0, originalTokens: 0, compressionRate: 0 }
    }

    const selection = index.relevantFiles.reduce(
      (state, file) => {
        if (state.full) return state
        const fileTokens = Math.ceil(file.size / CHARS_PER_TOKEN)
        if (state.estimatedTokens + fileTokens > maxTokens) {
          state.full = true
          return state
        }
        state.files.push(file)
        state.estimatedTokens += fileTokens
        return state
      },
      { files: [] as ScoredFile[], estimatedTokens: 0, full: false }
    )

    const { files: selectedFiles, estimatedTokens } = selection
    const originalTokens = Math.ceil(index.totalSize / CHARS_PER_TOKEN)
    const compressionRate =
      originalTokens > 0 ? (originalTokens - estimatedTokens) / originalTokens : 0

    return { files: selectedFiles, estimatedTokens, originalTokens, compressionRate }
  }

  // CHECKSUM TRACKING

  private async detectFileChanges(): Promise<{
    added: string[]
    modified: string[]
    deleted: string[]
  }> {
    const currentFiles = new Map<string, string>()
    const allFiles = await scanAllFiles(this.projectPath)

    for (const [filePath] of allFiles) {
      const fullPath = path.join(this.projectPath, filePath)
      currentFiles.set(filePath, await indexStorage.calculateChecksum(fullPath))
    }

    return indexStorage.detectChangedFiles(this.projectId, currentFiles)
  }

  private async saveChecksums(files: Map<string, FileStats>): Promise<void> {
    const checksums: Record<string, string> = {}
    for (const [filePath] of files) {
      const fullPath = path.join(this.projectPath, filePath)
      checksums[filePath] = await indexStorage.calculateChecksum(fullPath)
    }

    await indexStorage.writeChecksums(this.projectId, {
      version: INDEX_VERSION,
      lastUpdated: getTimestamp(),
      checksums,
    })
  }
}

// SCORING HELPERS

function buildLanguageStats(files: FileStats[]): Record<string, LanguageStats> {
  const stats: Record<string, LanguageStats> = {}

  for (const file of files) {
    const ext = path.extname(file.path)
    if (!ext) continue
    if (!stats[ext]) stats[ext] = { count: 0, totalLines: 0, totalSize: 0 }
    stats[ext].count++
    stats[ext].totalLines += file.lines || 0
    stats[ext].totalSize += file.size
  }

  return stats
}

function buildScoringContext(files: Map<string, FileStats>): ScoringContext {
  const configFiles = new Set<string>()
  for (const file of files.values()) {
    if (CONFIG_FILES.has(path.basename(file.path))) configFiles.add(file.path)
  }

  return {
    allFiles: files,
    configFiles,
    maxFileSize: Math.max(...Array.from(files.values()).map((f) => f.size)),
    maxRecentCommits: Math.max(0, ...[...files.values()].map((file) => file.recentCommits ?? 0)),
    now: new Date(),
  }
}

function loadExistingFileStats(index: ProjectIndex): Map<string, FileStats> {
  const files = new Map<string, FileStats>()
  for (const file of index.relevantFiles) {
    files.set(file.path, {
      path: file.path,
      size: file.size,
      mtime: new Date(file.mtime),
    })
  }
  return files
}

// FACTORY

export function createProjectIndexer(projectPath: string, projectId: string): ProjectIndexer {
  return new ProjectIndexer(projectPath, projectId)
}
