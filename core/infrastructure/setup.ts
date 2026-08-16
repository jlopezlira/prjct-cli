/**
 * Setup Module - Core installation logic
 *
 * Executes ALL setup needed for prjct-cli:
 * 1. Detect AI provider (Claude Code or Gemini CLI)
 * 2. Install CLI if missing
 * 3. Sync commands to provider's commands directory
 * 4. Install global config (CLAUDE.md or GEMINI.md)
 * 5. Save version in editors-config
 *
 * Supports multiple AI CLI agents:
 * - Claude Code: ~/.claude/commands/p.md, CLAUDE.md
 * - Gemini CLI: ~/.gemini/commands/p.toml, GEMINI.md
 *
 * This module is called from:
 * - core/index.js (on first CLI use)
 * - scripts/postinstall.js (if npm scripts are enabled)
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import chalk from 'chalk'
import { getTemplateContent } from '../agentic/template-loader'
import context7Service from '../services/context7-service'
import { dependencyValidator } from '../services/dependency-validator'
import { prjctDb } from '../storage/database'
import { LATEST_SCHEMA_VERSION } from '../storage/database/migrations'
import { getErrorMessage, isNotFoundError } from '../types/fs'
import type { AIProviderConfig, AIProviderName } from '../types/provider'
import { getTimeout } from '../utils/constants'
import { fileExists, readExistingFileOrEmpty } from '../utils/file-helper'
import { ensureGrokMcpServer } from '../utils/grok-mcp'
import log from '../utils/logger'
import { VERSION } from '../utils/version'
import {
  detectAllProviders,
  detectAntigravity,
  detectCodex,
  Providers,
  selectProvider,
} from './ai-provider'
import { installCodexSkill, verifyCodexPRouterReady } from './codex-skill'
import installer from './command-installer'
import editorsConfig from './editors-config'
import { installGrokSkill } from './grok-skill'
import { mergeWithMarkers } from './ide-project-installer'
import pathManager from './path-manager'
import { installStatusLine } from './statusline-installer'

interface ProviderSetupResult {
  provider: AIProviderName
  cliInstalled: boolean
  commandsAdded: number
  commandsUpdated: number
  configAction: string | null
}

interface SetupResults {
  provider: AIProviderName // Primary provider
  providers: ProviderSetupResult[] // All installed providers
  cliInstalled: boolean
  commandsAdded: number
  commandsUpdated: number
  configAction: string | null
}

async function installAICLI(provider: AIProviderConfig): Promise<boolean> {
  const packageName =
    provider.name === 'claude' ? '@anthropic-ai/claude-code' : '@google/gemini-cli'

  // PRJ-114: Check npm availability first
  if (!dependencyValidator.isAvailable('npm')) {
    console.log(`${chalk.yellow('⚠️  npm is not available')}`)
    console.log('')
    console.log(`${chalk.dim(`Install ${provider.displayName} using one of:`)}`)
    console.log(chalk.dim('  • Install Node.js: https://nodejs.org'))
    console.log(
      chalk.dim(
        `  • Use Homebrew: brew install ${provider.name === 'claude' ? 'claude' : 'gemini'}`
      )
    )
    console.log(chalk.dim(`  • Use npx directly: npx ${packageName}`))
    console.log('')
    return false
  }

  try {
    console.log(chalk.yellow(`📦 ${provider.displayName} not found. Installing...`))
    console.log('')
    // PRJ-111: Add timeout to npm install (default: 2 minutes, configurable via PRJCT_TIMEOUT_NPM_INSTALL)
    execFileSync('npm', ['install', '-g', packageName], {
      stdio: 'inherit',
      timeout: getTimeout('NPM_INSTALL'),
    })
    console.log('')
    console.log(`${chalk.green('✓')} ${provider.displayName} installed successfully`)
    console.log('')
    return true
  } catch (error) {
    const err = error as Error & { killed?: boolean; signal?: string }
    const isTimeout = err.killed && err.signal === 'SIGTERM'

    if (isTimeout) {
      console.log(chalk.yellow(`⚠️  Installation timed out for ${provider.displayName}`))
      console.log('')
      console.log(chalk.dim('The npm install took too long. Try:'))
      console.log(chalk.dim('  • Set PRJCT_TIMEOUT_NPM_INSTALL=300000 for 5 minutes'))
      console.log(chalk.dim(`  • Run manually: npm install -g ${packageName}`))
    } else {
      console.log(chalk.yellow(`⚠️  Failed to install ${provider.displayName}: ${err.message}`))
    }
    console.log('')
    console.log(chalk.dim('Alternative installation methods:'))
    console.log(chalk.dim(`  • npm:  npm install -g ${packageName}`))
    console.log(chalk.dim(`  • yarn: yarn global add ${packageName}`))
    console.log(chalk.dim(`  • pnpm: pnpm add -g ${packageName}`))
    console.log(
      chalk.dim(`  • brew: brew install ${provider.name === 'claude' ? 'claude' : 'gemini'}`)
    )
    console.log('')
    return false
  }
}

/**
 * Main setup function - installs for ALL detected providers
 */
