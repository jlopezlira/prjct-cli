/**
 * Task-relevant project pattern retrieval.
 *
 * Sync already paid the cost of discovering house patterns. This selector
 * turns the active style snapshot into a compact, evidence-backed task card
 * so each model does not re-read the repository to rediscover conventions.
 */

import path from 'node:path'
import type {
  ProjectStyleAntiPattern,
  ProjectStyleConvention,
  ProjectStylePattern,
  ProjectStyleSnapshot,
} from '../types/project-style'
import { getActiveProjectStyle } from './project-style-evolution'

const STOP_WORDS = new Set([
  'and',
  'app',
  'con',
  'continue',
  'core',
  'del',
  'desde',
  'esto',
  'for',
  'hacer',
  'into',
  'lib',
  'para',
  'por',
  'que',
  'the',
  'test',
  'tests',
  'this',
  'una',
  'use',
  'with',
])

export interface RelevantProjectPatternContext {
  architecture: ProjectStyleSnapshot['payload']['architecture'] | null
  patterns: ProjectStylePattern[]
  conventions: ProjectStyleConvention[]
  antiPatterns: ProjectStyleAntiPattern[]
  sourceSummary: string
}

export interface ProjectPatternContextOptions {
  targetFiles?: readonly string[]
  maxPatterns?: number
  maxConventions?: number
  maxAntiPatterns?: number
}

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function tokens(value: string): Set<string> {
  return new Set(
    normalized(value)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
  )
}

function normalizeRepoPath(value: string): string {
  return value
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/[*?[{].*$/, '')
    .replace(/\/$/, '')
}

function pathAffinity(locations: readonly string[], targets: readonly string[]): number {
  let best = 0
  for (const rawLocation of locations) {
    const location = normalizeRepoPath(rawLocation)
    if (!location) continue
    for (const rawTarget of targets) {
      const target = normalizeRepoPath(rawTarget)
      if (!target) continue
      if (target === location) best = Math.max(best, 30)
      else if (target.startsWith(`${location}/`) || location.startsWith(`${target}/`)) {
        best = Math.max(best, 24)
      } else if (path.dirname(target) === path.dirname(location)) {
        best = Math.max(best, 16)
      } else {
        const locationParts = new Set(location.split('/').filter((part) => part.length >= 3))
        const shared = target
          .split('/')
          .filter((part) => part.length >= 3 && locationParts.has(part)).length
        best = Math.max(best, shared * 4)
      }
    }
  }
  return best
}

function relevanceScore(
  queryTokens: Set<string>,
  text: string,
  locations: readonly string[],
  targets: readonly string[],
  confidence?: number
): number {
  const candidateTokens = tokens(`${text} ${locations.join(' ')}`)
  let overlap = 0
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap++
  }
  return overlap * 8 + pathAffinity(locations, targets) + (overlap > 0 ? (confidence ?? 0) : 0)
}

function rank<T>(values: readonly T[], score: (value: T) => number, limit: number): T[] {
  return values
    .map((value, index) => ({ value, index, score: score(value) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.value)
}

export function selectRelevantProjectPatterns(
  snapshot: ProjectStyleSnapshot | null,
  query: string,
  options: ProjectPatternContextOptions = {}
): RelevantProjectPatternContext | null {
  if (!snapshot) return null
  const targetFiles = options.targetFiles ?? []
  const queryTokens = tokens(`${query} ${targetFiles.join(' ')}`)
  if (queryTokens.size === 0 && targetFiles.length === 0) return null
  const payload = snapshot.payload

  const patterns = rank(
    payload.patterns,
    (pattern) =>
      relevanceScore(
        queryTokens,
        `${pattern.name} ${pattern.description} ${pattern.category ?? ''}`,
        pattern.locations ?? [],
        targetFiles,
        pattern.confidence
      ),
    options.maxPatterns ?? 3
  )
  const conventions = rank(
    payload.conventions,
    (convention) =>
      relevanceScore(
        queryTokens,
        `${convention.category ?? ''} ${convention.rule} ${convention.example ?? ''}`,
        [],
        targetFiles
      ),
    options.maxConventions ?? 2
  )
  const antiPatterns = rank(
    payload.antiPatterns,
    (anti) =>
      relevanceScore(
        queryTokens,
        `${anti.issue} ${anti.reasoning ?? ''} ${anti.suggestion}`,
        anti.files ?? [],
        targetFiles,
        anti.confidence
      ),
    options.maxAntiPatterns ?? 2
  )

  if (patterns.length === 0 && conventions.length === 0 && antiPatterns.length === 0) return null
  return {
    architecture: payload.architecture ?? null,
    patterns,
    conventions,
    antiPatterns,
    sourceSummary: snapshot.summary,
  }
}

export function relevantProjectPatterns(
  projectId: string,
  query: string,
  options: ProjectPatternContextOptions = {}
): RelevantProjectPatternContext | null {
  return selectRelevantProjectPatterns(getActiveProjectStyle(projectId), query, options)
}

function flat(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function evidence(paths: readonly string[] | undefined): string {
  if (!paths?.length) return ''
  return ` [canonical: ${paths
    .slice(0, 2)
    .map((file) => `\`${file}\``)
    .join(', ')}]`
}

/** Whole-line bounded formatter; never cuts a rule or canonical path in half. */
export function formatRelevantProjectPatterns(
  context: RelevantProjectPatternContext | null,
  options: { maxChars?: number; header?: string } = {}
): string | null {
  if (!context) return null
  const maxChars = options.maxChars ?? 640
  const lines = [options.header ?? '# prjct: relevant repo patterns (synced)']
  for (const pattern of context.patterns) {
    lines.push(
      `- MATCH **${flat(pattern.name, 70)}**: ${flat(pattern.description, 150)}${evidence(pattern.locations)}`
    )
  }
  for (const anti of context.antiPatterns) {
    lines.push(
      `- AVOID: ${flat(anti.issue, 100)} → ${flat(anti.suggestion, 130)}${evidence(anti.files)}`
    )
  }
  for (const convention of context.conventions) {
    const example = convention.example ? ` Example: ${flat(convention.example, 100)}.` : ''
    lines.push(
      `- RULE${convention.category ? ` (${convention.category})` : ''}: ${flat(convention.rule, 150)}${example}`
    )
  }

  const kept: string[] = []
  for (const line of lines) {
    const candidate = kept.length > 0 ? `${kept.join('\n')}\n${line}` : line
    // One unusually long canonical path must not hide every shorter rule that
    // follows it. Keep whole evidence lines and continue packing useful ones.
    if (candidate.length > maxChars) continue
    kept.push(line)
  }
  return kept.length > 1 ? kept.join('\n') : null
}

/** Adapter for the existing work/review alignment surface. */
export function projectPatternAlignmentEntries(context: RelevantProjectPatternContext | null): {
  patterns: Array<{ title: string; content: string }>
  antiPatterns: Array<{ title: string; content: string }>
} {
  if (!context) return { patterns: [], antiPatterns: [] }
  return {
    patterns: [
      ...context.patterns.map((pattern) => ({
        title: pattern.name,
        content: `${pattern.description}${evidence(pattern.locations)}`,
      })),
      ...context.conventions.map((convention) => ({
        title: convention.category ?? 'convention',
        content: `${convention.rule}${convention.example ? ` Example: ${convention.example}.` : ''}`,
      })),
    ],
    antiPatterns: context.antiPatterns.map((anti) => ({
      title: anti.issue,
      content: `${anti.suggestion}${evidence(anti.files)}`,
    })),
  }
}
