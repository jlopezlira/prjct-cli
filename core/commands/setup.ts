/**
 * Setup Commands: start, setup, login, installStatusLine, showAsciiArt
 */

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import chalk from 'chalk'
import commandInstaller from '../infrastructure/command-installer'
import configManager from '../infrastructure/config-manager'
import pathManager from '../infrastructure/path-manager'
import authConfig, { DEFAULT_API_URL, DEFAULT_WEB_URL } from '../sync/auth-config'
import {
  buildCliLoginSearchParams,
  buildExchangeBody,
  generatePkceMaterial,
  parseMintedKeyResponse,
  parsePkceCallback,
} from '../sync/cli-pkce'
import { syncClient } from '../sync/sync-client'
import syncManager from '../sync/sync-manager'
import type { MdOption } from '../types/cli'
import type { CommandResult, SetupOptions } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import type { AntigravityDetection, CodexDetection } from '../types/infrastructure'
import type { AIProviderConfig } from '../types/provider'
import { execAsync } from '../utils/exec'
import { fileExists, readJson, writeJson } from '../utils/file-helper'
import { failFromError } from '../utils/md-aware'
import out from '../utils/output'
import { VERSION } from '../utils/version'
import { PrjctCommandsBase } from './base'
import { setupMcpServers as configureDefaultMcpServers } from './setup/mcp'

export class SetupCommands extends PrjctCommandsBase {
  /**
   * Manage cloud authentication (login, logout, status)
   */
  async auth(action: string | null = null, options: MdOption = {}): Promise<CommandResult> {
    const subcommand = action?.split(' ')[0] || 'status'

    switch (subcommand) {
      case 'login': {
        if (!options.md) out.fail('Manual token login is not supported. Run prjct login.')
        return {
          success: false,
          message: options.md
            ? '## Error\nManual token login is not supported. Run `prjct login`.'
            : '',
        }
      }

      case 'logout': {
        await authConfig.clearAuth()
        // Refresh the long-lived daemon so it drops the cleared session
        // instead of reporting stale "authenticated" until a manual restart
        // (mem_2880).
        await this.refreshDaemonAuth()
        if (!options.md) out.done('Logged out. Auth credentials cleared')
        return {
          success: true,
          message: options.md ? '## Auth\n- **Status**: Logged out' : '',
        }
      }

      default: {
        const status = await authConfig.getStatus()
        if (options.md) {
          return {
            success: true,
            message: status.authenticated
              ? `## Auth Status\n- **Authenticated**: Yes\n- **Email**: ${status.email || 'N/A'}\n- **Token**: stored securely\n- **Last auth**: ${status.lastAuth || 'N/A'}`
              : '## Auth Status\n- **Authenticated**: No\n- Run `prjct login` to connect',
          }
        }
        if (status.authenticated) {
          out.box(
            'Auth Status',
            `Email:  ${status.email || 'N/A'}\nToken:  stored securely\nSince:  ${status.lastAuth || 'N/A'}`
          )
        } else {
          out.info('Not authenticated')
          out.info(`Run ${chalk.cyan('prjct login')} to connect`)
        }
        return { success: true, message: '' }
      }
    }
  }

