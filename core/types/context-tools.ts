/**
 * Context Tools Types
 *
 * Shared interfaces for all context filtering tools.
 * These tools are designed for AI agents to efficiently explore
 * codebases WITHOUT consuming tokens for filtering.
 *
 */

// Token Measurement Types

/**
 * Cost savings breakdown by model
 */
export interface CostBreakdown {
  model: string
  inputSaved: number // $ saved on input tokens
  outputPotential: number // $ potential savings on output (estimated)
  total: number // Combined savings
}

/**
 * Token measurement result
 */
export interface TokenMetrics {
  tokens: {
    original: number
    filtered: number
    saved: number
  }
  compression: number // 0-1 (e.g., 0.90 = 90% reduction)
  cost: {
    saved: number // $ saved (using default model)
    formatted: string // Human-readable (e.g., "$0.02")
    byModel: CostBreakdown[] // Breakdown by popular models
  }
}

// Files Tool Types

/**
 * Relevance score reasons
 */
export type ScoreReason =
  | `keyword:${string}` // Matched keyword in path
  | `domain:${string}` // Matched domain pattern
  | `recent:${string}` // Recently modified (e.g., "3d" = 3 days)
  | `import:${number}` // Import distance from entry point
  | `extension:${string}` // File extension match
  | `history:${string}` // Historical feedback signal

/**
 * File with relevance score
 */
export interface ScoredFile {
  path: string
  score: number // 0-1
  reasons: ScoreReason[]
}

/**
 * Files tool output
 */
export interface FilesToolOutput {
  files: ScoredFile[]
  metrics: {
    filesScanned: number
    filesReturned: number
    scanDuration: number // ms
  }
}

// Signatures Tool Types

/**
 * Code signature types
 */
export type SignatureType =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'variable'
  | 'export'
  | 'import'

/**
 * Extracted code signature
 */
export interface CodeSignature {
  type: SignatureType
  name: string
  signature: string // Full signature string (e.g., "(token: string) => Promise<User>")
  exported: boolean
  line: number
  docstring?: string
}

/**
 * Signatures tool output
 */
export interface SignaturesToolOutput {
  file: string
  language: string
  signatures: CodeSignature[]
  fallback: boolean // True if full file was returned (no grammar)
  fallbackReason?: string
  metrics: TokenMetrics
}

// Imports Tool Types

/**
 * Import relationship
 */
export interface ImportRelation {
  source: string // Import path (e.g., "./types", "lodash")
  resolved: string | null // Resolved file path (null for external)
  isExternal: boolean
  importedNames?: string[] // Named imports
  isDefault?: boolean
  isNamespace?: boolean // import * as X
}

/**
 * File that imports the target
 */
export interface ImportedBy {
  file: string
  importedNames?: string[]
}

/**
 * Dependency tree node
 */
export interface DependencyNode {
  file: string
  imports: DependencyNode[]
  depth: number
}

/**
 * Imports tool output
 */
export interface ImportsToolOutput {
  file: string
  imports: ImportRelation[]
  importedBy: ImportedBy[]
  dependencyTree?: DependencyNode
  metrics: {
    totalImports: number
    externalImports: number
    internalImports: number
    importedByCount: number
  }
}

// Recent Tool Types

/**
 * Hot file from git analysis
 */
export interface HotFile {
  path: string
  changes: number // Number of commits touching this file
  heatScore: number // 0-1 normalized score
  lastChanged: string // Human-readable (e.g., "2h ago", "3d ago")
  lastChangedAt: string // ISO timestamp
}

/**
 * Recent tool output
 */
export interface RecentToolOutput {
  hotFiles: HotFile[]
  branchOnlyFiles: string[] // Files only changed in current branch
  metrics: {
    commitsAnalyzed: number
    totalFilesChanged: number
    filesReturned: number
    analysisWindow: string // e.g., "30 commits", "main..HEAD"
  }
}

// Summary Tool Types

/**
 * Public API entry
 */
export interface PublicAPIEntry {
  name: string
  type: SignatureType
  signature: string
  description?: string // From JSDoc/docstring
}

/**
 * Summary tool output
 */
export interface SummaryToolOutput {
  file: string
  purpose: string // Short description of file purpose
  publicAPI: PublicAPIEntry[]
  dependencies: string[] // Key dependencies
  metrics: TokenMetrics
}

// Context Tool Usage Tracking

/**
 * Tool usage record for metrics
 */
export interface ContextToolUsage {
  tool: 'files' | 'signatures' | 'imports' | 'recent' | 'summary'
  timestamp: string
  inputArgs: string
  tokensSaved: number
  compressionRate: number
  duration: number // ms
}

// Main Tool Result Type

/**
 * Union type for all tool outputs
 */
export interface MemoryToolOutput {
  markdown: string
  entryCount: number
  topic?: string
}

export type ContextToolOutput =
  | { tool: 'files'; result: FilesToolOutput }
  | { tool: 'signatures'; result: SignaturesToolOutput }
  | { tool: 'imports'; result: ImportsToolOutput }
  | { tool: 'recent'; result: RecentToolOutput }
  | { tool: 'summary'; result: SummaryToolOutput }
  | { tool: 'memory'; result: MemoryToolOutput }
  | { tool: 'learnings'; result: MemoryToolOutput }
  | { tool: 'skills'; result: { markdown: string } }
  | { tool: 'project'; result: { markdown: string } }
  | { tool: 'tiers'; result: { markdown: string; [key: string]: unknown } }
  | { tool: 'artifacts'; result: { markdown: string; [key: string]: unknown } }
  | { tool: 'error'; result: { error: string; code: string } }
