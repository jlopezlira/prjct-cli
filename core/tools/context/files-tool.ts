/**
 * Files Tool - Find relevant files for a task
 *
 * Scoring algorithm:
 * - 60% Keywords in path/filename
 * - 20% Domain patterns (frontend/backend/etc)
 * - 15% Git recency (recently modified files)
 * - 5% Import distance (proximity to entry points)
 *
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { FilesToolOutput, ScoredFile, ScoreReason } from '../../types/context-tools'
import { getErrorMessage, isNotFoundError } from '../../types/fs'
import { execAsync } from '../../utils/exec'
import log from '../../utils/logger'
import { CODE_EXTENSIONS, DOMAIN_KEYWORDS, IGNORE_DIRS, STOP_WORDS } from './files-tool/constants'

/**
 * Find files relevant to a task description
 */
export async function findRelevantFiles(
  taskDescription: string,
  projectPath: string,
  options: {
    maxFiles?: number
    minScore?: number
    includeTests?: boolean
    historicalBoosts?: Map<string, number>
  } = {}
): Promise<FilesToolOutput> {
  const startTime = Date.now()
  const maxFiles = options.maxFiles ?? 30
  const minScore = options.minScore ?? 0.1
  const includeTests = options.includeTests ?? false

  const keywords = extractKeywords(taskDescription)
  const allFiles = await getAllCodeFiles(projectPath)
  const gitRecency = await getGitRecency(projectPath)

  const scoredFiles: ScoredFile[] = []
  for (const filePath of allFiles) {
    if (!includeTests && isTestFile(filePath)) continue

    const score = scoreFile(filePath, keywords, gitRecency, options.historicalBoosts)
    if (score.score >= minScore) scoredFiles.push(score)
  }

  scoredFiles.sort((a, b) => b.score - a.score)
  const topFiles = scoredFiles.slice(0, maxFiles)

  return {
    files: topFiles,
    metrics: {
      filesScanned: allFiles.length,
      filesReturned: topFiles.length,
      scanDuration: Date.now() - startTime,
    },
  }
}

function extractKeywords(description: string): string[] {
  const words = description
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  return words.filter((w) => !STOP_WORDS.has(w) && w.length > 2)
}

async function getAllCodeFiles(projectPath: string): Promise<string[]> {
  const files: string[] = []

  async function walk(dir: string, relativePath: string = ''): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        const relPath = path.join(relativePath, entry.name)

        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
          await walk(fullPath, relPath)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (CODE_EXTENSIONS.has(ext)) files.push(relPath)
        }
      }
    } catch (error) {
      // Missing dir is expected (race with deletion); anything else (EACCES on
      // a symlinked dir, etc.) is worth a debug line so "scan found 0 files" is
      // diagnosable — but never fatal, the walk continues on siblings.
      if (!isNotFoundError(error)) {
        log.debug(`files-tool: skipped unreadable path during walk: ${getErrorMessage(error)}`)
      }
    }
  }

  await walk(projectPath)
  return files
}

async function getGitRecency(
  projectPath: string
): Promise<Map<string, { commits: number; daysAgo: number }>> {
  const recency = new Map<string, { commits: number; daysAgo: number }>()

  try {
    const { stdout } = await execAsync(
      `git log -30 --pretty=format:"%H %ct" --name-only | awk '
        /^[a-f0-9]{40}/ { commit=$1; timestamp=$2; next }
        NF { files[$0]++; if (!lastmod[$0]) lastmod[$0]=timestamp }
        END { for (const f in files) print files[f], lastmod[f], f }
      '`,
      { cwd: projectPath, maxBuffer: 10 * 1024 * 1024 }
    )

    const now = Math.floor(Date.now() / 1000)
    const lines = stdout.trim().split('\n').filter(Boolean)

    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (match) {
        const commits = parseInt(match[1], 10)
        const timestamp = parseInt(match[2], 10)
        const file = match[3]
        const daysAgo = Math.floor((now - timestamp) / 86400)
        recency.set(file, { commits, daysAgo })
      }
    }
  } catch {
    // Git not available or not a git repo
  }

  return recency
}

