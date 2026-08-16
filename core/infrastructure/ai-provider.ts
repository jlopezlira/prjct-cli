/**
 * AI Provider - Multi-agent support for prjct-cli
 *
 * Supports multiple AI coding agents with a unified abstraction layer:
 * - Claude Code (CLI): ~/.claude/, CLAUDE.md, .md commands
 * - Gemini CLI (CLI): ~/.gemini/, GEMINI.md, .toml commands
 * - OpenAI Codex (CLI): ~/.codex/, AGENTS.md
 * - Cursor IDE (GUI): .cursor/ (project-level), .mdc rules
 *
 * Key differences:
 * - CLI providers (Claude/Gemini/Codex) have global config directories
 * - Cursor is project-level only
 *
 * Benchmark focus (2026-08): Claude Code, Codex CLI, Gemini CLI, OpenCode,
 * Cursor, Cline, Grok Build, Pi, and Kimi CLI.
 *
 * @see https://geminicli.com/docs/cli/gemini-md/
 * @see https://geminicli.com/docs/cli/skills/
 * @see https://cursor.com/docs/context/rules
 */

import path from 'node:path'
import { PROVIDER_SPAWN_TIMEOUT_MS } from '../constants/timings'
import { compareSemver, getDefaultModel, getSupportedModels } from '../schemas/model'
import type {
  AIProviderConfig,
  AIProviderName,
  ProviderBranding,
  ProviderDetectionResult,
  ProviderSelectionResult,
} from '../types/provider'

import { execAsync } from '../utils/exec'
import { fileExists } from '../utils/file-helper'
import { readProviderCache, writeProviderCache } from '../utils/provider-cache'
import { whichAsync } from '../utils/which'
import { resolveUserPath } from './user-home'

// Provider Configurations

/**
 * Claude Code provider configuration
 */
export const ClaudeProvider: AIProviderConfig = {
  name: 'claude',
  displayName: 'Claude Code',
  cliCommand: 'claude',
  get configDir() {
    return resolveUserPath('.claude')
  },
  contextFile: 'CLAUDE.md',
  get skillsDir() {
    return resolveUserPath('.claude', 'skills')
  },
  commandsDir: '.claude/commands',
  commandFormat: 'md',
  settingsFile: 'settings.json',
  projectSettingsFile: 'settings.local.json',
  ignoreFile: '.claudeignore',
  websiteUrl: 'https://www.anthropic.com/claude',
  docsUrl: 'https://docs.anthropic.com/claude-code',
  get defaultModel() {
    return getDefaultModel(this.name)
  },
  get supportedModels() {
    return getSupportedModels(this.name)
  },
  minCliVersion: '1.0.0',
}

/**
 * Gemini CLI provider configuration
 */
export const GeminiProvider: AIProviderConfig = {
  name: 'gemini',
  displayName: 'Gemini CLI',
  cliCommand: 'gemini',
  get configDir() {
    return resolveUserPath('.gemini')
  },
  contextFile: 'GEMINI.md',
  get skillsDir() {
    return resolveUserPath('.gemini', 'skills')
  },
  commandsDir: '.gemini/commands',
  commandFormat: 'toml',
  settingsFile: 'settings.json',
  projectSettingsFile: 'settings.json',
  ignoreFile: '.geminiignore',
  websiteUrl: 'https://geminicli.com',
  docsUrl: 'https://geminicli.com/docs',
  get defaultModel() {
    return getDefaultModel(this.name)
  },
  get supportedModels() {
    return getSupportedModels(this.name)
  },
  minCliVersion: '1.0.0',
}

/**
 * Google Antigravity provider configuration
 *
 * An "agent-first" platform that manages multiple agents.
 * Config is located in ~/.gemini/antigravity/
 * Uses SKILL.md for skills and mcp_config.json for tools.
 */
