/**
 * Project Style Profile — pure builder for the "how this repo works" model.
 *
 * Mechanical sources (stats, stack detector, package.json, commands) always
 * contribute stack/libs/commands. Narrative patterns/conventions come from a
 * *valid* LLM analysis (not empty/unknown-only) and style-tagged memories.
 *
 * Deterministic; no IO except optional package.json already read by callers.
 */

import type { LLMAnalysis } from '../types/llm-analysis'
import type {
  ProjectStyleAntiPattern,
  ProjectStyleCommands,
  ProjectStyleConvention,
  ProjectStylePattern,
  ProjectStylePayload,
  ProjectStyleSnapshot,
  ProjectStyleSource,
  ProjectStyleStack,
  ProjectStyleStructural,
} from '../types/project-style'
import type { ProjectCommands, ProjectStats } from '../types/project-sync'
import type { StackDetection } from '../types/stack'
import { getTimestamp } from '../utils/date-helper'

const KNOWN_LIBS = [
  'zod',
  'better-sqlite3',
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/client',
  '@modelcontextprotocol/server',
  'chalk',
  'chokidar',
  'commander',
  'express',
  'fastify',
  'hono',
  'react',
  'next',
  'vue',
  'vitest',
  'jest',
  'typescript',
  'biome',
  'lefthook',
  'drizzle-orm',
  'prisma',
  '@prisma/client',
]

export function stableStyleKey(raw: string): string {
  const k = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return k || 'item'
}

/** True when analysis carries house-style signal worth keeping. */
export function isRichLlmAnalysis(
  a:
    | Pick<LLMAnalysis, 'architecture' | 'patterns' | 'antiPatterns' | 'conventions' | 'stack'>
    | null
    | undefined
): boolean {
  if (!a) return false
  if (a.architecture?.style && a.architecture.style !== 'unknown') return true
  if ((a.patterns?.length ?? 0) > 0) return true
  if ((a.conventions?.length ?? 0) > 0) return true
  if ((a.antiPatterns?.length ?? 0) > 0) return true
  if ((a.stack?.frameworks?.length ?? 0) > 0 || (a.stack?.languages?.length ?? 0) > 0) return true
  return false
}

export function isThinLlmAnalysis(a: LLMAnalysis | null | undefined): boolean {
  return !isRichLlmAnalysis(a)
}

export interface BuildProjectStyleInput {
  stats: ProjectStats
  stack: StackDetection
  commands?: ProjectCommands | null
  /** package.json deps merged (dependencies + devDependencies) */
  packageDeps?: Record<string, string>
  packageManager?: string | null
  llmAnalysis?: LLMAnalysis | null
  /** Memory-sourced style rows (type pattern / anti-pattern / decision with style topic) */
  memoryPatterns?: Array<{ name: string; description: string }>
  memoryAntiPatterns?: Array<{ issue: string; suggestion: string }>
  memoryConventions?: Array<{ rule: string; category?: string }>
  structural?: Partial<ProjectStyleStructural> | null
  commitHash?: string | null
  source?: ProjectStyleSource
  metrics?: Record<string, number | string>
  id?: string
  capturedAt?: string
}

export function buildProjectStylePayload(input: BuildProjectStyleInput): ProjectStylePayload {
  const stack = buildStack(input)
  const commands = buildCommands(input.commands)
  const fromLlm = isRichLlmAnalysis(input.llmAnalysis) ? input.llmAnalysis : null

  const conventions = mergeConventions(
    fromLlm?.conventions?.map((c) => ({
      key: stableStyleKey(c.category ? `${c.category}-${c.rule}` : c.rule),
      rule: c.rule,
      category: c.category,
    })) ?? [],
    input.memoryConventions?.map((c) => ({
      key: stableStyleKey(c.category ? `${c.category}-${c.rule}` : c.rule),
      rule: c.rule,
      category: c.category,
    })) ?? []
  )

  const patterns = mergePatterns(
    fromLlm?.patterns?.map((p) => ({
      key: stableStyleKey(p.name),
      name: p.name,
      description: p.description,
      locations: p.locations,
      category: p.category,
    })) ?? [],
    input.memoryPatterns?.map((p) => ({
      key: stableStyleKey(p.name),
      name: p.name,
      description: p.description,
    })) ?? []
  )

  const antiPatterns = mergeAntiPatterns(
    fromLlm?.antiPatterns?.map((a) => ({
      key: stableStyleKey(a.issue),
      issue: a.issue,
      suggestion: a.suggestion,
      severity: a.severity,
    })) ?? [],
    input.memoryAntiPatterns?.map((a) => ({
      key: stableStyleKey(a.issue),
      issue: a.issue,
      suggestion: a.suggestion,
    })) ?? []
  )

  // Prefer LLM stack languages/frameworks when present
  if (fromLlm?.stack?.languages?.length) {
    for (const lang of fromLlm.stack.languages) {
      if (!stack.languages.includes(lang)) stack.languages.push(lang)
    }
  }
  if (fromLlm?.stack?.frameworks?.length) {
    for (const fw of fromLlm.stack.frameworks) {
      if (!stack.frameworks.includes(fw)) stack.frameworks.push(fw)
    }
  }
  if (fromLlm?.stack?.packageManager && !stack.packageManager) {
    stack.packageManager = fromLlm.stack.packageManager
  }

  const structural: ProjectStyleStructural = {
    symbols: input.structural?.symbols ?? 0,
    files: input.structural?.files ?? input.stats.fileCount ?? 0,
    packages: input.structural?.packages ?? [],
  }

  return {
    payloadVersion: 1,
    stack,
    commands,
    conventions,
    patterns,
    antiPatterns,
    structural,
    metrics: { ...(input.metrics ?? {}) },
  }
}

