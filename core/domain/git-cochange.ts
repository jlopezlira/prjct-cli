/**
 * Git Co-Change Analyzer
 *
 * Analyzes git history to find files that frequently change together.
 * If middleware.ts appears in 8 of 10 commits that touch auth.ts,
 * they're a cluster — when one is relevant, include the other.
 *
 * Uses Jaccard similarity: |A ∩ B| / |A ∪ B| for each file pair.
 *
 * Zero API calls — pure math on git log data.
 *
 */

import {
  COCHANGE_MAX_FILES_PER_COMMIT,
  COCHANGE_MIN_FILE_OCCURRENCES,
  COCHANGE_MIN_SIMILARITY,
} from '../constants/algorithms'
import prjctDb from '../storage/database'
import type { CoChangeIndex, CoChangeMatrix, CoChangeScore } from '../types/domain.js'
import { scoresToSortedArray } from '../utils/collection-filters'
import { execAsync } from '../utils/exec'

// Git Log Parsing

/**
 * Parse git log to extract commit → files mapping.
 *
 * @param projectPath - Project root path
 * @param maxCommits - Maximum number of commits to analyze (default: 100)
 * @returns Array of file sets, one per commit
 */
async function parseGitLog(projectPath: string, maxCommits = 100): Promise<Set<string>[]> {
  try {
    const { stdout } = await execAsync(
      `git log --name-only --pretty=format:'---COMMIT---' -${maxCommits}`,
      { cwd: projectPath, maxBuffer: 10 * 1024 * 1024 }
    )

    const parsed = stdout.split('\n').reduce(
      (state, line) => {
        const trimmed = line.trim()
        if (trimmed === '---COMMIT---') {
          if (
            state.currentFiles &&
            state.currentFiles.size > 0 &&
            state.currentFiles.size <= COCHANGE_MAX_FILES_PER_COMMIT
          ) {
            state.commits.push(state.currentFiles)
          }
          state.currentFiles = new Set()
        } else if (trimmed && state.currentFiles && isSourceFile(trimmed)) {
          state.currentFiles.add(trimmed)
        }
        return state
      },
      { commits: [] as Set<string>[], currentFiles: null as Set<string> | null }
    )

    // Don't forget the last commit
    if (
      parsed.currentFiles &&
      parsed.currentFiles.size > 0 &&
      parsed.currentFiles.size <= COCHANGE_MAX_FILES_PER_COMMIT
    ) {
      parsed.commits.push(parsed.currentFiles)
    }

    return parsed.commits
  } catch {
    return []
  }
}

/**
 * Check if a path looks like a source file worth tracking.
 */
function isSourceFile(filePath: string): boolean {
  const sourceExtensions = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|rb|php|vue|svelte)$/i
  return sourceExtensions.test(filePath) && !filePath.includes('node_modules/')
}

// Co-Change Matrix

/**
 * Build a co-change matrix from git history.
 *
 * For each pair of files that appear in the same commit,
 * calculate Jaccard similarity = |commits_both| / |commits_either|.
 *
 * Performance target: <2 seconds for 100 commits.
 */