export async function run(): Promise<SetupResults> {
  // Step 0: Detect all available providers
  const detection = await detectAllProviders()
  const selection = await selectProvider()

  const results: SetupResults = {
    provider: selection.provider,
    providers: [],
    cliInstalled: false,
    commandsAdded: 0,
    commandsUpdated: 0,
    configAction: null,
  }

  // Step 1: Install for each CLI-based provider (Claude, Gemini)
  // Note: Cursor is project-level and handled separately via installCursorProject()
  const cliProviderNames: ('claude' | 'gemini')[] = ['claude', 'gemini']

  for (const providerName of cliProviderNames) {
    const providerConfig = Providers[providerName]
    const providerDetection = detection[providerName]

    const providerResult: ProviderSetupResult = {
      provider: providerName,
      cliInstalled: false,
      commandsAdded: 0,
      commandsUpdated: 0,
      configAction: null,
    }

    if (!providerDetection.installed) {
      // Only prompt to install the primary (selected) provider
      if (providerName === selection.provider) {
        const installed = await installAICLI(providerConfig)
        if (installed) {
          providerResult.cliInstalled = true
          results.cliInstalled = true
        } else {
          throw new Error(`${providerConfig.displayName} installation failed`)
        }
      } else {
        // Skip non-primary providers that aren't installed
        continue
      }
    }

    // Step 2: Install commands and config for this provider
    if (providerName === 'claude') {
      const providerDetected = await installer.detectActiveProvider()

      if (providerDetected) {
        // Sync commands
        const syncResult = await installer.syncCommands()
        if (syncResult.success) {
          providerResult.commandsAdded = syncResult.added
          providerResult.commandsUpdated = syncResult.updated
          results.commandsAdded += syncResult.added
          results.commandsUpdated += syncResult.updated
        }

        // Install global configuration
        const configResult = await installer.installGlobalConfig()
        if (configResult.success) {
          providerResult.configAction = configResult.action
          if (!results.configAction) {
            results.configAction = configResult.action
          }
        }

        // Install status line (Claude only)
        await installStatusLine()

        // Install and verify Context7 MCP (required for coding workflows)
        await context7Service.ensureReady()
      }
    } else if (providerName === 'gemini') {
      // Gemini provider - install router and global config
      const geminiInstalled = await installGeminiRouter()
      if (geminiInstalled) {
        providerResult.commandsAdded = 1
        results.commandsAdded += 1
      }

      const geminiConfigResult = await installGeminiGlobalConfig()
      if (geminiConfigResult.success) {
        providerResult.configAction = geminiConfigResult.action
      }
    }

    results.providers.push(providerResult)
  }

  // Step 2b: Install for Antigravity if detected (separate from CLI providers)
  const antigravityDetection = await detectAntigravity()
  if (antigravityDetection.installed) {
    const antigravityResult = await installAntigravitySkill()
    if (antigravityResult.success) {
      console.log(`   ${chalk.green('✓')} Antigravity skill installed`)
    }
  }

  // Step 2c: Install for Codex if detected
  const codexDetection = await detectCodex()
  if (codexDetection.installed) {
    const codexResult = await installCodexSkill()
    if (!codexResult.success) {
      throw new Error('Codex skill installation failed')
    }

    const codexRouter = await verifyCodexPRouterReady({ autoRepair: true })
    if (!codexRouter.verified) {
      throw new Error(codexRouter.message || 'Codex p. router verification failed')
    }

    console.log(`   ${chalk.green('✓')} Codex skill installed`)
    console.log(`   ${chalk.green('✓')} Codex p. router ready`)
  }

  // Step 2d: Install for Grok Build if detected (~/.grok or `grok` on PATH)
  try {
    const { detectAgentRuntimes } = await import('./agent-runtime-registry')
    const runtimes = await detectAgentRuntimes(process.cwd())
    const grokDetected = runtimes.some((r) => r.runtime.id === 'grok' && r.detected)
    if (grokDetected) {
      const { installGrokPlugin } = await import('../utils/grok-plugin')
      const grokMcp = await ensureGrokMcpServer()
      const grokSkill = await installGrokSkill()
      const grokPlugin = await installGrokPlugin()
      if (grokSkill.success || grokPlugin.success) {
        console.log(
          `   ${chalk.green('✓')} Grok skill/plugin ${grokSkill.action ?? 'ready'}${
            grokMcp.changed ? ' + MCP' : ''
          }${grokPlugin.changed ? ' + plugin' : ''}`
        )
      }
    }
    const opencodeDetected = runtimes.some((r) => r.runtime.id === 'opencode' && r.detected)
    if (opencodeDetected) {
      const { ensureOpenCodeMcpServer } = await import('../utils/opencode-mcp')
      const oc = await ensureOpenCodeMcpServer()
      console.log(
        `   ${chalk.green('✓')} OpenCode MCP ${oc.changed ? 'installed' : 'ready'} → ${oc.path}`
      )
    }
    const piDetected = runtimes.some((r) => r.runtime.id === 'pi' && r.detected)
    if (piDetected) {
      const { installPiSkill } = await import('./pi-skill')
      const pi = await installPiSkill()
      if (pi.success) {
        console.log(
          `   ${chalk.green('✓')} Pi skill ${pi.action ?? 'ready'}${pi.path ? ` → ${pi.path}` : ''}`
        )
      }
    }
  } catch {
    /* best-effort — install.ts is the primary wire path */
  }

  // Step 3: Save version in editors-config
  await editorsConfig.saveConfig(VERSION, await installer.getInstallPath(), selection.provider)

  // Step 4: Migrate existing projects to add cliVersion
  await migrateProjectsCliVersion()

  // Show results for all providers
  for (const providerResult of results.providers) {
    showResults(providerResult, Providers[providerResult.provider])
  }

  return results
}

