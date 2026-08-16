/**
 * Analysis Schema
 *
 * Defines the structure for analysis.json - repository analysis.
 * Supports a 3-state lifecycle: DRAFT → VERIFIED → SEALED (PRJ-263).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { isNotFoundError } from '../types/fs'
import { fileExists } from '../utils/file-helper'
import { summarizeChecks } from '../utils/verification-summary'
import { ModelMetadataSchema } from './model'

// Zod Schemas - Source of Truth

export const AnalysisStatusSchema = z.enum(['draft', 'verified', 'sealed'])

/** Detection provenance shared by patterns and anti-patterns alike. */
const PatternMetadataSchema = z.object({
  severity: z.enum(['low', 'medium', 'high']).optional(),
  language: z.string().optional(),
  framework: z.string().optional(),
  source: z.enum(['baseline', 'repo', 'context7', 'feedback']).optional(),
  confidence: z.number().min(0).max(1).optional(),
})

const CodePatternSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    location: z.string().optional(),
  })
  .extend(PatternMetadataSchema.shape)

const AntiPatternSchema = z
  .object({
    issue: z.string(),
    file: z.string(),
    suggestion: z.string(),
  })
  .extend(PatternMetadataSchema.shape)

export const AnalysisItemSchema = z.object({
  projectId: z.string(),
  languages: z.array(z.string()),
  frameworks: z.array(z.string()),
  packageManager: z.string().optional(),
  sourceDir: z.string().optional(),
  testDir: z.string().optional(),
  configFiles: z.array(z.string()),
  fileCount: z.number(),
  patterns: z.array(CodePatternSchema),
  antiPatterns: z.array(AntiPatternSchema),
  analyzedAt: z.string(), // ISO8601
  /** Which AI model was used for this analysis (PRJ-265) */
  modelMetadata: ModelMetadataSchema.optional(),

  // Sealable analysis fields (PRJ-263)
  /** Lifecycle status: draft (regenerable), verified (confirmed correct), sealed (locked) */
  status: AnalysisStatusSchema.default('draft'),
  /** Git commit hash at the time of analysis */
  commitHash: z.string().optional(),
  /** SHA-256 signature of analysis content + commit hash */
  signature: z.string().optional(),
  /** When the analysis was sealed */
  sealedAt: z.string().optional(), // ISO8601
  /** When the analysis was verified */
  verifiedAt: z.string().optional(), // ISO8601
})

// Inferred Types - Backward Compatible

/** Use z.input so optional fields with defaults (like status) remain optional in creation */
export type AnalysisSchema = z.input<typeof AnalysisItemSchema>

// Validation Helpers

/** Parse and validate analysis.json content */
export const parseAnalysis = (data: unknown): z.infer<typeof AnalysisItemSchema> =>
  AnalysisItemSchema.parse(data)
export const safeParseAnalysis = (data: unknown) => AnalysisItemSchema.safeParse(data)

// Defaults

// Semantic Verification (PRJ-270)

export interface SemanticCheckResult {
  name: string
  passed: boolean
  output?: string
  error?: string
  durationMs: number
}

export interface SemanticVerificationReport {
  passed: boolean
  checks: SemanticCheckResult[]
  totalMs: number
  failedCount: number
  passedCount: number
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

/**
 * Language to file extension mapping
 */
const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  TypeScript: ['.ts', '.tsx', '.mts', '.cts'],
  JavaScript: ['.js', '.jsx', '.mjs', '.cjs'],
  Python: ['.py', '.pyw'],
  Java: ['.java'],
  Go: ['.go'],
  Rust: ['.rs'],
  Ruby: ['.rb'],
  PHP: ['.php'],
  Swift: ['.swift'],
  Kotlin: ['.kt', '.kts'],
  'C++': ['.cpp', '.cc', '.cxx', '.hpp', '.h'],
  C: ['.c', '.h'],
  'C#': ['.cs'],
  Elixir: ['.ex', '.exs'],
  Scala: ['.scala'],
}

/**
 * Verify frameworks exist in package.json dependencies
 */