const AntigravityProvider: AIProviderConfig = {
  name: 'antigravity',
  displayName: 'Google Antigravity',
  cliCommand: null, // Not a CLI command, but a platform/app
  get configDir() {
    return resolveUserPath('.gemini', 'antigravity')
  },
  contextFile: 'ANTIGRAVITY.md',
  get skillsDir() {
    return resolveUserPath('.gemini', 'antigravity', 'global_skills')
  },
  commandsDir: '.agent/skills', // Antigravity uses .agent/skills in projects
  commandFormat: 'md', // Uses SKILL.md
  settingsFile: 'mcp_config.json', // Uses MCP config
  projectSettingsFile: null,
  ignoreFile: '.agentignore', // Assumed
  websiteUrl: 'https://gemini.google.com/app/antigravity',
  docsUrl: 'https://gemini.google.com/app/antigravity',
  get defaultModel() {
    return getDefaultModel(this.name)
  },
  get supportedModels() {
    return getSupportedModels(this.name)
  },
  minCliVersion: null,
}

/**
 * Cursor IDE provider configuration
 *
 * Key differences from Claude/Gemini:
 * - NOT a CLI (GUI app, VS Code fork)
 * - No global config directory (~/.cursor/ doesn't exist)
 * - Project-level config only (.cursor/rules/, .cursor/commands/)
 * - User can select any model (GPT, Claude, Gemini, DeepSeek, etc.)
 *
 * @see https://cursor.com/docs/context/rules
 */
export const CursorProvider: AIProviderConfig = {
  name: 'cursor',
  displayName: 'Cursor IDE',
  cliCommand: null, // Not a CLI - GUI app
  configDir: null, // No global config directory
  contextFile: 'prjct.mdc', // Uses .mdc format with frontmatter
  skillsDir: null, // No skills directory
  commandsDir: '.cursor/commands',
  rulesDir: '.cursor/rules', // Cursor-specific: rules directory
  commandFormat: 'md',
  settingsFile: null,
  projectSettingsFile: null,
  ignoreFile: '.cursorignore',
  isProjectLevel: true, // Config is project-level only
  websiteUrl: 'https://cursor.com',
  docsUrl: 'https://cursor.com/docs',
  get defaultModel() {
    return getDefaultModel(this.name)
  },
  get supportedModels() {
    return getSupportedModels(this.name)
  },
  minCliVersion: null,
}

/**
 * OpenAI Codex CLI provider configuration
 *
 * Agent-first CLI that uses AGENTS.md for project context.
 * Skills live in .agents/skills/ (project) or ~/.codex/skills/ (global).
 *
 * @see https://github.com/openai/codex
 */
const CodexProvider: AIProviderConfig = {
  name: 'codex',
  displayName: 'OpenAI Codex',
  cliCommand: 'codex',
  get configDir() {
    return resolveUserPath('.codex')
  },
  contextFile: 'AGENTS.md',
  get skillsDir() {
    return resolveUserPath('.codex', 'skills')
  },
  commandsDir: '.agents/skills',
  commandFormat: 'md',
  settingsFile: null,
  projectSettingsFile: null,
  ignoreFile: '.codexignore',
  websiteUrl: 'https://openai.com/codex',
  docsUrl: 'https://github.com/openai/codex',
  get defaultModel() {
    return getDefaultModel(this.name)
  },
  get supportedModels() {
    return getSupportedModels(this.name)
  },
  minCliVersion: null,
}

/**
 * All available providers
 */
export const Providers: Record<AIProviderName, AIProviderConfig> = {
  claude: ClaudeProvider,
  gemini: GeminiProvider,
  cursor: CursorProvider,
  antigravity: AntigravityProvider,
  codex: CodexProvider,
}

// Provider Detection

/**
 * Check if a CLI command is available (macOS / Linux / Windows).
 */
async function whichCommand(command: string): Promise<string | null> {
  const found = await whichAsync(command)
  if (found) return found
  if (process.platform === 'win32') {
    return whichAsync(`${command}.cmd`)
  }
  return null
}

/**
 * Get CLI version
 */