  /**
   * Browser-based login via PKCE S256 (flow=pkce-v1).
   * Opens the SPA, user approves the device, callback carries only code+state;
   * the CLI exchanges the code for a device key (never a bearer in the URL).
   */
  async login(options: { md?: boolean } = {}): Promise<CommandResult> {
    const status = await authConfig.getStatus()
    if (status.authenticated) {
      if (!options.md) {
        out.box('Already Authenticated', `Email:  ${status.email}\nToken:  stored securely`)
        out.info(`Run ${chalk.cyan('prjct logout')} first to re-authenticate`)
      }
      return {
        success: true,
        message: options.md
          ? `## Already Authenticated\n- **Email**: ${status.email}\n- **Token**: stored securely\n\nRun \`prjct logout\` first to re-authenticate.`
          : '',
      }
    }

    const webUrl = process.env.PRJCT_WEB_URL || DEFAULT_WEB_URL
    const apiUrl = process.env.PRJCT_API_URL || DEFAULT_API_URL
    // Verifier/state only in this process for the lifetime of one login.
    const pkce = generatePkceMaterial()
    const loginState = { settled: false, listenPort: 0 }

    return new Promise<CommandResult>((resolve) => {
      const finish = (result: CommandResult) => {
        if (loginState.settled) return
        loginState.settled = true
        resolve(result)
      }

      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const noStore = {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        }

        if (url.pathname === '/callback') {
          const parsed = parsePkceCallback(url.searchParams, pkce.state)
          if (!parsed.ok) {
            // Invalid/legacy params: respond but keep listening so the user can retry
            // from the browser without restarting the CLI (except success closes).
            const statusCode = parsed.reason === 'legacy-bearer' ? 400 : 400
            res.writeHead(statusCode, noStore)
            res.end(this.buildErrorPage(parsed.message))
            if (parsed.reason === 'legacy-bearer') {
              if (!options.md) {
                out.warn(parsed.message)
                out.info(`Update prjct-cli-app or open the login URL with flow=pkce-v1`)
              }
            }
            return
          }

          const { verified, failureMessage, email } = await (async () => {
            try {
              const body = buildExchangeBody({
                code: parsed.code,
                state: parsed.state,
                codeVerifier: pkce.codeVerifier,
                deviceId: await authConfig.getDeviceId(),
                port: loginState.listenPort,
              })
              const exchangeRes = await fetch(`${apiUrl}/auth/cli/exchange`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  accept: 'application/json',
                },
                body: JSON.stringify(body),
              })
              if (!exchangeRes.ok) {
                return {
                  verified: false,
                  failureMessage: `Exchange failed (${exchangeRes.status})`,
                  email: '',
                }
              }
              const minted = parseMintedKeyResponse(await exchangeRes.json())
              if (!minted) {
                return { verified: false, failureMessage: 'Malformed exchange response', email: '' }
              }
              await authConfig.saveAuth(minted.apiKey, minted.userId, minted.email)
              await authConfig.write({ apiUrl })
              const connected = await syncClient.testConnection()
              if (!connected) {
                await authConfig.clearAuth()
                return {
                  verified: false,
                  failureMessage: 'Could not verify credentials with prjct Cloud',
                  email: minted.email,
                }
              }
              return { verified: true, failureMessage: '', email: minted.email }
            } catch (error) {
              await authConfig.clearAuth()
              return {
                verified: false,
                failureMessage:
                  error instanceof Error ? error.message : 'Could not store credentials securely',
                email: '',
              }
            }
          })()

          if (verified) {
            res.writeHead(200, noStore)
            res.end(this.buildSuccessPage(email))
          } else {
            res.writeHead(401, noStore)
            res.end(this.buildErrorPage(failureMessage))
          }

          server.close()

          if (verified) {
            if (!options.md) {
              out.step(3, 3, 'Connected')
              out.stop()
              out.box(
                'Authentication Complete',
                `Email:  ${email}\nToken:  stored securely\nStatus: Connected`
              )
            }

            // Refresh the long-lived daemon FIRST so it picks up the new
            // token before anything routes through it (mem_2880).
            await this.refreshDaemonAuth()
            await this.autoSync()

            finish({
              success: true,
              message: options.md
                ? `## Authenticated\n- **Email**: ${email}\n- **Token**: stored securely`
                : '',
            })
          } else {
            if (!options.md) out.fail(`Authentication failed: ${failureMessage}`)
            finish({
              success: false,
              message: options.md ? `## Error\nAuthentication failed: ${failureMessage}` : '',
            })
          }
          return
        }

        res.writeHead(404, noStore)
        res.end('Not found')
      })

      server.listen(0, '127.0.0.1', async () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') {
          server.close()
          if (!options.md) out.fail('Failed to start callback server')
          finish({
            success: false,
            message: options.md ? '## Error\nFailed to start callback server' : '',
          })
          return
        }

        loginState.listenPort = addr.port
        const deviceId = await authConfig.getDeviceId()
        const hostname = await authConfig.getHostname()
        const loginParams = buildCliLoginSearchParams({
          port: loginState.listenPort,
          deviceId,
          hostname,
          state: pkce.state,
          codeChallenge: pkce.codeChallenge,
        })
        // Sanitized display: never print state/challenge (identifying params).
        const displayUrl = `${webUrl}/auth/cli?flow=pkce-v1&port=${loginState.listenPort}`
        const loginUrl = `${webUrl}/auth/cli?${loginParams.toString()}`

        out.step(1, 3, 'Opening browser...')
        out.stop()
        out.info(chalk.dim(displayUrl))

        const platform = process.platform
        const openCmd =
          platform === 'darwin'
            ? `open "${loginUrl}"`
            : platform === 'win32'
              ? `start "" "${loginUrl}"`
              : `xdg-open "${loginUrl}"`

        try {
          await execAsync(openCmd)
        } catch {
          out.warn('Could not open browser automatically')
          out.info(
            `Visit the URL printed by your terminal session (full URL not echoed for safety)`
          )
          // Still need the full URL when auto-open fails — print once without
          // labeling it as a secret dump; user must complete login.
          out.info(loginUrl)
        }

        out.step(2, 3, 'Waiting for authentication...')
      })

      // Timeout after 5 minutes
      setTimeout(
        () => {
          if (loginState.settled) return
          server.close()
          out.stop()
          if (!options.md) {
            out.fail('Authentication timed out')
            out.info(`Run ${chalk.cyan('prjct login')} to try again`)
          }
          finish({
            success: false,
            message: options.md
              ? '## Error\nAuthentication timed out. Run `prjct login` to try again.'
              : '',
          })
        },
        5 * 60 * 1000
      )
    })
  }

  /**
   * Logout — clear auth credentials
   */
  async logout(): Promise<CommandResult> {
    await authConfig.clearAuth()
    out.done('Logged out')
    return { success: true, message: '' }
  }

  /**
   * Auto-sync pending events if inside a prjct project
   */
  /**
   * Bounce the long-lived daemon after an auth change (login/logout) so it
   * re-reads the secure token and reopens realtime with fresh credentials.
   * Best-effort: a no-op when no daemon runs, and never throws — the auth
   * change already succeeded regardless of the daemon's state (mem_2880).
   */
  private async refreshDaemonAuth(): Promise<void> {
    try {
      const { restartDaemon } = await import('../daemon/client')
      await restartDaemon()
    } catch {
      // Best-effort: worst case the user runs `prjct daemon restart`.
    }
  }

  private async autoSync(): Promise<void> {
    try {
      const config = await configManager.readConfig(process.cwd()).catch(() => null)
      const projectId = config?.projectId
      if (!projectId) return

      // Local-first gate: only sync projects the user explicitly linked
      // (and hasn't paused). An unlinked project stays entirely local even
      // right after login.
      if (!config.cloud?.enabled || config.cloud.paused) return

      out.spin('Syncing project...')
      const result = await syncManager.sync(projectId, { include: config.cloud.include ?? {} })
      out.stop()

      if (result.success && !result.skipped) {
        const pushed = result.pushed?.count || 0
        const pulled = result.pulled?.count || 0
        if (pushed > 0 || pulled > 0) {
          out.done(`Synced (${pushed} pushed, ${pulled} pulled)`)
        } else {
          out.done('Synced — everything up to date')
        }
      }
    } catch {
      out.stop()
      // Not inside a project or sync failed — silently skip
    }
  }

  /**
   * Build branded dark success page for browser callback
   */
  private buildSuccessPage(email: string): string {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>prjct CLI Connected</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,BlinkMacSystemFont,'Segoe UI',sans-serif;
background:#0a0a0a;color:#e5e5e5;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{text-align:center;max-width:420px;padding:2.5rem}
.logo{font-size:.875rem;letter-spacing:.05em;color:#a3a3a3;margin-bottom:2rem;font-family:ui-monospace,monospace}
.logo span{color:#e5e5e5}
.icon{width:64px;height:64px;border-radius:50%;background:rgba(34,211,238,.12);
display:flex;align-items:center;justify-content:center;margin:0 auto 1.5rem}
.icon svg{width:32px;height:32px;color:#22d3ee}
h1{font-size:1.5rem;font-weight:600;margin-bottom:.75rem}
.details{background:#141414;border:1px solid #262626;border-radius:8px;padding:1rem 1.25rem;
margin:1.25rem 0;text-align:left;font-size:.875rem;line-height:1.75}
.details .label{color:#888}
.details .value{color:#e5e5e5}
.hint{color:#666;font-size:.8125rem;margin-top:1rem}
</style></head>
<body><div class="card">
<div class="logo"><span>prjct</span>/cli</div>
<div class="icon"><svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg></div>
<h1>CLI Connected</h1>
<div class="details">
<span class="label">Account:</span> <span class="value">${email}</span><br>
<span class="label">Token:</span> <span class="value">stored securely</span>
</div>
<p class="hint">Return to your terminal to continue.</p>
</div></body></html>`
  }

  /**
   * Build branded dark error page for browser callback
   */
  private buildErrorPage(error: string): string {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>prjct CLI — Error</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,BlinkMacSystemFont,'Segoe UI',sans-serif;
background:#0a0a0a;color:#e5e5e5;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{text-align:center;max-width:420px;padding:2.5rem}
.logo{font-size:.875rem;letter-spacing:.05em;color:#a3a3a3;margin-bottom:2rem;font-family:ui-monospace,monospace}
.logo span{color:#e5e5e5}
.icon{width:64px;height:64px;border-radius:50%;background:rgba(239,68,68,.12);
display:flex;align-items:center;justify-content:center;margin:0 auto 1.5rem}
.icon svg{width:32px;height:32px;color:#ef4444}
h1{font-size:1.5rem;font-weight:600;margin-bottom:.75rem}
.msg{background:#141414;border:1px solid #262626;border-radius:8px;padding:1rem 1.25rem;
margin:1.25rem 0;font-size:.875rem;color:#f87171}
.hint{color:#666;font-size:.8125rem;margin-top:1rem}
</style></head>
<body><div class="card">
<div class="logo"><span>prjct</span>/cli</div>
<div class="icon"><svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></div>
<h1>Authentication Failed</h1>
<div class="msg">${error}</div>
<p class="hint">Return to your terminal and try again.</p>
</div></body></html>`
  }

  /**
   * First-time setup - Install commands to editors
   */
  async start(): Promise<CommandResult> {
    const status = await commandInstaller.checkInstallation()
    const aiProvider = require('../infrastructure/ai-provider')
    const codexDetection = await aiProvider.detectCodex()
    const antigravityDetection = await aiProvider.detectAntigravity()
    const hasCliProvider = status.providerDetected
    const activeProvider = hasCliProvider ? await aiProvider.getActiveProvider() : null
    const primaryName = hasCliProvider
      ? activeProvider.displayName
      : codexDetection.installed
        ? 'OpenAI Codex'
        : 'AI agents'

    console.log(`🚀 Setting up prjct for ${primaryName}...\n`)

    if (!hasCliProvider && !codexDetection.installed && !antigravityDetection.installed) {
      console.log('ℹ️  No local CLI runtime detected.')
      console.log('   prjct will still use AGENTS.md + MCP-compatible surfaces after init.')
    }

    if (hasCliProvider) {
      console.log('📦 Installing p. command router...')
      const result = await commandInstaller.installCommands()

      if (!result.success) {
        return {
          success: false,
          message: `❌ Installation failed: ${result.error}`,
        }
      }

      console.log(
        `\n✅ Installed ${result.installed?.length ?? 0} commands to:\n   ${pathManager.getDisplayPath(result.path || '')}`
      )

      this.printInstallErrors(result.errors)
    }

    await this.finishProviderInstall(
      codexDetection,
      antigravityDetection,
      activeProvider,
      'Installed Codex skill'
    )

    console.log('\n🎉 Setup complete!')
    console.log('\nNext steps:')
    console.log(`  1. Open ${primaryName}`)
    console.log('  2. Navigate to your project')
    console.log('  3. Run: prjct init')

    return {
      success: true,
      message: '',
    }
  }

  /**
   * Reconfigure editor installations
   */
  async setup(options: SetupOptions = {}): Promise<CommandResult> {
    console.log('🔧 Reconfiguring prjct...\n')

    const aiProvider = require('../infrastructure/ai-provider')
    const codexDetection = await aiProvider.detectCodex()
    const antigravityDetection = await aiProvider.detectAntigravity()
    const status = await commandInstaller.checkInstallation()
    const hasGlobalCliProvider = status.providerDetected

    if (options.force) {
      console.log('🗑️  Removing existing installation...')
      await commandInstaller.uninstallCommands()
    }

    if (!hasGlobalCliProvider && !codexDetection.installed && !antigravityDetection.installed) {
      console.log('ℹ️  No local CLI runtime detected.')
      console.log('   Continuing with universal AGENTS.md/MCP-compatible setup.')
    }

    if (hasGlobalCliProvider) {
      console.log('📦 Installing p. command router...')
      const result = await commandInstaller.installCommands()

      if (!result.success) {
        return {
          success: false,
          message: `❌ Setup failed: ${result.error}`,
        }
      }

      console.log(`\n✅ Installed ${result.installed?.length ?? 0} commands`)

      this.printInstallErrors(result.errors)

      console.log('\n📝 Installing global configuration...')
      const configResult = await commandInstaller.installGlobalConfig()
      const displayPath = configResult.path
        ? pathManager.getDisplayPath(configResult.path)
        : 'global config'

      if (configResult.success) {
        if (configResult.action === 'created') {
          console.log(`✅ Created ${displayPath}`)
        } else if (configResult.action === 'updated') {
          console.log(`✅ Updated ${displayPath}`)
        } else if (configResult.action === 'appended') {
          console.log(`✅ Added prjct config to ${displayPath}`)
        }
      } else {
        console.log(`⚠️  ${configResult.error}`)
      }
    } else {
      console.log(
        'ℹ️  No Claude/Gemini global command surface detected; skipping CLI router cleanup.'
      )
    }

    const activeProvider = hasGlobalCliProvider ? await aiProvider.getActiveProvider() : null

    // Status line is currently Claude-only
    if (activeProvider?.name === 'claude') {
      console.log('\n⚡ Installing status line...')
      const statusLineResult = await this.installStatusLine()
      if (statusLineResult.success) {
        console.log('✅ Status line configured')
      } else {
        console.log(`⚠️  ${statusLineResult.error}`)
      }
    }

    await this.finishProviderInstall(
      codexDetection,
      antigravityDetection,
      activeProvider,
      'Codex skill installed'
    )

    console.log('\n🎉 Setup complete!\n')

    this.showAsciiArt()

    return {
      success: true,
      message: '',
    }
  }

  /**
   * Configure MCP servers required by prjct.
   * - Context7: auto-installs and verifies (required for framework API lookups)
   * - prjct: auto-installs the local project memory/workflow MCP
   * - Linear/Jira: optional; configured manually through their setup commands
   */
  private async setupMcpServers(): Promise<void> {
    await configureDefaultMcpServers()
  }

  /** Print `commandInstaller.installCommands()`'s per-file error list, if any. */
  private printInstallErrors(errors: Array<{ file: string; error: string }> | undefined): void {
    if ((errors?.length ?? 0) > 0) {
      console.log(`\n⚠️  ${errors?.length ?? 0} errors:`)
      for (const e of errors ?? []) {
        console.log(`   - ${e.file}: ${e.error}`)
      }
    }
  }

  /**
   * The tail both `start()` and `setup()` run once the command router (and,
   * for `setup()`, global config) is installed: Codex/Antigravity skill
   * surfaces, MCP servers, project agent surfaces, and the version stamp.
   * `codexSuccessLabel` is the one thing that differs between the two
   * flows' console output.
   */
  private async finishProviderInstall(
    codexDetection: CodexDetection,
    antigravityDetection: AntigravityDetection,
    activeProvider: AIProviderConfig | null,
    codexSuccessLabel: string
  ): Promise<void> {
    await this.installCodexSurface(codexDetection.installed, codexSuccessLabel)
    await this.installAntigravitySurface(antigravityDetection.installed)

    await this.setupMcpServers()
    await this.installProjectAgentSurfacesIfConfigured()
    await this.saveSetupStamp(
      activeProvider?.name ??
        (codexDetection.installed
          ? 'codex'
          : antigravityDetection.installed
            ? 'antigravity'
            : 'claude')
    )
  }

  private async saveSetupStamp(
    provider: import('../types/provider').AIProviderName
  ): Promise<void> {
    try {
      const editorsConfig = (await import('../infrastructure/editors-config')).default
      const installPath = path.join(pathManager.globalConfigDir, 'runtime-surfaces')
      await editorsConfig.saveConfig(VERSION, installPath, provider)
    } catch (error) {
      console.log(`⚠️  Setup stamp failed (non-blocking): ${getErrorMessage(error)}`)
    }
  }

  private async installProjectAgentSurfacesIfConfigured(): Promise<void> {
    try {
      const projectPath = process.cwd()
      const isConfigured = await configManager.isConfigured(projectPath)
      if (!isConfigured) return

      const { writeProjectAgentSurfaces } = await import('../services/project-agent-surfaces')
      const { detectInstalledAgents } = await import('../workflows/onboarding/detection')
      const result = await writeProjectAgentSurfaces(projectPath, {
        agents: await detectInstalledAgents(projectPath),
        explicit: true,
      })
      if (result.prjctMd.action !== 'unchanged') console.log('✅ Project PRJCT.md ready')
      if (result.agentsMd.action !== 'unchanged') console.log('✅ Project AGENTS.md ready')
      if (result.claudeMd && result.claudeMd.action !== 'unchanged') {
        console.log('✅ Project CLAUDE.md ready')
      }
      if (result.ideRules.length > 0) {
        console.log(`✅ Project IDE rules ready: ${result.ideRules.join(', ')}`)
      }
    } catch (error) {
      console.log(`⚠️  Project agent surface setup failed (non-blocking): ${getErrorMessage(error)}`)
    }
  }

  private async installCodexSurface(installed: boolean, successLabel: string): Promise<void> {
    if (!installed) return
    try {
      const { installCodexSkill, verifyCodexPRouterReady } = await import(
        '../infrastructure/codex-skill'
      )
      await installCodexSkill()
      const codexRouter = await verifyCodexPRouterReady({ autoRepair: true })
      if (codexRouter.verified) {
        console.log(`✅ ${successLabel}`)
        console.log('✅ Codex p. router ready')
      } else {
        console.log(
          `⚠️  Codex skill setup incomplete: ${codexRouter.message || 'router verification failed'}`
        )
        console.log('   Run `prjct setup` to retry Codex configuration.')
      }
    } catch (error) {
      console.log(`⚠️  Codex skill setup failed (non-blocking): ${getErrorMessage(error)}`)
    }
  }

  private async installAntigravitySurface(installed: boolean): Promise<void> {
    if (!installed) return
    try {
      const { resolveUserPath } = await import('../infrastructure/user-home')
      const { getTemplateContent } = await import('../agentic/template-loader')
      const antigravitySkillDir = resolveUserPath('.gemini', 'antigravity', 'skills', 'prjct')
      const skillPath = path.join(antigravitySkillDir, 'SKILL.md')
      const templateContent = getTemplateContent('antigravity/SKILL.md')
      if (!templateContent) {
        throw new Error('Antigravity SKILL.md template not found')
      }
      await fs.mkdir(antigravitySkillDir, { recursive: true })
      await fs.writeFile(skillPath, templateContent, 'utf-8')
      console.log('✅ Antigravity skill installed')
    } catch (error) {
      console.log(`⚠️  Antigravity skill setup failed (non-blocking): ${getErrorMessage(error)}`)
    }
  }

  /**
   * Install status line script and configure settings.json
   */
  async installStatusLine(): Promise<{ success: boolean; error?: string }> {
    try {
      // Note: This method is currently Claude-specific
      const claudeDir = pathManager.getClaudeDir()
      const settingsPath = pathManager.getClaudeSettingsPath()
      const statusLinePath = path.join(claudeDir, 'prjct-statusline.sh')

      // Don't clobber the modern modular ("v2") statusline if it's already
      // installed — that system (statusline-installer.ts) requires bash 4+.
      // This monolithic generator is the bash-3.2-safe variant; only (re)write
      // it when the installed statusline is absent or this same kind. Refreshing
      // it here is what lets self-heal repair the legacy false-upgrade-banner
      // body on upgrade without downgrading modular users.
      if (await fileExists(statusLinePath)) {
        const existing = await fs.readFile(statusLinePath, 'utf-8')
        if (existing.includes('build_statusline')) {
          return { success: true }
        }
      }

      // Version is embedded at install time
      const scriptContent = `#!/bin/bash
# prjct Status Line for Claude Code
# Shows version update notifications and current task

# Current CLI version (embedded at install time)
CLI_VERSION="${VERSION}"

# Read JSON context from stdin (provided by Claude Code)
read -r json

# Extract cwd from JSON
CWD=$(echo "$json" | grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"cwd"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/')

# Check if this is a prjct project
CONFIG="$CWD/.prjct/prjct.config.json"
if [[ -f "$CONFIG" ]]; then
  # Extract projectId
  PROJECT_ID=$(grep -o '"projectId"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG" | sed 's/.*"projectId"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/')

  if [[ -n "$PROJECT_ID" ]]; then
    # Upgrade notice — the daemon checks npm and writes this GLOBAL flag.
    # The statusline only READS it; it does no version comparison itself.
    UPDATE_STATUS="$HOME/.prjct-cli/state/update-status.json"
    if [[ -f "$UPDATE_STATUS" ]] && grep -q '"updateAvailable"[[:space:]]*:[[:space:]]*true' "$UPDATE_STATUS"; then
      LATEST=$(grep -o '"latest"[[:space:]]*:[[:space:]]*"[^"]*"' "$UPDATE_STATUS" | sed 's/.*"latest"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/')
      echo "⚠️ prjct v$LATEST available! Run p. upgrade"
      exit 0
    fi

  fi
fi

# Default: show prjct branding
echo "⚡ prjct"
`
      await fs.writeFile(statusLinePath, scriptContent, { mode: 0o755 })

      const settings: Record<string, unknown> = (await fileExists(settingsPath))
        ? await readJson<Record<string, unknown>>(settingsPath)
            .catch(() => null)
            .then((v) => v ?? {})
        : {}

      settings.statusLine = {
        type: 'command',
        command: statusLinePath,
      }

      await writeJson(settingsPath, settings)

      return { success: true }
    } catch (error) {
      return failFromError(error)
    }
  }

  /**
   * Show beautiful ASCII art with quick start
   */
  showAsciiArt(): void {
    console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
    console.log('')
    console.log(chalk.bold.cyan('   ██████╗ ██████╗      ██╗ ██████╗████████╗'))
    console.log(chalk.bold.cyan('   ██╔══██╗██╔══██╗     ██║██╔════╝╚══██╔══╝'))
    console.log(chalk.bold.cyan('   ██████╔╝██████╔╝     ██║██║        ██║'))
    console.log(chalk.bold.cyan('   ██╔═══╝ ██╔══██╗██   ██║██║        ██║'))
    console.log(chalk.bold.cyan('   ██║     ██║  ██║╚█████╔╝╚██████╗   ██║'))
    console.log(chalk.bold.cyan('   ╚═╝     ╚═╝  ╚═╝ ╚════╝  ╚═════╝   ╚═╝'))
    console.log('')
    console.log(
      `   ${chalk.bold.cyan('prjct')}${chalk.magenta('/')}${chalk.green('cli')}  ${chalk.dim.white(`v${VERSION} installed`)}`
    )
    console.log('')
    console.log(`   ${chalk.yellow('⚡')} Improve developer + agent performance`)
    console.log(`   ${chalk.green('🧠')} Rich project context without context bloat`)
    console.log(`   ${chalk.cyan('🤖')} Human-in-the-loop work cycles`)
    console.log('')
    console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
    console.log('')
    console.log(chalk.bold.cyan('🚀 Quick Start'))
    console.log(chalk.dim('─────────────────────────────────────────────────'))
    console.log('')
    console.log(`  ${chalk.bold('1.')} Initialize your project:`)
    console.log(`     ${chalk.green('cd your-project && prjct init')}`)
    console.log('')
    console.log(`  ${chalk.bold('2.')} Start your first work cycle:`)
    console.log(`     ${chalk.green('prjct work "build auth"')}`)
    console.log('')
    console.log(`  ${chalk.bold('3.')} Ship & celebrate:`)
    console.log(`     ${chalk.green('prjct ship "user login"')}`)
    console.log('')
    console.log(chalk.dim('─────────────────────────────────────────────────'))
    console.log('')
    console.log(`  ${chalk.dim('Documentation:')} ${chalk.cyan('https://prjct.app')}`)
    console.log(
      `  ${chalk.dim('Report issues:')} ${chalk.cyan('https://github.com/prjct-app/cli/issues')}`
    )
    console.log('')
    console.log(chalk.bold.magenta('Ship with better context.'))
    console.log('')
  }
}