export async function buildMatrix(projectPath: string, maxCommits = 100): Promise<CoChangeIndex> {
  const commitSets = await parseGitLog(projectPath, maxCommits)

  // Count how many commits each file appears in
  const fileCommitCount = new Map<string, number>()
  // Count how many commits each pair appears in together
  const pairCount = new Map<string, number>()

  for (const files of commitSets) {
    const fileArray = Array.from(files)

    for (const file2 of fileArray) {
      fileCommitCount.set(file2, (fileCommitCount.get(file2) || 0) + 1)
    }

    // Count co-occurrences for each pair
    for (const [index, file] of fileArray.entries()) {
      for (const otherFile of fileArray.slice(index + 1)) {
        const key = pairKey(file, otherFile)
        pairCount.set(key, (pairCount.get(key) || 0) + 1)
      }
    }
  }

  // Build Jaccard similarity matrix
  const matrix: CoChangeMatrix = {}

  for (const [key, count] of pairCount) {
    const [fileA, fileB] = key.split('\0')
    const countA = fileCommitCount.get(fileA) || 0
    const countB = fileCommitCount.get(fileB) || 0

    // Skip rare files
    if (countA < COCHANGE_MIN_FILE_OCCURRENCES || countB < COCHANGE_MIN_FILE_OCCURRENCES) continue

    // Jaccard similarity
    const unionCount = countA + countB - count
    const similarity = unionCount > 0 ? count / unionCount : 0

    if (similarity < COCHANGE_MIN_SIMILARITY) continue

    // Store bidirectionally
    if (!matrix[fileA]) matrix[fileA] = {}
    if (!matrix[fileB]) matrix[fileB] = {}
    matrix[fileA][fileB] = similarity
    matrix[fileB][fileA] = similarity
  }

  return {
    matrix,
    commitsAnalyzed: commitSets.length,
    filesAnalyzed: fileCommitCount.size,
    builtAt: new Date().toISOString(),
  }
}

/** Create a canonical pair key (sorted to avoid duplicates) */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`
}

// Scoring

/**
 * Given a set of seed files, find co-changed files and their scores.
 *
 * @param seedFiles - Files already identified as relevant
 * @param index - The co-change index
 * @returns Scored files NOT in the seed set
 */
export function scoreFromSeeds(seedFiles: string[], index: CoChangeIndex): CoChangeScore[] {
  const seedSet = new Set(seedFiles)
  const scores = new Map<string, number>()

  for (const seed of seedFiles) {
    const related = index.matrix[seed]
    if (!related) continue

    for (const [file, similarity] of Object.entries(related)) {
      if (seedSet.has(file)) continue

      // Take the max similarity across all seed connections
      const existing = scores.get(file) || 0
      if (similarity > existing) {
        scores.set(file, similarity)
      }
    }
  }

  return scoresToSortedArray(scores)
}

// SQLite Persistence

const INDEX_KEY = 'cochange-index'

// See `import-graph.loadGraph` for the rationale; same mtime cache.
const matrixCache = new Map<string, { matrix: CoChangeIndex; updatedAt: string }>()

export function saveMatrix(projectId: string, index: CoChangeIndex): void {
  prjctDb.setDoc(projectId, INDEX_KEY, index)
  matrixCache.delete(projectId)
}

export function loadMatrix(projectId: string): CoChangeIndex | null {
  const meta = prjctDb.get<{ updated_at: string }>(
    projectId,
    'SELECT updated_at FROM kv_store WHERE key = ?',
    INDEX_KEY
  )
  if (!meta) {
    matrixCache.delete(projectId)
    return null
  }
  const hit = matrixCache.get(projectId)
  if (hit && hit.updatedAt === meta.updated_at) return hit.matrix
  const matrix = prjctDb.getDoc<CoChangeIndex>(projectId, INDEX_KEY)
  if (matrix) matrixCache.set(projectId, { matrix, updatedAt: meta.updated_at })
  return matrix
}

async function recentHistoryFingerprint(
  projectPath: string,
  maxCommits: number
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`git rev-list --max-count=${maxCommits} HEAD`, {
      cwd: projectPath,
      maxBuffer: 1024 * 1024,
    })
    const commits = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    return commits.length > 0 ? commits.join('\n') : null
  } catch {
    return null
  }
}

// High-level API

/**
 * Build and persist the co-change matrix for a project.
 */
export async function indexCoChanges(
  projectPath: string,
  projectId: string,
  maxCommits = 100
): Promise<CoChangeIndex> {
  const historyFingerprint = await recentHistoryFingerprint(projectPath, maxCommits)
  const existing = historyFingerprint ? loadMatrix(projectId) : null
  if (existing?.historyFingerprint === historyFingerprint) return existing

  const index = await buildMatrix(projectPath, maxCommits)
  if (historyFingerprint) index.historyFingerprint = historyFingerprint
  saveMatrix(projectId, index)
  return index
}