export function buildProjectStyleSnapshot(input: BuildProjectStyleInput): ProjectStyleSnapshot {
  const payload = buildProjectStylePayload(input)
  const capturedAt = input.capturedAt ?? getTimestamp()
  const id =
    input.id ??
    `style_${capturedAt.replace(/[^0-9]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`

  return {
    id,
    capturedAt,
    commitHash: input.commitHash ?? null,
    source: input.source ?? 'sync-mechanical',
    patternCount: payload.patterns.length,
    antiPatternCount: payload.antiPatterns.length,
    conventionCount: payload.conventions.length,
    frameworkCount: payload.stack.frameworks.length,
    symbolCount: payload.structural.symbols,
    fileCount: payload.structural.files,
    summary: buildStyleSummary(payload),
    payload,
  }
}

export function buildStyleSummary(payload: ProjectStylePayload): string {
  const stackBits = [
    payload.stack.ecosystem !== 'unknown' ? payload.stack.ecosystem : null,
    payload.stack.languages.slice(0, 2).join('+') || null,
    payload.stack.frameworks.slice(0, 3).join(', ') || null,
  ].filter(Boolean)
  const stackLine = stackBits.length > 0 ? stackBits.join(' · ') : 'stack unknown'
  return (
    `${stackLine}; ` +
    `${payload.patterns.length} patterns, ${payload.antiPatterns.length} anti-patterns, ` +
    `${payload.conventions.length} conventions; ` +
    `${payload.structural.files} files` +
    (payload.structural.symbols > 0 ? `, ${payload.structural.symbols} symbols` : '')
  )
}

function buildStack(input: BuildProjectStyleInput): ProjectStyleStack {
  const frameworks = unique([...(input.stack.frameworks ?? []), ...(input.stats.frameworks ?? [])])
  const languages = unique([...(input.stats.languages ?? [])])
  const keyLibraries = collectKeyLibraries(input.packageDeps ?? {})
  const deps = input.packageDeps ?? {}

  // Promote known libs that are also "framework-ish" if stack detector missed them
  for (const lib of keyLibraries) {
    if (
      ['Hono', 'Express', 'Fastify', 'React', 'Next.js', 'Vue', 'NestJS'].includes(lib) &&
      !frameworks.includes(lib)
    ) {
      frameworks.push(lib)
    }
  }

  // Tests: stack detector + common test runners (incl. bun:test without vitest dep)
  const hasTests =
    input.stack.hasTesting === true ||
    Boolean(
      deps.vitest ||
        deps.jest ||
        deps.mocha ||
        deps['bun-types'] ||
        deps['@types/bun'] ||
        keyLibraries.includes('Vitest') ||
        keyLibraries.includes('Jest')
    ) ||
    // commands.test present and not a placeholder is a weak signal — callers
    // pass real detectCommands output when available
    Boolean(input.commands?.test && /test/i.test(input.commands.test))

  return {
    ecosystem: input.stats.ecosystem || 'unknown',
    languages,
    frameworks,
    packageManager: input.packageManager ?? undefined,
    keyLibraries,
    hasTests,
    hasDocker: input.stack.hasDocker === true,
  }
}

function buildCommands(commands?: ProjectCommands | null): ProjectStyleCommands {
  if (!commands) return {}
  return {
    test: commands.test,
    lint: commands.lint,
    build: commands.build,
    dev: commands.dev,
    install: commands.install,
    format: commands.format,
  }
}

