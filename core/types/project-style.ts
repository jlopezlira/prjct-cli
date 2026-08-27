/**
 * Project Style Model — progressive snapshots of how the repo works
 * (stack, patterns, conventions, anti-patterns). Symmetric to developer
 * evolution: captured on every sync, diffed, history kept for measurement.
 */

export type ProjectStyleSource = 'sync-mechanical' | 'sync-llm' | 'analysis-save'

export interface ProjectStyleStack {
  ecosystem: string
  languages: string[]
  frameworks: string[]
  packageManager?: string
  keyLibraries: string[]
  hasTests: boolean
  hasDocker: boolean
}

export interface ProjectStyleCommands {
  test?: string
  lint?: string
  build?: string
  dev?: string
  install?: string
  format?: string
}

export interface ProjectStyleConvention {
  key: string
  rule: string
  category?: string
  /** Concrete repository example captured by sync analysis. */
  example?: string
}

export interface ProjectStylePattern {
  key: string
  name: string
  description: string
  locations?: string[]
  category?: string
  confidence?: number
}

export interface ProjectStyleAntiPattern {
  key: string
  issue: string
  suggestion: string
  severity?: string
  /** Concrete files where sync observed the anti-pattern. */
  files?: string[]
  reasoning?: string
  confidence?: number
}

export interface ProjectStyleArchitecture {
  style: string
  insights: string[]
  domains: string[]
}

export interface ProjectStyleStructural {
  symbols: number
  files: number
  packages: string[]
}

/** Versioned payload stored as JSON on each snapshot row. */
export interface ProjectStylePayload {
  payloadVersion: 1
  stack: ProjectStyleStack
  commands: ProjectStyleCommands
  conventions: ProjectStyleConvention[]
  patterns: ProjectStylePattern[]
  antiPatterns: ProjectStyleAntiPattern[]
  /** Optional for snapshots written before architecture evidence was retained. */
  architecture?: ProjectStyleArchitecture
  structural: ProjectStyleStructural
  /** Extensible bag for future measurement without migrations. */
  metrics: Record<string, number | string>
}

export interface ProjectStyleSnapshot {
  id: string
  capturedAt: string
  commitHash: string | null
  source: ProjectStyleSource
  patternCount: number
  antiPatternCount: number
  conventionCount: number
  frameworkCount: number
  symbolCount: number
  fileCount: number
  summary: string
  payload: ProjectStylePayload
}

export type ProjectStyleDiffKind = 'added' | 'removed' | 'changed'

export interface ProjectStyleDiffItem {
  field: string
  type: ProjectStyleDiffKind
  before?: string
  after?: string
}

export interface ProjectStyleDiff {
  hasChanges: boolean
  items: ProjectStyleDiffItem[]
  summary: { added: number; removed: number; changed: number }
  beforeCommit: string | null
  afterCommit: string | null
}

export interface ProjectStyleRecomputeResult {
  snapshot: ProjectStyleSnapshot
  delta: ProjectStyleDiff
  isFirst: boolean
}
