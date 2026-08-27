/**
 * Analysis Payload Builder
 *
 * Builds a compact payload for the LLM to analyze during hybrid sync.
 * Selects the most important files using BM25, includes git context,
 * existing patterns, and task history.
 *
 * Design goal: minimize tokens while maximizing signal.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { queryFiles } from '../domain/bm25'
import { analysisStorage } from '../storage/analysis-storage'
import llmAnalysisStorage from '../storage/llm-analysis-storage'
import { stateStorage } from '../storage/state-storage'
import type { AnalysisPayload } from '../types/llm-analysis'
import type { GitData, ProjectStats } from '../types/project-sync'
import log from '../utils/logger'

/** Max characters per canonical sample — enough to expose imports + one implementation shape. */
const MAX_SAMPLE_CHARS = 700
/** Stratified samples replace a repo-wide reread while keeping the payload bounded. */
const MAX_SAMPLES = 9
/** Max recent commits — enough for context, not history */
const MAX_COMMITS = 8
/** Max task history entries */
const MAX_TASKS = 5

/**
 * Build the analysis payload for LLM consumption.
 * Gathers project data, selects important files, and assembles a compact payload.
 */
export async function buildAnalysisPayload(
  projectId: string,
  projectPath: string,
  git: GitData,
  stats: ProjectStats
): Promise<AnalysisPayload> {
  // Gather data in parallel
  const [codeSamples, existingPatterns, taskHistory, previousAnalysis] = await Promise.all([
    selectCodeSamples(projectId, projectPath, stats),
    getExistingPatterns(projectId),
    getTaskHistory(projectId),
    getPreviousAnalysisSummary(projectId),
  ])

  return {
    project: {
      name: stats.name,
      ecosystem: stats.ecosystem,
      languages: stats.languages,
      frameworks: stats.frameworks,
      fileCount: stats.fileCount,
      projectType: stats.projectType,
    },
    git: {
      branch: git.branch,
      recentCommits: git.recentCommits.slice(0, MAX_COMMITS).map((c) => ({
        message: c.message,
        date: c.date,
      })),
      hasChanges: git.hasChanges,
      weeklyCommits: git.weeklyCommits,
    },
    codeSamples,
    existingPatterns,
    taskHistory,
    previousAnalysis: previousAnalysis ?? undefined,
  }
}

/**
 * Select representative code samples by pattern lane. One global BM25 query
 * over-selected routers/config files and gave the LLM too little evidence to
 * learn testing, persistence, error, and service conventions. Stratification
 * spends roughly the same token budget but covers the repeated shapes agents
 * must reuse later.
 */
async function selectCodeSamples(
  projectId: string,
  projectPath: string,
  stats: ProjectStats
): Promise<AnalysisPayload['codeSamples']> {
  const samples: AnalysisPayload['codeSamples'] = []

  const probes = [
    // Reserve narrowly identifiable evidence before broad architectural queries
    // can consume the same file. This keeps each lane represented without
    // increasing the payload or rereading the repository.
    { lane: 'testing', query: 'test describe expect fixture mock integration' },
    { lane: 'data-access', query: 'repository storage database query transaction model schema' },
    { lane: 'error-handling', query: 'error result failure exception catch validation' },
    { lane: 'configuration', query: 'config settings environment options defaults' },
    { lane: 'dependency-boundary', query: 'adapter client provider gateway integration' },
    { lane: 'public-contract', query: 'interface type schema response request command manifest' },
    { lane: 'service-domain-flow', query: 'service domain usecase workflow orchestration' },
    {
      lane: 'architecture-boundary',
      query: `${stats.frameworks.join(' ')} router command handler controller service`,
    },
  ]
  const selected = new Set<string>()
  for (const probe of probes) {
    if (samples.length >= MAX_SAMPLES) break
    const candidates = queryFiles(projectId, probe.query, 6).filter(
      (file) => !selected.has(file.path)
    )
    for (const candidate of candidates) {
      try {
        const fullPath = path.join(projectPath, candidate.path)
        const content = await fs.readFile(fullPath, 'utf-8')
        selected.add(candidate.path)
        samples.push({
          path: candidate.path,
          content:
            content.length > MAX_SAMPLE_CHARS
              ? `${content.slice(0, MAX_SAMPLE_CHARS)}\n// ... truncated`
              : content,
          reason: `pattern lane: ${probe.lane}; BM25 ${candidate.score.toFixed(2)}`,
        })
        break
      } catch {
        // Try the next indexed candidate in this lane; never walk the repo.
      }
    }
  }

  // Always include entry points if not already selected
  const entryPoints = ['package.json', 'tsconfig.json', 'src/index.ts', 'src/main.ts', 'app.ts']
  for (const entry of entryPoints) {
    if (samples.length >= MAX_SAMPLES) break
    if (samples.some((s) => s.path === entry)) continue

    try {
      const fullPath = path.join(projectPath, entry)
      const content = await fs.readFile(fullPath, 'utf-8')
      samples.push({
        path: entry,
        content: content.slice(0, MAX_SAMPLE_CHARS),
        reason: 'entry point',
      })
    } catch {
      // File doesn't exist — skip
    }
  }

  return samples
}

/**
 * Get existing heuristic-detected patterns from the analysis storage.
 */
async function getExistingPatterns(
  projectId: string
): Promise<AnalysisPayload['existingPatterns']> {
  try {
    const analysis = await analysisStorage.getActive(projectId)
    if (!analysis) {
      return { patterns: [], antiPatterns: [] }
    }

    return {
      patterns: (analysis.patterns ?? []).map((p) => ({
        name: p.name,
        description: p.description,
      })),
      antiPatterns: (analysis.antiPatterns ?? []).map((a) => ({
        issue: a.issue,
        file: a.file,
        suggestion: a.suggestion,
      })),
    }
  } catch {
    return { patterns: [], antiPatterns: [] }
  }
}

/**
 * Get recent task history for context.
 */
async function getTaskHistory(projectId: string): Promise<AnalysisPayload['taskHistory']> {
  try {
    const history = await stateStorage.getTaskHistory(projectId)
    return history.slice(0, MAX_TASKS).map((t) => ({
      description: t.title,
      status: t.classification,
      branch: t.branchName,
    }))
  } catch {
    return []
  }
}

/**
 * Get a summary of the previous LLM analysis for delta comparison.
 */
function getPreviousAnalysisSummary(
  projectId: string
): Promise<AnalysisPayload['previousAnalysis'] | null> {
  try {
    const summary = llmAnalysisStorage.getActiveSummary(projectId)
    return Promise.resolve(summary)
  } catch (error) {
    log.debug('Failed to get previous LLM analysis summary', { error })
    return Promise.resolve(null)
  }
}
