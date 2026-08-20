/**
 * DoctorService - System health checks and diagnostics
 *
 * Checks:
 * - Required tools (git, node)
 * - Optional tools (bun, gh, claude, gemini)
 * - Project configuration
 * - Generated file staleness
 * - Provides actionable recommendations
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import chalk from 'chalk'
import { verifyCodexPRouterReady } from '../infrastructure/codex-skill'
import configManager from '../infrastructure/config-manager'
import pathManager from '../infrastructure/path-manager'
import { stateStorage } from '../storage/state-storage'
import type { CheckResult, DoctorResult } from '../types/services/extracted'
import { fileExists } from '../utils/file-helper'
import out from '../utils/output'
import { VERSION } from '../utils/version'
import { collectContextTax, contextTaxChecks, type HostContextTax } from './context-tax'
import context7Service from './context7-service'

// DOCTOR SERVICE

export function summarizeDoctorResult(
  tools: CheckResult[],
  project: CheckResult[],
  context: CheckResult[],
  recommendations: string[]
): DoctorResult {
  const allChecks = [...tools, ...project, ...context]
  const hasErrors = allChecks.some((check) => check.status === 'error' && !check.optional)
  const hasWarnings = allChecks.some(
    (check) => check.status === 'warn' || (check.status === 'error' && check.optional)
  )
  return {
    success: !hasErrors,
    tools,
    project,
    context,
    recommendations,
    hasErrors,
    hasWarnings,
  }
}

class DoctorService {
  private projectPath: string = ''
  private projectId: string | null = null
  private globalPath: string = ''

  /**
   * Run all health checks
   */
  async check(
    projectPath: string = process.cwd(),
    knownContextTax?: HostContextTax[]
  ): Promise<DoctorResult> {
    this.projectPath = projectPath
    this.projectId = await configManager.getProjectId(projectPath)
    if (this.projectId) {
      this.globalPath = pathManager.getGlobalProjectPath(this.projectId)
    }

    const tools = await this.checkTools()
    const project = await this.checkProject()
    const context = contextTaxChecks(knownContextTax ?? (await collectContextTax()))
    const recommendations = this.generateRecommendations(tools, project)
    return summarizeDoctorResult(tools, project, context, recommendations)
  }

  /**
   * Run checks and print formatted output
   */
  async run(projectPath: string = process.cwd()): Promise<number> {
    const result = await this.check(projectPath)

    this.printHeader()
    this.printSection('System Tools', result.tools)
    this.printSection('Project Status', result.project)
    if (result.context.length > 0) this.printSection('Context Tax', result.context)

    if (result.recommendations.length > 0) {
      this.printRecommendations(result.recommendations)
    }

    this.printSummary(result)
    out.info('Heal dead hooks / multi-runtime gaps: prjct doctor --fix')

    return result.hasErrors ? 1 : 0
  }

  /**
   * Diagnose → repair every safe known issue → verify. A repair pass only
   * succeeds when the second diagnosis has no required errors.
   */
  async heal(projectPath: string = process.cwd()): Promise<number> {
    this.printHeader()
    out.info('Doctor repair loop — diagnose → repair → verify…')
    try {
      const { applyDoctorHeal } = await import('./doctor-heal')
      const { applyContextTaxHeal } = await import('./context-tax-heal')
      const { applyPlannedDoctorRepairs } = await import('./doctor-repair')
      const taxes = await collectContextTax()
      const initial = await this.check(projectPath, taxes)
      const checkReport = await applyPlannedDoctorRepairs(
        [...initial.tools, ...initial.project, ...initial.context],
        projectPath
      )
      const report = await applyDoctorHeal(projectPath)
      const contextReport = await applyContextTaxHeal(taxes, projectPath)
      out.done(checkReport.line)
      if (checkReport.applied.length) out.info(`check repairs: ${checkReport.applied.join(', ')}`)
      if (checkReport.errors.length) {
        for (const e of checkReport.errors) out.fail(e)
      }
      out.done(report.line)
      if (report.applied.length) out.info(`applied: ${report.applied.join(', ')}`)
      if (report.skipped.length) out.info(`skipped: ${report.skipped.join(', ')}`)
      if (report.errors.length) {
        for (const e of report.errors) out.fail(e)
      }
      out.done(contextReport.line)
      if (contextReport.applied.length)
        out.info(`context applied: ${contextReport.applied.join(', ')}`)
      if (contextReport.skipped.length)
        out.info(`context skipped: ${contextReport.skipped.join(', ')}`)
      if (contextReport.errors.length) {
        for (const e of contextReport.errors) out.fail(e)
      }
      // Re-run checks after heal
      const result = await this.check(projectPath)
      this.printSection('System Tools', result.tools)
      this.printSection('Project Status', result.project)
      if (result.context.length > 0) this.printSection('Context Tax', result.context)
      this.printSummary(result)
      return checkReport.errors.length > 0 ||
        report.errors.length > 0 ||
        contextReport.errors.length > 0 ||
        result.hasErrors
        ? 1
        : 0
    } catch (e) {
      out.fail(`heal failed: ${(e as Error).message}`)
      return 1
    }
  }

  // TOOL CHECKS

  private async checkTools(): Promise<CheckResult[]> {
    const checks: CheckResult[] = []

    // Git (required)
    checks.push(this.checkCommand('git', ['git', '--version'], /git version ([\d.]+)/, false))

    // Node (required)
    checks.push(this.checkCommand('node', ['node', '--version'], /v([\d.]+)/, false))

    // Bun (optional)
    checks.push(this.checkCommand('bun', ['bun', '--version'], /([\d.]+)/, true))

    // GitHub CLI (optional)
    checks.push(
      this.checkCommand(
        'gh',
        ['gh', '--version'],
        /gh version ([\d.]+)/,
        true,
        'needed for PR commands'
      )
    )

    // Claude Code (optional)
    checks.push(
      this.checkCommand(
        'claude',
        ['claude', '--version'],
        /claude ([\d.]+)/,
        true,
        'Anthropic Claude Code CLI'
      )
    )

    // Gemini CLI (optional)
    checks.push(
      this.checkCommand(
        'gemini',
        ['gemini', '--version'],
        /gemini ([\d.]+)/,
        true,
        'Google Gemini CLI'
      )
    )

    // OpenAI Codex CLI (optional)
    checks.push(
      this.checkCommand('codex', ['codex', '--version'], /([\d.]+)/, true, 'OpenAI Codex CLI')
    )

    // Parallel global installs (mem_8768) — PATH winner vs removable shadows.
    checks.push(await this.checkParallelInstalls())

    return checks
  }

  /**
   * Warn when multiple package managers each hold prjct-cli — the classic
   * dual-install footgun. Remediation: prjct update (auto cleanup) or
   * uninstall non-winners.
   */
  private async checkParallelInstalls(): Promise<CheckResult> {
    try {
      const { planCleanup } = await import('../commands/update/cleanup-installs')
      const plan = planCleanup()
      if (plan.removable.length === 0) {
        return {
          name: 'prjct installs',
          status: 'ok',
          message: plan.winner
            ? `single winner: ${plan.winner}`
            : 'one install (or PATH winner unresolved)',
          optional: true,
        }
      }
      const list = plan.removable.map((r) => `${r.pm}@${r.version}`).join(', ')
      return {
        name: 'prjct installs',
        status: 'warn',
        message: `${plan.removable.length} parallel install(s) shadow winner ${plan.winner ?? '?'}: ${list} — run \`prjct update\` to consolidate (or uninstall non-winners)`,
        optional: true,
      }
    } catch {
      return {
        name: 'prjct installs',
        status: 'ok',
        message: 'could not scan (skipped)',
        optional: true,
      }
    }
  }

  private checkCommand(
    name: string,
    command: [string, ...string[]],
    versionRegex: RegExp,
    optional: boolean,
    description?: string
  ): CheckResult {
    try {
      const [bin, ...args] = command
      const output = execFileSync(bin, args, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const match = output.match(versionRegex)
      const version = match ? match[1] : 'unknown'

      return {
        name,
        status: 'ok',
        version,
        optional,
      }
    } catch {
      return {
        name,
        status: 'error',
        message: description ? `not found (${description})` : 'not found',
        optional,
      }
    }
  }

  // PROJECT CHECKS

  private async checkProject(): Promise<CheckResult[]> {
    const checks: CheckResult[] = []

    // prjct config
    checks.push(await this.checkPrjctConfig())

    // Git repo
    checks.push(await this.checkGitRepo())

    // State file
    checks.push(await this.checkStateFile())

    // Context7 MCP
    checks.push(await this.checkContext7())

    // Codex p. router
    checks.push(await this.checkCodexPRouter())

    // Claude Code hooks (the capture/apply loop runs through them)
    checks.push(await this.checkClaudeHooks())

    return checks
  }

  private async checkClaudeHooks(): Promise<CheckResult> {
    try {
      const settingsInstaller = await import('./settings-installer')
      const { installed, expected } = await settingsInstaller.status()

      if (installed === expected) {
        return {
          name: 'claude hooks',
          status: 'ok',
          message: `${installed}/${expected} installed`,
        }
      }
      return {
        name: 'claude hooks',
        status: 'warn',
        message: `${installed}/${expected} installed - run "prjct doctor --fix" to repair`,
      }
    } catch {
      return {
        name: 'claude hooks',
        status: 'warn',
        message: 'could not read ~/.claude/settings.json',
      }
    }
  }

  private async checkPrjctConfig(): Promise<CheckResult> {
    const configPath = path.join(this.projectPath, '.prjct', 'prjct.config.json')

    if (await fileExists(configPath)) {
      return {
        name: 'prjct config',
        status: 'ok',
        message: 'initialized',
      }
    }
    return {
      name: 'prjct config',
      status: 'error',
      message: 'not initialized - run "prjct init"',
    }
  }

  private async checkGitRepo(): Promise<CheckResult> {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: this.projectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      // Check for uncommitted changes
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: this.projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const hasChanges = status.trim().length > 0

      if (hasChanges) {
        const lines = status.trim().split('\n').filter(Boolean)
        return {
          name: 'git repo',
          status: 'ok',
          message: `${lines.length} uncommitted change${lines.length > 1 ? 's' : ''}`,
        }
      }

      return {
        name: 'git repo',
        status: 'ok',
        message: 'clean',
      }
    } catch {
      return {
        name: 'git repo',
        status: 'warn',
        message: 'not a git repository',
      }
    }
  }

  private async checkStateFile(): Promise<CheckResult> {
    if (!this.globalPath || !this.projectId) {
      return {
        name: 'task state',
        status: 'warn',
        message: 'project not initialized',
      }
    }

    try {
      const state = await stateStorage.read(this.projectId)

      if (state.currentTask) {
        return {
          name: 'task state',
          status: 'ok',
          message: `active: ${state.currentTask.description?.slice(0, 30)}...`,
        }
      }

      return {
        name: 'task state',
        status: 'ok',
        message: 'no active task',
      }
    } catch {
      return {
        name: 'task state',
        status: 'ok',
        message: 'no state data (normal for new projects)',
        optional: true,
      }
    }
  }

  private async checkContext7(): Promise<CheckResult> {
    try {
      const status = await context7Service.verify()
      if (!status.installed) {
        return {
          name: 'context7 mcp',
          status: 'error',
          message: 'not configured - run "prjct start"',
        }
      }
      if (!status.verified) {
        return {
          name: 'context7 mcp',
          status: 'error',
          message: status.message || 'configured but verification failed',
        }
      }
      return {
        name: 'context7 mcp',
        status: 'ok',
        message: 'ready',
      }
    } catch (error) {
      return {
        name: 'context7 mcp',
        status: 'error',
        message: `check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      }
    }
  }

  private async checkCodexPRouter(): Promise<CheckResult> {
    try {
      const status = await verifyCodexPRouterReady({ autoRepair: true })
      if (!status.installed) {
        return {
          name: 'codex p-router',
          status: 'ok',
          message: 'codex not detected (check skipped)',
          optional: true,
        }
      }

      if (!status.verified) {
        return {
          name: 'codex p-router',
          status: 'error',
          message: status.message || 'router verification failed',
        }
      }

      return {
        name: 'codex p-router',
        status: 'ok',
        message: `ready (${status.templateSource || 'local-dev'})`,
      }
    } catch (error) {
      return {
        name: 'codex p-router',
        status: 'error',
        message: `check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      }
    }
  }

  // RECOMMENDATIONS

  private generateRecommendations(tools: CheckResult[], project: CheckResult[]): string[] {
    const recommendations: string[] = []

    // Check for missing optional tools
    const missingGh = tools.find((t) => t.name === 'gh' && t.status === 'error')
    if (missingGh) {
      recommendations.push('Install GitHub CLI (gh) for PR commands: https://cli.github.com')
    }

    // Check for stale CLAUDE.md
    const claudeCheck = project.find((p) => p.name === 'CLAUDE.md')
    if (claudeCheck?.status === 'warn' && claudeCheck.message?.includes('stale')) {
      recommendations.push('Run "prjct sync" to update context')
    }

    // Check for missing init
    const configCheck = project.find((p) => p.name === 'prjct config')
    if (configCheck?.status === 'error') {
      recommendations.push('Run "prjct init" to initialize this project')
    }

    // Check for missing CLAUDE.md
    const claudeMissing = project.find((p) => p.name === 'CLAUDE.md' && p.status === 'error')
    if (claudeMissing && !configCheck?.status?.includes('error')) {
      recommendations.push('Run "prjct sync" to generate context files')
    }

    const context7 = project.find((p) => p.name === 'context7 mcp')
    if (context7 && context7.status !== 'ok') {
      recommendations.push('Run "prjct start" to install/repair Context7 MCP')
    }

    const codexRouter = project.find((p) => p.name === 'codex p-router')
    if (codexRouter && codexRouter.status === 'error') {
      recommendations.push('Run "prjct start" or "prjct setup" to repair Codex p. router')
    }

    return recommendations
  }

  // OUTPUT

  private printHeader(): void {
    out.section(`prjct doctor v${VERSION}`)
  }

  private printSection(title: string, checks: CheckResult[]): void {
    out.section(title)

    const items = checks.map((check) => {
      const icon = this.getStatusIcon(check.status, check.optional)
      const name = check.name.padEnd(14)
      const detail = check.version || check.message || ''
      const optionalTag = check.optional && check.status === 'error' ? chalk.dim(' (optional)') : ''
      return `${icon} ${name} ${chalk.dim(detail)}${optionalTag}`
    })

    for (const item of items) {
      console.log(`  ${item}`)
    }
  }

  private printRecommendations(recommendations: string[]): void {
    out.section('Recommendations')
    out.list(recommendations, { bullet: chalk.yellow('•') })
  }

  private printSummary(result: DoctorResult): void {
    console.log('')
    console.log(chalk.dim('─'.repeat(40)))

    if (result.hasErrors) {
      out.fail('Some required checks failed')
    } else if (result.hasWarnings) {
      out.warn('All required checks passed (some warnings)')
    } else {
      out.done('All checks passed')
    }

    console.log('')
  }

  private getStatusIcon(status: 'ok' | 'warn' | 'error', optional?: boolean): string {
    switch (status) {
      case 'ok':
        return chalk.green('✓')
      case 'warn':
        return chalk.yellow('⚠')
      case 'error':
        return optional ? chalk.dim('○') : chalk.red('✗')
    }
  }
}

export const doctorService = new DoctorService()
export { DoctorService }