function collectKeyLibraries(deps: Record<string, string>): string[] {
  const libraries = new Set<string>()
  for (const name of KNOWN_LIBS) {
    if (deps[name]) {
      libraries.add(displayLibName(name))
    }
  }
  return [...libraries].slice(0, 16)
}

function displayLibName(pkg: string): string {
  const map: Record<string, string> = {
    hono: 'Hono',
    express: 'Express',
    fastify: 'Fastify',
    react: 'React',
    next: 'Next.js',
    vue: 'Vue',
    vitest: 'Vitest',
    jest: 'Jest',
    typescript: 'TypeScript',
    zod: 'Zod',
    'better-sqlite3': 'better-sqlite3',
    '@modelcontextprotocol/sdk': 'MCP SDK',
    '@modelcontextprotocol/client': 'MCP SDK',
    '@modelcontextprotocol/server': 'MCP SDK',
    biome: 'Biome',
    lefthook: 'Lefthook',
    'drizzle-orm': 'Drizzle',
    prisma: 'Prisma',
    '@prisma/client': 'Prisma',
  }
  return map[pkg] ?? pkg
}

function mergeConventions(
  a: ProjectStyleConvention[],
  b: ProjectStyleConvention[]
): ProjectStyleConvention[] {
  const map = new Map<string, ProjectStyleConvention>()
  for (const c of [...a, ...b]) {
    if (!map.has(c.key)) map.set(c.key, c)
  }
  return [...map.values()].slice(0, 40)
}

function mergePatterns(a: ProjectStylePattern[], b: ProjectStylePattern[]): ProjectStylePattern[] {
  const map = new Map<string, ProjectStylePattern>()
  for (const p of [...a, ...b]) {
    if (!map.has(p.key)) map.set(p.key, p)
  }
  return [...map.values()].slice(0, 40)
}

function mergeAntiPatterns(
  a: ProjectStyleAntiPattern[],
  b: ProjectStyleAntiPattern[]
): ProjectStyleAntiPattern[] {
  const map = new Map<string, ProjectStyleAntiPattern>()
  for (const p of [...a, ...b]) {
    if (!map.has(p.key)) map.set(p.key, p)
  }
  return [...map.values()].slice(0, 40)
}

function unique(items: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const i of items) {
    const t = i.trim()
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

/** Compact inject block for SessionStart / work. */
export function formatProjectStyleDigest(
  snapshot: ProjectStyleSnapshot | null,
  opts: { maxConventions?: number; maxPatterns?: number; maxAnti?: number } = {}
): string | null {
  if (!snapshot) return null
  const maxC = opts.maxConventions ?? 5
  const maxP = opts.maxPatterns ?? 4
  const maxA = opts.maxAnti ?? 3
  const p = snapshot.payload
  const lines: string[] = ['## How this repo works (project style)', '']
  const stackParts = [
    p.stack.ecosystem !== 'unknown' ? p.stack.ecosystem : null,
    p.stack.languages.join(', ') || null,
    p.stack.frameworks.join(', ') || null,
    p.stack.keyLibraries.slice(0, 6).join(', ') || null,
  ].filter(Boolean)
  if (stackParts.length > 0) {
    lines.push(`**Stack:** ${stackParts.join(' · ')}`)
  }
  if (p.conventions.length > 0) {
    lines.push('', '**Conventions (match):**')
    for (const c of p.conventions.slice(0, maxC)) {
      lines.push(`- ${c.rule}`)
    }
  }
  if (p.patterns.length > 0) {
    lines.push('', '**Patterns (match):**')
    for (const pat of p.patterns.slice(0, maxP)) {
      lines.push(`- **${pat.name}** — ${truncate(pat.description, 120)}`)
    }
  }
  if (p.antiPatterns.length > 0) {
    lines.push('', '**Anti-patterns (avoid):**')
    for (const a of p.antiPatterns.slice(0, maxA)) {
      lines.push(`- ${a.issue}${a.suggestion ? ` → ${truncate(a.suggestion, 80)}` : ''}`)
    }
  }
  if (p.conventions.length === 0 && p.patterns.length === 0 && p.antiPatterns.length === 0) {
    lines.push(
      '',
      '_No durable house patterns yet — open a neighbor file and match local idiom. Prefer `prjct sync` + structured analysis-save-llm JSON to enrich._'
    )
  }
  lines.push('', `_${snapshot.summary}_`)
  return lines.join('\n')
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
