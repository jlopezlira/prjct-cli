/**
 * Workflows Types
 * Types for onboarding wizard and outcome learning.
 */

// Onboarding Types

export type ProjectType =
  | 'web-app'
  | 'api-backend'
  | 'fullstack'
  | 'cli-tool'
  | 'library'
  | 'monorepo'
  | 'unknown'

export type AIAgent =
  | 'claude'
  | 'cursor'
  | 'copilot'
  | 'gemini'
  | 'codex'
  | 'antigravity'
  | 'opencode'
  | 'pi'
  | 'qwen-code'
  | 'goose'
  | 'aider'
  | 'cline'
  | 'roo-code'
  | 'continue'
  | 'kiro'
  | 'zed'
  | 'warp'
  | 'amp'
  | 'factory'
  | 'augment'
  | 'kilo-code'
  | 'devin'
  | 'jules'
  | 'phoenix'
  | 'ona'
  | 'semgrep'

export interface OnboardingDetectedStack {
  language: string
  framework?: string
  runtime?: string
  packageManager?: string
  technologies: string[]
}

export interface WizardPreferences {
  verbosity: 'minimal' | 'normal' | 'verbose'
  autoSync: boolean
  telemetry: boolean
}

export interface WizardResult {
  projectType: ProjectType
  agents: AIAgent[]
  stack: OnboardingDetectedStack
  preferences: WizardPreferences
  skipped: boolean
}

export interface WizardStep {
  id: string
  title: string
  run: () => Promise<boolean>
}

// Outcome Learner Types

/** A pattern extracted from outcome analysis */
export interface OutcomeLearnerExtractedPattern {
  /** Pattern description */
  pattern: string
  /** Number of times observed */
  occurrences: number
  /** Confidence: low (1-2), medium (3-4), high (5+) */
  confidence: 'low' | 'medium' | 'high'
  /** Category for memory tagging */
  category: PatternCategory
  /** Source tasks that contributed to this pattern */
  sourceTasks: string[]
}

export type PatternCategory =
  | 'file_cochange'
  | 'tech_stack'
  | 'architecture'
  | 'estimation'
  | 'workflow'
  | 'gotcha'

/** File co-change pattern: files that are frequently modified together */
export interface FileCochangePattern {
  /** File paths that change together */
  files: string[]
  /** Number of tasks where these files co-changed */
  occurrences: number
  /** Task types where this co-change happens */
  taskTypes: string[]
}

/** Result of auto-learning process */
export interface LearningResult {
  /** Patterns extracted */
  patternsExtracted: number
  /** Patterns that met confidence threshold */
  patternsQualified: number
  /** Memories created or updated */
  memoriesInjected: number
  /** Patterns below threshold (not injected) */
  patternsSkipped: number
  /** Details of what was learned */
  details: Array<{
    pattern: string
    action: 'created' | 'updated' | 'skipped'
    confidence: string
    reason?: string
  }>
}