async function verifyFrameworks(
  analysis: AnalysisSchema,
  projectPath: string
): Promise<SemanticCheckResult> {
  const start = Date.now()

  if (analysis.frameworks.length === 0) {
    return {
      name: 'Framework verification',
      passed: true,
      output: 'No frameworks declared (skipped)',
      durationMs: Date.now() - start,
    }
  }

  try {
    const packagePath = path.join(projectPath, 'package.json')
    const content = await fs.readFile(packagePath, 'utf-8')
    const pkg: PackageJson = JSON.parse(content)

    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    }

    const missing: string[] = []
    const found: string[] = []

    for (const framework of analysis.frameworks) {
      const frameworkLower = framework.toLowerCase()
      const exists = Object.keys(allDeps).some((dep) => dep.toLowerCase().includes(frameworkLower))

      if (exists) {
        found.push(framework)
      } else {
        missing.push(framework)
      }
    }

    if (missing.length === 0) {
      return {
        name: 'Framework verification',
        passed: true,
        output: `${found.length} framework(s) verified in dependencies`,
        durationMs: Date.now() - start,
      }
    }

    return {
      name: 'Framework verification',
      passed: false,
      error: `Frameworks not found in dependencies: ${missing.join(', ')}`,
      durationMs: Date.now() - start,
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        name: 'Framework verification',
        passed: false,
        error: 'package.json not found (cannot verify frameworks)',
        durationMs: Date.now() - start,
      }
    }

    return {
      name: 'Framework verification',
      passed: false,
      error: `Failed to read package.json: ${error instanceof Error ? error.message : 'unknown error'}`,
      durationMs: Date.now() - start,
    }
  }
}

/**
 * Verify languages match actual file extensions in the project
 */
async function verifyLanguages(
  analysis: AnalysisSchema,
  projectPath: string
): Promise<SemanticCheckResult> {
  const start = Date.now()

  if (analysis.languages.length === 0) {
    return {
      name: 'Language verification',
      passed: true,
      output: 'No languages declared (skipped)',
      durationMs: Date.now() - start,
    }
  }

  try {
    // Get list of all file extensions in the project
    const extensions = await getProjectExtensions(projectPath)
    const foundExtensions = new Set(extensions)

    const verified: string[] = []
    const notFound: string[] = []

    for (const language of analysis.languages) {
      const expectedExts = LANGUAGE_EXTENSIONS[language]
      if (!expectedExts) {
        // Unknown language mapping - skip validation
        continue
      }

      const hasMatchingFiles = expectedExts.some((ext) => foundExtensions.has(ext))
      if (hasMatchingFiles) {
        verified.push(language)
      } else {
        notFound.push(language)
      }
    }

    if (notFound.length === 0) {
      return {
        name: 'Language verification',
        passed: true,
        output: `${verified.length} language(s) verified with matching files`,
        durationMs: Date.now() - start,
      }
    }

    return {
      name: 'Language verification',
      passed: false,
      error: `Languages without matching files: ${notFound.join(', ')}`,
      durationMs: Date.now() - start,
    }
  } catch (error) {
    return {
      name: 'Language verification',
      passed: false,
      error: `Failed to scan project files: ${error instanceof Error ? error.message : 'unknown error'}`,
      durationMs: Date.now() - start,
    }
  }
}

/**
 * Verify pattern locations reference real files
 */
async function verifyPatternLocations(
  analysis: AnalysisSchema,
  projectPath: string
): Promise<SemanticCheckResult> {
  const start = Date.now()

  const patternsWithLocations = analysis.patterns.filter((p) => p.location)

  if (patternsWithLocations.length === 0) {
    return {
      name: 'Pattern location verification',
      passed: true,
      output: 'No pattern locations specified (skipped)',
      durationMs: Date.now() - start,
    }
  }

  const missing: string[] = []
  const verified: string[] = []

  for (const pattern of patternsWithLocations) {
    const location = pattern.location!
    const filePath = path.join(projectPath, location)

    if (await fileExists(filePath)) {
      verified.push(location)
    } else {
      missing.push(`${pattern.name} (${location})`)
    }
  }

  if (missing.length === 0) {
    return {
      name: 'Pattern location verification',
      passed: true,
      output: `${verified.length} pattern location(s) verified`,
      durationMs: Date.now() - start,
    }
  }

  return {
    name: 'Pattern location verification',
    passed: false,
    error: `Pattern locations not found: ${missing.join(', ')}`,
    durationMs: Date.now() - start,
  }
}

/**
 * Verify file count accuracy (within 10% tolerance)
 */