/**
 * Cleanup legacy Gemini router (p.toml) if it exists.
 * Router is deprecated — skills handle workflows natively.
 */
async function installGeminiRouter(): Promise<boolean> {
  try {
    const geminiCommandsDir = path.join(os.homedir(), '.gemini', 'commands')
    const routerDest = path.join(geminiCommandsDir, 'p.toml')

    // Clean up legacy router if it exists
    try {
      await fs.unlink(routerDest)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false // Already gone
      }
      throw error
    }
  } catch (error) {
    log.warn(`Gemini router cleanup warning: ${getErrorMessage(error)}`)
    return false
  }
}

/**
 * Install or update global GEMINI.md configuration
 */
async function installGeminiGlobalConfig(): Promise<{ success: boolean; action: string | null }> {
  try {
    const geminiDir = path.join(os.homedir(), '.gemini')
    const globalConfigPath = path.join(geminiDir, 'GEMINI.md')
    await fs.mkdir(geminiDir, { recursive: true })

    // Read template content from the package bundle or synthesize it from the
    // editor-surfaces SSOT in source checkouts.
    const templateContent = getTemplateContent('global/GEMINI.md')
    if (!templateContent) {
      log.warn('Gemini global config template not found')
      return { success: false, action: null }
    }

    const existingFile = await readExistingFileOrEmpty(globalConfigPath)

    const startMarker = '<!-- prjct:start - DO NOT REMOVE THIS MARKER -->'
    const endMarker = '<!-- prjct:end - DO NOT REMOVE THIS MARKER -->'

    const merged = mergeWithMarkers(
      existingFile.exists ? existingFile.content : '',
      templateContent,
      startMarker,
      endMarker
    )

    await fs.writeFile(globalConfigPath, merged.content, 'utf-8')
    return { success: true, action: merged.action }
  } catch (error) {
    log.warn(`Gemini config warning: ${getErrorMessage(error)}`)
    return { success: false, action: null }
  }
}

// Antigravity Installation (Skills-based)

/**
 * Install prjct as a skill for Google Antigravity
 *
 * Antigravity uses SKILL.md files in ~/.gemini/antigravity/skills/
 * This is the recommended integration method (not MCP).
 */
async function installAntigravitySkill(): Promise<{
  success: boolean
  action: string | null
}> {
  try {
    const antigravitySkillsDir = path.join(os.homedir(), '.gemini', 'antigravity', 'skills')
    const prjctSkillDir = path.join(antigravitySkillsDir, 'prjct')
    const skillMdPath = path.join(prjctSkillDir, 'SKILL.md')
    await fs.mkdir(prjctSkillDir, { recursive: true })

    const skillExists = await fileExists(skillMdPath)

    // Read template content from the package bundle or synthesize it from the
    // editor-surfaces SSOT in source checkouts.
    const templateContent = getTemplateContent('antigravity/SKILL.md')
    if (!templateContent) {
      log.warn('Antigravity SKILL.md template not found')
      return { success: false, action: null }
    }

    // Write SKILL.md
    await fs.writeFile(skillMdPath, templateContent, 'utf-8')

    return { success: true, action: skillExists ? 'updated' : 'created' }
  } catch (error) {
    log.warn(`Antigravity skill warning: ${getErrorMessage(error)}`)
    return { success: false, action: null }
  }
}

