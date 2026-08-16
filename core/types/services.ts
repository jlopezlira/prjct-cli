/**
 * Service Types
 * Types for service layer modules.
 */

// Breakdown Service Types

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface ComplexityEstimate {
  level: 'low' | 'medium' | 'high'
  hours: number
  confidence?: number
  factors?: string[]
}

// Skill Service Types

export interface SkillMetadata {
  name: string
  description?: string
  agent?: string
  tags?: string[]
  version?: string
  category?: string
  author?: string
  // Ecosystem compatibility fields
  sourceUrl?: string
  sourceType?: 'github' | 'local' | 'builtin' | 'registry'
  installedAt?: string
  sha?: string
}

export interface Skill {
  id: string
  name: string
  description: string
  content: string
  source: 'project' | 'global' | 'builtin' | 'remote'
  filePath: string
  metadata: SkillMetadata
  path?: string
  isBuiltin?: boolean
}

export interface SkillSearchResult {
  skill: Skill
  relevance: number
  score?: number
  matchedTerms?: string[]
}

// AI Tools Registry Types

export interface AIToolConfig {
  id: string
  name: string
  outputFile: string
  outputPath: 'repo' | 'global'
  maxTokens: number
  format: 'detailed' | 'concise' | 'minimal' | 'json'
  description: string
}

// Memory Service Types

export interface MemoryServiceEntry {
  id?: string
  type?: string
  content?: string
  timestamp: string
  action: string
  data: Record<string, unknown>
  author?: string
  metadata?: Record<string, unknown>
}

// --- Extracted from core/services ---

// --- Pattern Extractor Types ---

export interface ExtractedPattern {
  name: string
  description: string
  location?: string
  severity?: 'low' | 'medium' | 'high'
  language?: string
  framework?: string
  source: 'baseline' | 'repo' | 'context7' | 'feedback'
  confidence?: number
}

export interface ExtractedAntiPattern {
  issue: string
  file: string
  suggestion: string
  severity?: 'low' | 'medium' | 'high'
  language?: string
  framework?: string
  source: 'baseline' | 'repo' | 'context7' | 'feedback'
  confidence?: number
}

export interface ExtractPatternInput {
  projectId: string
  projectPath: string
  languages: string[]
  frameworks: string[]
  feedback?: {
    patternsDiscovered: string[]
    knownGotchas: string[]
  }
  context7Verified: boolean
}

export interface ExtractPatternResult {
  patterns: ExtractedPattern[]
  antiPatterns: ExtractedAntiPattern[]
  repoPathHash: string
}

// --- Context7 Service Types ---

export interface Context7Status {
  installed: boolean
  verified: boolean
  configPath: string
  message?: string
}

// --- File Scorer Types ---

export interface FileScore {
  path: string
  score: number
  factors: {
    recency: number // 0-20
    centrality: number // 0-25
    configRelevance: number // 0-20
    nameRelevance: number // 0-15
    sizeOptimal: number // 0-10
    gitActivity: number // 0-10
  }
}

export interface FileStats {
  path: string
  size: number // bytes
  mtime: Date // modification time
  lines?: number // line count
  imports?: string[] // files this imports
  importedBy?: string[] // files that import this
  recentCommits?: number // commits in last 30 days
}

export interface ScoringContext {
  allFiles: Map<string, FileStats>
  configFiles: Set<string>
  maxFileSize: number
  maxRecentCommits: number
  now: Date
}

// --- Staleness Checker Types ---

export interface StalenessStatus {
  isStale: boolean
  reason: string | null
  lastSyncCommit: string | null
  currentCommit: string | null
  commitsSinceSync: number
  daysSinceSync: number
  changedFiles: string[]
  significantChanges: string[] // Files that likely affect context (package.json, etc.)
}

export interface StalenessConfig {
  commitThreshold: number // Number of commits before considered stale (default: 10)
  dayThreshold: number // Days before considered stale (default: 3)
  significantFiles: string[] // Files that trigger staleness warning
}

// --- Sync Agent Gen / Agent Generator Types ---

/** Task feedback context for agent generation (PRJ-272) */
export interface TaskFeedbackContext {
  patternsDiscovered: string[]
  knownGotchas: string[]
  agentAccuracy: Array<{ agent: string; rating: string; note?: string }>
}

// --- Git Analyzer Types --- GitData lives in './project-sync' (its
// documented single source of truth); import from there directly.

// --- Agent Generator Types ---

export interface AgentInfo {
  name: string
  type: 'workflow' | 'domain'
  skill?: string
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

// --- Dependency Validator Types ---

export interface ToolDefinition {
  name: string
  command: string // Command to check availability (e.g., 'git --version')
  versionRegex?: RegExp // Regex to extract version from output
  required: boolean // If false, missing tool is a warning, not error
  installHint: string // How to install if missing
  docs?: string // Documentation URL
}

export interface ToolStatus {
  available: boolean
  version?: string
  error?: import('./errors.js').ErrorWithHint
}

// --- Project Index Types ---

export interface IndexOptions {
  forceFullScan?: boolean // Force full scan even if index exists
  maxFiles?: number // Limit number of files to scan (for large repos)
  excludePatterns?: string[] // Additional patterns to exclude
}

export interface ScanResult {
  index: import('./storage/extended').ProjectIndex
  fromCache: boolean
  changedFiles: number
  scanDuration: number
}

export interface RelevantContext {
  files: import('./storage/extended').ScoredFile[]
  estimatedTokens: number
  originalTokens: number
  compressionRate: number
}

// --- Generated Skill Types (Native Claude Code Skills) ---

/** A workflow skill auto-generated by sync and installed to ~/.claude/skills/ */
export interface GeneratedSkill {
  /** Skill name (e.g., 'prjct-task', 'prjct-ship') */
  name: string
  /** Short description for frontmatter */
  description: string
  /** Full SKILL.md content (frontmatter + body) */
  content: string
  /** Installation path (e.g., ~/.claude/skills/prjct-task/SKILL.md) */
  path: string
}

/** Result of skill generation during sync */
export interface SkillGenerationResult {
  /** Skills that were generated and installed */
  generated: { name: string; path: string }[]
  /** Skills skipped because conditions not met */
  skipped: { name: string; reason: string }[]
}

// --- Skill Lock Types ---

export interface SkillLockSource {
  type: 'github' | 'local' | 'registry'
  url: string
  sha?: string
}

export interface SkillLockEntry {
  name: string
  source: SkillLockSource
  installedAt: string
  filePath: string
}

export interface SkillLockFile {
  version: 1
  generatedAt: string
  skills: Record<string, SkillLockEntry>
}

// --- Session Tracker Types ---

export interface CommandRecord {
  command: string
  timestamp: string
  durationMs: number
}

export interface FileRecord {
  path: string
  operation: 'read' | 'write'
  timestamp: string
}

export interface SessionData {
  id: string
  projectId: string
  status: 'active' | 'expired'
  createdAt: string
  lastActivity: string
  commands: CommandRecord[]
  files: FileRecord[]
}

export interface SessionFile {
  current: SessionData | null
  config: {
    idleTimeoutMs: number
  }
}

export interface SessionInfo {
  active: boolean
  id: string | null
  duration: string | null
  idleSince: string | null
  idleMs: number
  expiresIn: string | null
  commandCount: number
  commands: string[]
  filesRead: number
  filesWritten: number
}
