/**
 * Infrastructure Types
 * Types for path management, configuration, and system infrastructure.
 */

// Path Management Types

export interface MonorepoPackage {
  name: string
  path: string
  relativePath: string
  hasPrjctMd: boolean
}

export interface MonorepoInfo {
  isMonorepo: boolean
  type: 'pnpm' | 'npm' | 'yarn' | 'lerna' | 'nx' | 'rush' | 'turborepo' | null
  rootPath: string
  packages: MonorepoPackage[]
}

/**
 * Session information for date-based paths
 */
export interface PathSessionInfo {
  year: string
  month: string
  day: string
  path: string
  date: Date
}

/**
 * Layer types for file organization
 */
export type LayerType =
  | 'core'
  | 'planning'
  | 'progress'
  | 'analysis'
  | 'memory'
  | 'sessions'
  | 'sync'
  | 'storage'
  | 'context'

// Command Installer Types

/**
 * Result of command installation
 */
export interface InstallResult {
  success: boolean
  installed?: string[]
  errors?: Array<{ file: string; error: string }>
  path?: string
  error?: string
}

/**
 * Result of command uninstallation
 */
export interface UninstallResult {
  success: boolean
  uninstalled?: string[]
  errors?: Array<{ file: string; error: string }>
  error?: string
}

/**
 * Result of installation check
 */
export interface CheckResult {
  installed: boolean
  providerDetected: boolean
  commands?: string[]
  path?: string
}

/**
 * Result of command sync
 */
export interface SyncResult {
  success: boolean
  added: number
  updated: number
  removed: number
  errors?: Array<{ file: string; error: string }>
  error?: string
}

/**
 * Result of global config installation
 */
export interface GlobalConfigResult {
  success: boolean
  action: string
  path?: string
  error?: string
}

// Permission Types

/**
 * Permission level for operations
 */
export type PermissionLevel = 'allow' | 'deny' | 'ask'

/**
 * File operation types
 */
export type FileOperation = 'read' | 'write' | 'delete' | 'create'

/**
 * Permissions configuration
 */
export interface PermissionsConfig {
  bash: Record<string, PermissionLevel>
  files: {
    read: Record<string, PermissionLevel>
    write: Record<string, PermissionLevel>
    delete: Record<string, PermissionLevel>
  }
  web: {
    enabled: boolean
    allowedDomains: string[]
    blockedDomains: string[]
  }
  skills: Record<string, PermissionLevel>
  doomLoop: {
    enabled: boolean
    maxRetries: number
  }
  externalDirectories: string[]
}

// Permission Manager Types

export interface PermissionCheckResult {
  allowed: boolean
  level: PermissionLevel
  matchedPattern?: string
  reason?: string
}

// Agent Detector Types

export interface AgentCapabilities {
  mcp: boolean
  filesystem: string
  markdown: boolean
  emojis: boolean
  colors: boolean
  interactive: boolean
  agents: boolean
}

export interface AgentConfig {
  configFile: string | null
  commandPrefix: string
  responseStyle: string
  dataDir: string
  commandsDir: string | null
}

export interface AgentEnvironment {
  hasMCP: boolean
  sandboxed: boolean
  persistent: boolean
  agentSystem: boolean
}

export interface DetectedAgent {
  type: string
  name: string
  isSupported: boolean
  capabilities: AgentCapabilities
  config: AgentConfig
  environment: AgentEnvironment
}

// Author Detector Types

export interface DetectedAuthorInfo {
  name: string | null
  email: string | null
  github: string | null
}

export interface AuthorConfigStatus {
  hasGitHub: boolean
  hasGit: boolean
  author: DetectedAuthorInfo
  isComplete: boolean
  recommendations: string[]
}

// Setup Types

export interface CodexPRouterStatus {
  installed: boolean
  verified: boolean
  skillPath: string
  templateHash?: string
  templateSource?: string
  message?: string
  fix?: string[]
}

// AI Provider Types

export interface AntigravityDetection {
  /** Whether ~/.gemini/antigravity/ exists */
  installed: boolean
  /** Whether prjct skill is installed */
  skillInstalled: boolean
  /** Path to config directory */
  configPath?: string
}

export interface CodexDetection {
  /** Whether `codex` CLI is available */
  installed: boolean
  /** Whether prjct skill is installed */
  skillInstalled: boolean
  /** Path to config directory */
  configPath?: string
}

export interface KimiDetection {
  /** Whether the `kimi` CLI is available or ~/.kimi-code/ (legacy ~/.kimi/) exists */
  installed: boolean
  /** Path to config directory (~/.kimi-code preferred, legacy ~/.kimi as fallback) */
  configPath?: string
}
