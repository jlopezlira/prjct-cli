/**
 * AI Provider Types
 *
 * Abstractions for supporting multiple AI coding agents:
 * - Claude Code (CLI)
 * - Gemini CLI (CLI)
 * - Cursor IDE (GUI, project-level config)
 *
 * Key discovery: Skills use identical SKILL.md format for CLI providers.
 * Cursor uses .mdc files with frontmatter for rules.
 *
 * @see https://geminicli.com/docs/cli/gemini-md/
 * @see https://geminicli.com/docs/cli/skills/
 * @see https://cursor.com/docs/context/rules
 */

/**
 * Supported AI provider names
 */
export type AIProviderName = 'claude' | 'gemini' | 'cursor' | 'antigravity' | 'codex'

/**
 * Command format for each provider
 * - Claude: Markdown files (.md)
 * - Gemini: TOML files (.toml)
 */
export type CommandFormat = 'md' | 'toml'

/**
 * AI Provider configuration
 * Defines paths and formats for each AI coding agent
 */
export interface AIProviderConfig {
  /** Provider identifier */
  name: AIProviderName

  /** Display name for UI/logs */
  displayName: string

  /** CLI command name (e.g., 'claude', 'gemini'). Null for GUI apps like Cursor */
  cliCommand: string | null

  /** Global config directory (e.g., ~/.claude, ~/.gemini). Null for project-level only (Cursor) */
  configDir: string | null

  /** Context file name (CLAUDE.md, GEMINI.md, or prjct.mdc for Cursor) */
  contextFile: string

  /** Skills directory (e.g., ~/.claude/skills). Null for providers without skill support */
  skillsDir: string | null

  /** Commands directory relative to project (e.g., .claude/commands, .cursor/commands) */
  commandsDir: string

  /** Rules directory for project-level config (e.g., .cursor/rules). Only used by Cursor */
  rulesDir?: string

  /** Command file format */
  commandFormat: CommandFormat

  /** Settings file name (settings.json). Null if not applicable */
  settingsFile: string | null

  /** Project settings file (e.g., settings.local.json). Null if not applicable */
  projectSettingsFile: string | null

  /** Ignore file name (.claudeignore, .geminiignore, .cursorignore) */
  ignoreFile: string

  /** Whether config is project-level only (no global config directory) */
  isProjectLevel?: boolean

  /** URL for provider website */
  websiteUrl: string

  /** URL for provider documentation */
  docsUrl: string

  /** Default model for this provider (e.g., 'sonnet', '2.5-flash'). Null for multi-model IDEs */
  defaultModel: string | null

  /** Supported model identifiers. Empty array for multi-model IDEs (user selects model) */
  supportedModels: readonly string[]

  /** Minimum CLI version required. Null for non-CLI providers */
  minCliVersion: string | null
}

/**
 * Provider detection result
 */
export interface ProviderDetectionResult {
  /** Whether the provider CLI is installed */
  installed: boolean

  /** Provider version if installed */
  version?: string

  /** Path to the CLI executable */
  path?: string

  /** Warning if CLI version is below minimum requirement */
  versionWarning?: string
}

/**
 * Result of provider selection during setup
 */
export interface ProviderSelectionResult {
  /** Selected provider */
  provider: AIProviderName

  /** Detection details for CLI-based providers */
  detection: {
    claude: ProviderDetectionResult
    gemini: ProviderDetectionResult
    codex: ProviderDetectionResult
  }
}

/**
 * Result of Cursor project detection
 */
export interface CursorProjectDetection {
  /** Whether .cursor/ directory exists in project */
  detected: boolean

  /** Whether prjct router is installed */
  routerInstalled: boolean

  /** Project root path */
  projectRoot?: string
}

/**
 * Provider-aware branding configuration
 */
export interface ProviderBranding {
  /** Commit footer text */
  commitFooter: string

  /** Short signature */
  signature: string
}