/**
 * Migrate existing projects to add cliVersion field
 * This clears the status line warning after npm update
 *
 * Runs once per upgrade over EVERY directory under the global projects
 * dir — which on dev machines accumulates tens of thousands of
 * test-created entries. Opening SQLite per dir (`getDoc` runs the
 * migration check + a kv query, ~3ms each) made upgrades take up to a
 * minute. A `.cli-version` marker file per dir records "reconciled with
 * VERSION + schema": the steady state is one tiny fs read per dir (~µs),
 * and the DB is only opened for dirs whose marker is missing or stale.
 */
const CLI_VERSION_MARKER = '.cli-version'
const CLI_PROJECT_RECONCILIATION_MARKER = `${VERSION}\nschema=${LATEST_SCHEMA_VERSION}`

async function migrateProjectsCliVersion(): Promise<void> {
  try {
    const projectsDir = pathManager.globalProjectsDir

    if (!(await fileExists(projectsDir))) {
      return
    }

    const projectDirs = (await fs.readdir(projectsDir, { withFileTypes: true }))
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)

    const migratedProjectIds: string[] = []

    for (const projectId of projectDirs) {
      try {
        const markerPath = path.join(projectsDir, projectId, CLI_VERSION_MARKER)
        const marker = await fs.readFile(markerPath, 'utf-8').catch(() => '')
        if (marker.trim() === CLI_PROJECT_RECONCILIATION_MARKER) {
          continue
        }

        const project = prjctDb.getDoc<Record<string, unknown>>(projectId, 'project')
        if (project && project.cliVersion !== VERSION) {
          project.cliVersion = VERSION
          prjctDb.setDoc(projectId, 'project', project)
          migratedProjectIds.push(projectId)
        }

        // Mark even doc-less dirs (test artifacts) so the next upgrade
        // skips them with a single read instead of a DB open.
        await fs.writeFile(markerPath, CLI_PROJECT_RECONCILIATION_MARKER, 'utf-8').catch(() => {})
      } catch {
        // Skip projects with database issues
      }
    }

    if (migratedProjectIds.length > 0) {
      console.log(
        `   ${chalk.green('✓')} Updated ${migratedProjectIds.length} project(s) to v${VERSION}`
      )
    }
  } catch (error) {
    // Silently fail if projects directory doesn't exist
    if (!isNotFoundError(error)) {
      // Log unexpected errors but don't crash - migration is optional
      log.warn(`Migration warning: ${getErrorMessage(error)}`)
    }
  }
}

/**
 * Show setup results for a single provider
 */
function showResults(results: ProviderSetupResult, provider: AIProviderConfig): void {
  console.log('')

  if (results.cliInstalled) {
    console.log(`   ${chalk.green('✓')} ${provider.displayName} CLI installed`)
  } else {
    console.log(`   ${chalk.green('✓')} ${provider.displayName} CLI found`)
  }

  const totalCommands = results.commandsAdded + results.commandsUpdated
  if (totalCommands > 0) {
    const parts: string[] = []
    if (results.commandsAdded > 0) parts.push(`${results.commandsAdded} new`)
    if (results.commandsUpdated > 0) parts.push(`${results.commandsUpdated} updated`)
    console.log(`   ${chalk.green('✓')} Commands synced (${parts.join(', ')})`)
  } else {
    console.log(`   ${chalk.green('✓')} Commands up to date`)
  }

  if (results.configAction === 'created') {
    console.log(`   ${chalk.green('✓')} Global config created (${provider.contextFile})`)
  } else if (results.configAction === 'updated') {
    console.log(`   ${chalk.green('✓')} Global config updated (${provider.contextFile})`)
  } else if (results.configAction === 'appended') {
    console.log(`   ${chalk.green('✓')} Global config merged (${provider.contextFile})`)
  }

  console.log('')
}

// Auto-execute when run directly (for bun/node CLI usage)
// This enables: bun core/infrastructure/setup.ts
const isDirectRun = process.argv[1]?.includes('setup.ts') || process.argv[1]?.includes('setup.js')
if (isDirectRun) {
  run().catch((error) => {
    console.error('Setup error:', error.message)
    process.exit(1)
  })
}