async function getCliVersion(command: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`${command} --version`, {
      timeout: PROVIDER_SPAWN_TIMEOUT_MS,
    })
    // Extract version number from output (e.g., "claude 1.0.0" -> "1.0.0")
    const match = stdout.match(/\d+\.\d+\.\d+/)
    return match ? match[0] : stdout.trim()
  } catch {
    return null
  }
}

/**
 * Detect if a specific CLI-based provider is installed.
 * Cursor is a project-level IDE (no CLI binary), so this returns
 * `installed: false` and project-level detection lives elsewhere.
 */
export async function detectProvider(provider: AIProviderName): Promise<ProviderDetectionResult> {
  const config = Providers[provider]

  // Cursor is not a CLI - return not installed for CLI detection
  if (!config.cliCommand) {
    return { installed: false }
  }

  const cliPath = await whichCommand(config.cliCommand)

  if (!cliPath) {
    return { installed: false }
  }

  const version = await getCliVersion(config.cliCommand)
  const versionWarning = validateCliVersion(provider, version || undefined)

  return {
    installed: true,
    version: version || undefined,
    path: cliPath,
    versionWarning: versionWarning || undefined,
  }
}

/**
 * Validate that a detected CLI version meets the provider's minimum requirement.
 * Returns a warning message if the version is below minimum, or null if OK.
 */
export function validateCliVersion(
  provider: AIProviderName,
  version: string | undefined
): string | null {
  const config = Providers[provider]
  if (!config.minCliVersion || !version) return null

  if (compareSemver(version, config.minCliVersion) < 0) {
    return `⚠️ ${config.displayName} v${version} is below minimum v${config.minCliVersion}. Some features may not work correctly.`
  }
  return null
}

/**
 * Detect all available CLI-based providers
 * Results are cached to disk with a 10-minute TTL to avoid redundant shell spawns.
 * Pass refresh=true to force re-detection.
 */
export async function detectAllProviders(refresh = false): Promise<{
  claude: ProviderDetectionResult
  gemini: ProviderDetectionResult
  codex: ProviderDetectionResult
}> {
  if (!refresh) {
    const cached = await readProviderCache()
    if (cached) return cached
  }

  const [claude, gemini, codexDetection] = await Promise.all([
    detectProvider('claude'),
    detectProvider('gemini'),
    detectCodex(),
  ])
  const codex: ProviderDetectionResult = {
    installed: codexDetection.installed,
  }
  const detection = { claude, gemini, codex }

  await writeProviderCache(detection).catch(() => {})

  return detection
}

/**
 * Get the active provider based on detection or configuration.
 *
 * Priority:
 * 1. Check project config for saved provider preference
 * 2. Auto-detect single installed provider
 * 3. Prefer Claude when several CLI providers are installed
 */
export async function getActiveProvider(
  projectProvider?: AIProviderName
): Promise<AIProviderConfig> {
  if (projectProvider && Providers[projectProvider]) {
    return Providers[projectProvider]
  }

  const detection = await detectAllProviders()

  const installed = [
    detection.claude.installed ? 'claude' : null,
    detection.gemini.installed ? 'gemini' : null,
    detection.codex.installed ? 'codex' : null,
  ].filter(Boolean)

  if (installed.length === 1) {
    return Providers[installed[0] as AIProviderName]
  }

  if (detection.claude.installed) return ClaudeProvider
  if (detection.gemini.installed) return GeminiProvider
  if (detection.codex.installed) return CodexProvider

  // Historical fallback for callers that expect a provider object.
  return ClaudeProvider
}

// Provider Branding

/**
 * Get provider-specific branding
 */
export function getProviderBranding(provider: AIProviderName): ProviderBranding {
  // Generic commit footer for all providers
  const commitFooter = `Generated with [p/](https://www.prjct.app/)`

  const signatures: Record<AIProviderName, string> = {
    claude: '⚡ prjct + Claude',
    gemini: '⚡ prjct + Gemini',
    cursor: '⚡ prjct + Cursor',
    antigravity: '⚡ prjct + Antigravity',
    codex: '⚡ prjct + Codex',
  }

  return {
    commitFooter,
    signature: signatures[provider] || '⚡ prjct',
  }
}

