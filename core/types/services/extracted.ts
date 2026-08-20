/**
 * Service types — second half: nested context, agents, changelog,
 * estimation, hooks, version, diagnostics. Split out of services.ts
 * to keep each file under 500 LOC.
 */

// --- Nested Context Resolver Types ---

export interface NestedContext {
  /** Absolute path to the PRJCT.md file */
  path: string
  /** Relative path from monorepo root */
  relativePath: string
  /** Depth in the directory tree (0 = root) */
  depth: number
  /** Parent context (null for root) */
  parent: NestedContext | null
  /** Child contexts */
  children: NestedContext[]
  /** Raw content of the PRJCT.md file */
  content: string
  /** Parsed sections from the PRJCT.md */
  sections: ContextSection[]
  /** Associated package info (if in a monorepo package) */
  package: import('../infrastructure.js').MonorepoPackage | null
}

export interface ContextSection {
  /** Section name (e.g., "Rules", "Patterns", "Stack") */
  name: string
  /** Section content */
  content: string
  /** Whether this section should override parent */
  override: boolean
}

export interface ResolvedContext {
  /** The final merged content */
  content: string
  /** Sources that contributed to this context (from root to leaf) */
  sources: string[]
  /** Sections that were overridden */
  overrides: string[]
}

export interface AgentDefinition {
  /** Agent name (e.g., "frontend", "backend", "database") */
  name: string
  /** Description of what this agent handles */
  description: string
  /** Domain this agent specializes in */
  domain?: string
  /** Trigger phrases that activate this agent */
  triggers?: string[]
  /** Rules/guidelines for this agent */
  rules?: string[]
  /** Code patterns this agent follows */
  patterns?: string[]
  /** Example interactions */
  examples?: string[]
  /** Whether this agent overrides parent definition */
  override?: boolean
}

export interface NestedAgents {
  /** Absolute path to the AGENTS.md file */
  path: string
  /** Relative path from monorepo root */
  relativePath: string
  /** Depth in the directory tree (0 = root) */
  depth: number
  /** Parent agents file (null for root) */
  parent: NestedAgents | null
  /** Child agents files */
  children: NestedAgents[]
  /** Raw content of the AGENTS.md file */
  content: string
  /** Parsed agent definitions */
  agents: AgentDefinition[]
  /** Associated package info (if in a monorepo package) */
  package: import('../infrastructure.js').MonorepoPackage | null
}

export interface ResolvedAgents {
  /** The merged agent definitions (deeper overrides shallower) */
  agents: AgentDefinition[]
  /** Sources that contributed to these agents (from root to leaf) */
  sources: string[]
  /** Agents that were overridden */
  overrides: string[]
}

// --- Skill Installer Types ---

export interface ParsedSource {
  type: 'github' | 'local'
  owner?: string
  repo?: string
  skillName?: string
  localPath?: string
  url: string
}

export interface InstalledSkill {
  name: string
  filePath: string
  source: ParsedSource
  sha?: string
}

export interface InstallResult {
  installed: InstalledSkill[]
  skipped: string[]
  errors: string[]
}

// --- File Categorizer Types ---

export interface CategorizationResult {
  domains: import('../storage/extended').DomainDefinition[]
  categories: import('../storage/extended').FileCategory[]
  metrics: {
    totalFiles: number
    categorizedFiles: number
    domainsDiscovered: number
    llmCalls: number
    usedHeuristics: boolean
  }
}

export interface CategorizationOptions {
  batchSize?: number // Files per LLM call (default: 20)
  maxDomains?: number // Max domains to discover (default: 15)
  useLLM?: boolean // Use LLM or heuristics only (default: true)
  projectId?: string // For caching
}

// --- Changelog Service Types ---

export type ChangelogFormat = 'keepachangelog' | 'markdown'

export interface ChangelogDetection {
  /** Absolute path to the detected changelog file */
  filePath: string
  /** Filename (e.g. "CHANGELOG.md") */
  fileName: string
  /** Detected format */
  format: ChangelogFormat
  /** Whether the file already existed or was created */
  created: boolean
}

export interface ChangelogEntry {
  version: string
  date?: string
  sections?: Record<string, string[]>
  description?: string
}

// --- Task Estimation Types ---

export interface TaskEstimate {
  taskType: 'feature' | 'bug' | 'improvement' | 'chore'
  estimatedPoints: import('../domain.js').FibonacciPoint
  estimatedMinutes: number
  source: 'history' | 'heuristic'
}

// --- Context Selector Types ---

export interface SelectedContext {
  files: import('../storage/extended').ScoredFile[]
  domains: string[]
  metrics: {
    totalFiles: number
    selectedFiles: number
    compressionRate: number
    estimatedTokensSaved: number
  }
}

export interface ContextSelectionOptions {
  maxFiles?: number // Max files to return (default: 50)
  minScore?: number // Min relevance score (default: 30)
  includeGeneral?: boolean // Include 'general' domain files (default: true)
  tokenBudget?: number // Max estimated tokens (default: 80000, or from coordinator)
}

// --- Hooks Service Types ---

export type HookStrategy = 'lefthook' | 'husky' | 'direct'
export type HookName = 'post-commit' | 'post-checkout'

// --- Analysis Diff Types ---

export interface AnalysisDiffItem {
  field: string
  type: 'added' | 'removed' | 'changed'
  before?: string
  after?: string
}

export interface AnalysisDiff {
  hasChanges: boolean
  items: AnalysisDiffItem[]
  summary: {
    added: number
    removed: number
    changed: number
  }
  beforeCommit: string | null
  afterCommit: string | null
}

// --- Version Service Types ---

export type VersionFormat = 'json' | 'toml' | 'xml' | 'plaintext' | 'git-tag'

export interface VersionInfo {
  current: string
  next: string
  file: string | null
  format: VersionFormat
}

// --- Doctor Service Types ---

export interface CheckResult {
  name: string
  status: 'ok' | 'warn' | 'error'
  version?: string
  message?: string
  optional?: boolean
}

export interface DoctorResult {
  success: boolean
  tools: CheckResult[]
  project: CheckResult[]
  context: CheckResult[]
  recommendations: string[]
  hasErrors: boolean
  hasWarnings: boolean
}