async function verifyFileCount(
  analysis: AnalysisSchema,
  projectPath: string
): Promise<SemanticCheckResult> {
  const start = Date.now()

  try {
    const actualCount = await countProjectFiles(projectPath)
    const declared = analysis.fileCount
    const tolerance = 0.1 // 10% tolerance
    const diff = Math.abs(actualCount - declared)
    const allowedDiff = declared * tolerance

    if (diff <= allowedDiff) {
      return {
        name: 'File count verification',
        passed: true,
        output: `File count accurate (declared: ${declared}, actual: ${actualCount})`,
        durationMs: Date.now() - start,
      }
    }

    return {
      name: 'File count verification',
      passed: false,
      error: `File count mismatch: declared ${declared}, actual ${actualCount} (diff: ${diff})`,
      durationMs: Date.now() - start,
    }
  } catch (error) {
    return {
      name: 'File count verification',
      passed: false,
      error: `Failed to count files: ${error instanceof Error ? error.message : 'unknown error'}`,
      durationMs: Date.now() - start,
    }
  }
}

/**
 * Verify anti-pattern files exist
 */
async function verifyAntiPatternFiles(
  analysis: AnalysisSchema,
  projectPath: string
): Promise<SemanticCheckResult> {
  const start = Date.now()

  if (analysis.antiPatterns.length === 0) {
    return {
      name: 'Anti-pattern file verification',
      passed: true,
      output: 'No anti-patterns declared (skipped)',
      durationMs: Date.now() - start,
    }
  }

  const missing: string[] = []
  const verified: string[] = []

  for (const antiPattern of analysis.antiPatterns) {
    const filePath = path.join(projectPath, antiPattern.file)

    if (await fileExists(filePath)) {
      verified.push(antiPattern.file)
    } else {
      missing.push(`${antiPattern.issue} (${antiPattern.file})`)
    }
  }

  if (missing.length === 0) {
    return {
      name: 'Anti-pattern file verification',
      passed: true,
      output: `${verified.length} anti-pattern file(s) verified`,
      durationMs: Date.now() - start,
    }
  }

  return {
    name: 'Anti-pattern file verification',
    passed: false,
    error: `Anti-pattern files not found: ${missing.join(', ')}`,
    durationMs: Date.now() - start,
  }
}

/**
 * Run all semantic verification checks
 */
export async function semanticVerify(
  analysis: AnalysisSchema,
  projectPath: string
): Promise<SemanticVerificationReport> {
  const totalStart = Date.now()

  const checks = await Promise.all([
    verifyFrameworks(analysis, projectPath),
    verifyLanguages(analysis, projectPath),
    verifyPatternLocations(analysis, projectPath),
    verifyFileCount(analysis, projectPath),
    verifyAntiPatternFiles(analysis, projectPath),
  ])

  return summarizeChecks(checks, totalStart)
}

// Helper Functions

/**
 * Get all file extensions in a project (excluding common ignore patterns)
 */
async function getProjectExtensions(projectPath: string): Promise<string[]> {
  const extensions = new Set<string>()
  const ignorePatterns = [/node_modules/, /\.git/, /dist/, /build/, /\.next/, /\.turbo/, /coverage/]

  async function scanDir(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        const relativePath = path.relative(projectPath, fullPath)

        // Skip ignored patterns
        if (ignorePatterns.some((pattern) => pattern.test(relativePath))) {
          continue
        }

        if (entry.isDirectory()) {
          await scanDir(fullPath)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name)
          if (ext) {
            extensions.add(ext)
          }
        }
      }
    } catch {
      // Silently skip directories we can't read
    }
  }

  await scanDir(projectPath)
  return Array.from(extensions)
}

/**
 * Count total files in a project (excluding common ignore patterns)
 */
async function countProjectFiles(projectPath: string): Promise<number> {
  const ignorePatterns = [/node_modules/, /\.git/, /dist/, /build/, /\.next/, /\.turbo/, /coverage/]

  async function scanDir(dir: string): Promise<number> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const counts = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(dir, entry.name)
          const relativePath = path.relative(projectPath, fullPath)

          // Skip ignored patterns
          if (ignorePatterns.some((pattern) => pattern.test(relativePath))) {
            return 0
          }
          if (entry.isDirectory()) return scanDir(fullPath)
          return entry.isFile() ? 1 : 0
        })
      )
      return counts.reduce((total, count) => total + count, 0)
    } catch {
      return 0
    }
  }
  return scanDir(projectPath)
}