function scoreFile(
  filePath: string,
  keywords: string[],
  gitRecency: Map<string, { commits: number; daysAgo: number }>,
  historicalBoosts?: Map<string, number>
): ScoredFile {
  const reasons: ScoreReason[] = []

  const pathLower = filePath.toLowerCase()
  const pathParts = pathLower
    .split('/')
    .join(' ')
    .split(/[^a-z0-9]+/)

  // Keyword matching (60% weight)
  const keywordScore = Math.min(
    1,
    keywords.reduce((score, keyword) => {
      const direct = pathLower.includes(keyword)
      if (direct) reasons.push(`keyword:${keyword}`)
      const partial = pathParts.some((part) => part.includes(keyword) || keyword.includes(part))
      return score + (direct ? 0.3 : 0) + (partial ? 0.15 : 0)
    }, 0)
  )

  // Domain matching (20% weight)
  const domainScore = Math.min(
    1,
    Object.entries(DOMAIN_KEYWORDS).reduce((score, [domain, domainKeywords]) => {
      const pathMatches = domainKeywords.some((keyword) => pathLower.includes(keyword))
      const taskMatches = keywords.some(
        (keyword) =>
          domainKeywords.includes(keyword) || keyword.includes(domain) || domain.includes(keyword)
      )
      if (pathMatches && taskMatches) reasons.push(`domain:${domain}`)
      return score + (pathMatches && taskMatches ? 0.4 : 0)
    }, 0)
  )

  // Git recency (15% weight)
  const recencyData = gitRecency.get(filePath)
  const recencyBase = !recencyData
    ? 0
    : recencyData.daysAgo <= 1
      ? 1
      : recencyData.daysAgo <= 3
        ? 0.8
        : recencyData.daysAgo <= 7
          ? 0.6
          : recencyData.daysAgo <= 30
            ? 0.3
            : 0
  const recencyLabel =
    recencyBase === 1
      ? 'recent:1d'
      : recencyBase === 0.8
        ? 'recent:3d'
        : recencyBase === 0.6
          ? 'recent:1w'
          : recencyBase === 0.3
            ? 'recent:1m'
            : null
  if (recencyLabel) reasons.push(recencyLabel)
  const recencyScore = Math.min(
    1,
    recencyBase + (recencyData && recencyData.commits >= 5 ? 0.2 : 0)
  )

  // Import distance — simplified heuristic (5% weight)
  const filename = path.basename(filePath).toLowerCase()
  const isEntry =
    filename.includes('index') ||
    filename.includes('main') ||
    filename.includes('app') ||
    filename.includes('entry')
  const isCore =
    pathLower.includes('/core/') || pathLower.includes('/shared/') || pathLower.includes('/lib/')
  const importScore = isEntry ? 0.5 : isCore ? 0.3 : 0
  if (isEntry) reasons.push('import:0')
  else if (isCore) reasons.push('import:1')

  // Historical feedback signal (10% weight when available)
  const boost = historicalBoosts?.get(filePath)
  const historyScore = boost === undefined ? 0 : (boost + 1) / 2
  if (boost !== undefined && boost > 0) reasons.push('history:boosted')
  else if (boost !== undefined && boost < 0) reasons.push('history:penalized')

  // Calculate weighted score
  // With history: 54% keywords, 18% domain, 13% recency, 5% imports, 10% history
  // Without history: 60% keywords, 20% domain, 15% recency, 5% imports
  const hasHistory = historicalBoosts && historicalBoosts.size > 0
  const score = hasHistory
    ? keywordScore * 0.54 +
      domainScore * 0.18 +
      recencyScore * 0.13 +
      importScore * 0.05 +
      historyScore * 0.1
    : keywordScore * 0.6 + domainScore * 0.2 + recencyScore * 0.15 + importScore * 0.05

  return {
    path: filePath,
    score: Math.min(1, score),
    reasons: [...new Set(reasons)],
  }
}

function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return (
    lower.includes('.test.') ||
    lower.includes('.spec.') ||
    lower.includes('__tests__') ||
    lower.includes('__mocks__') ||
    lower.includes('/tests/') ||
    lower.includes('/test/') ||
    lower.endsWith('_test.go') ||
    lower.endsWith('_test.py')
  )
}