// Cursor Project Detection

/**
 * Detect if a project is configured for Cursor IDE
 *
 * Cursor has NO global config (~/.cursor/ doesn't exist).
 * Detection is based on project-level .cursor/ directory.
 */

// Antigravity Detection

import type {
  AntigravityDetection,
  CodexDetection,
  KimiDetection,
} from '../types/infrastructure.js'

// AntigravityDetection type moved to core/types/infrastructure.ts

/**
 * Detect if Google Antigravity is installed
 *
 * Antigravity is NOT a CLI command - it's a GUI platform.
 * Detection is based on ~/.gemini/antigravity/ directory.
 */
export async function detectAntigravity(): Promise<AntigravityDetection> {
  const configPath = AntigravityProvider.configDir
  if (!configPath) {
    return { installed: false, skillInstalled: false }
  }

  const skillPath = path.join(configPath, 'skills', 'prjct', 'SKILL.md')
  const [installed, skillInstalled] = await Promise.all([
    fileExists(configPath),
    fileExists(skillPath),
  ])

  return {
    installed,
    skillInstalled,
    configPath: installed ? configPath : undefined,
  }
}

// Codex Detection

// CodexDetection type moved to core/types/infrastructure.ts

/**
 * Detect if OpenAI Codex CLI is installed
 *
 * Detection: check for `codex` CLI command or ~/.codex/ directory.
 */
export async function detectCodex(): Promise<CodexDetection> {
  const configPath = CodexProvider.configDir
  if (!configPath) {
    return { installed: false, skillInstalled: false }
  }

  const cliPath = await whichCommand('codex')
  const skillPath = path.join(configPath, 'skills', 'prjct', 'SKILL.md')
  const skillInstalled = await fileExists(skillPath)

  // Binary on PATH is the primary signal, but hooks/daemon run in
  // non-interactive shells where the user's PATH (nvm, app-managed
  // installs) isn't loaded — `~/.codex/auth.json` is a logged-in Codex
  // install and counts as evidence too. A bare leftover ~/.codex/
  // directory alone still does NOT count and won't block other providers.
  const installed = !!cliPath || (await fileExists(path.join(configPath, 'auth.json')))

  return {
    installed,
    skillInstalled,
    configPath: installed ? configPath : undefined,
  }
}

// Kimi CLI Detection

/**
 * Detect if Moonshot's Kimi Code CLI is installed.
 *
 * Detection: the `kimi` CLI command on PATH, or a `~/.kimi-code/` config
 * directory (Kimi Code writes config.toml/mcp.json there). The legacy
 * `~/.kimi/` directory still counts as a fallback signal. A configured
 * install counts even when PATH is minimal (hooks/daemon shells).
 */
export async function detectKimi(): Promise<KimiDetection> {
  const kimiCodeDir = resolveUserPath('.kimi-code')
  const legacyDir = resolveUserPath('.kimi')
  const [cliPath, kimiCodePresent, legacyPresent] = await Promise.all([
    whichCommand('kimi'),
    fileExists(kimiCodeDir),
    fileExists(legacyDir),
  ])
  const installed = !!cliPath || kimiCodePresent || legacyPresent
  const configDir = kimiCodePresent || !legacyPresent ? kimiCodeDir : legacyDir
  return {
    installed,
    configPath: installed ? configDir : undefined,
  }
}

// Provider Selection (for setup)

/**
 * Determine which provider to use during setup
 * Returns selection result with detection details
 */
export async function selectProvider(): Promise<ProviderSelectionResult> {
  const detection = await detectAllProviders()

  const provider = detection.claude.installed
    ? 'claude'
    : detection.gemini.installed
      ? 'gemini'
      : detection.codex.installed
        ? 'codex'
        : 'claude'
  return { provider, detection }
}
