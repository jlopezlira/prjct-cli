/**
 * Storage types — second half: archive, custom workflows, database, workflow
 * rules, safe reader, migrate json, system database, index storage.
 * Split out of storage.ts to keep each file under 500 LOC.
 */

// Archive Storage Types (from archive-storage.ts)

export type ArchiveEntityType =
  | 'shipped'
  | 'idea'
  | 'queue_task'
  | 'paused_task'
  | 'memory_entry'
  | 'workspace_task'

export interface ArchiveRecord {
  id: string
  entity_type: ArchiveEntityType
  entity_id: string
  entity_data: string
  summary: string | null
  archived_at: string
  reason: string
}

export interface ArchiveItem {
  entityType: ArchiveEntityType
  entityId: string
  entityData: unknown
  summary?: string
  reason: string
}

export interface ArchiveStats {
  shipped: number
  idea: number
  queue_task: number
  paused_task: number
  memory_entry: number
  workspace_task: number
  total: number
}

// Custom Workflow Storage Types (from custom-workflow-storage.ts)

export interface CustomWorkflow {
  id: number
  name: string
  description: string | null
  createdAt: string
  updatedAt: string
  isBuiltin: boolean
  enabled: boolean
  metadata: Record<string, unknown> | null
}

// Database Types (from database.ts)

import type { SqliteDatabase } from '../../storage/database/sqlite-compat'

export interface Migration {
  version: number
  name: string
  up: (db: SqliteDatabase) => void
}

export interface MigrationRecord {
  version: number
  name: string
  applied_at: string
}

// Workflow Rule Storage Types (from workflow-rule-storage.ts)

export interface WorkflowRule {
  id: number
  type: 'hook' | 'gate' | 'step' | 'instruction'
  command: string
  position: string
  action: string
  description: string | null
  enabled: boolean
  timeoutMs: number
  createdAt: string
  sortOrder: number
  /**
   * v2 conditional: a rule runs only when the expression matches. Tiny DSL:
   * `tags:type=bug`, `files:*.ts`, `branch~main`, `branch=main`. Multiple
   * conditions joined by whitespace AND. `null`/empty → always runs.
   */
  whenExpr: string | null
  /**
   * v2 hook parallelism. When true (default), hooks run concurrently via
   * Promise.all. Set false for hooks with ordering dependencies. Ignored
   * by gates and steps — those stay sequential.
   */
  parallel: boolean
  /**
   * Where the rule's shell action came from. `local` (default) runs as
   * the user authored it. `imported` indicates the rule was pulled from a
   * shared template — reserved for a future template registry so the
   * engine can refuse unfamiliar shell actions until approved.
   */
  trustSource: 'local' | 'imported'
}

// Safe Reader Types (from safe-reader.ts)

import type { ZodError } from 'zod'

/**
 * Minimal interface for Zod-like validation.
 * Decoupled from Zod generics to avoid strict type parameter matching.
 */
export interface ValidationSchema {
  safeParse(data: unknown): { success: boolean; error?: ZodError }
}

// Index Storage Types (from index-storage.ts)

export interface LanguageStats {
  count: number // Number of files
  totalLines: number // Total lines of code
  totalSize: number // Total bytes
}

export interface ConfigFileEntry {
  path: string
  type: string // "package.json", "Cargo.toml", etc.
  checksum: string
  parsed?: Record<string, unknown>
}

export interface DirectoryEntry {
  path: string
  type: 'source' | 'test' | 'config' | 'build' | 'vendor' | 'docs' | 'unknown'
  fileCount: number
}

export interface ScoredFile {
  path: string
  score: number
  size: number
  mtime: string // ISO timestamp
  categories?: string[] // Domain categories: ['payments', 'api', 'backend']
}

export interface DetectedPattern {
  name: string // "monorepo", "api-first", "component-based"
  confidence: number // 0-1
  evidence: string[] // Files/dirs that evidence this pattern
}

export interface DetectedStack {
  ecosystem: string // "JavaScript", "Python", "Rust", etc.
  frameworks: string[] // Detected frameworks
  hasTests: boolean
  hasDocker: boolean
  hasCi: boolean
  buildTool: string | null
}

export interface ProjectIndex {
  version: string
  projectPath: string
  lastFullScan: string // ISO timestamp
  lastIncrementalUpdate: string // ISO timestamp

  // Language detection by extension
  languages: Record<string, LanguageStats>

  // Config files found
  configFiles: ConfigFileEntry[]

  // Directory structure (top-level relevant)
  directories: DirectoryEntry[]

  // Files with score > threshold
  relevantFiles: ScoredFile[]

  // Detected patterns
  patterns: DetectedPattern[]

  // Stack detection
  detectedStack: DetectedStack

  // Metrics
  totalFiles: number
  totalSize: number // Total bytes
  totalLines: number // Total LOC
  scanDuration: number // ms
}

export interface FileChecksums {
  version: string
  lastUpdated: string
  checksums: Record<string, string> // path -> checksum
}

/**
 * A domain discovered by LLM analysis of the project
 */
export interface DomainDefinition {
  name: string // "payments", "shipping", "inventory"
  description: string // "Handles payment processing, Stripe integration"
  keywords: string[] // ["stripe", "checkout", "billing"]
  filePatterns: string[] // ["**/payments/**", "**/billing/**"]
  fileCount: number // Number of files in this domain
}

/**
 * Discovered domains for a project
 */
export interface DiscoveredDomains {
  version: string
  projectId: string
  domains: DomainDefinition[]
  discoveredAt: string // ISO timestamp
}

/**
 * Category assignment for a single file
 */
export interface FileCategory {
  path: string
  categories: string[] // ['payments', 'users', 'api']
  primaryDomain: string // 'payments'
  confidence: number // 0-1
  categorizedAt: string // ISO timestamp
  method: 'llm' | 'heuristic' // How it was categorized
}

/**
 * Cache of file categorizations
 */
export interface CategoriesCache {
  version: string
  lastUpdate: string
  fileCategories: FileCategory[]
  domainIndex: Record<string, string[]> // domain -> file paths
}
