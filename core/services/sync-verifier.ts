/**
 * SyncVerifier - Programmatic verification checks for sync workflow
 *
 * Runs configurable checks after sync to validate generated output.
 * Supports built-in checks and custom user commands.
 *
 * @see PRJ-106
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { stateStorage } from '../storage/state-storage'
import { getErrorMessage, isNotFoundError } from '../types/fs'
import type {
  VerificationCheck,
  VerificationCheckResult,
  VerificationConfig,
  VerificationReport,
} from '../types/sync-verifier'
import { execAsync } from '../utils/exec'

// BUILT-IN CHECKS

const BUILTIN_CHECKS = {
  /**
   * Verify state data is valid in SQLite
   */
  async jsonFilesValid(globalPath: string): Promise<VerificationCheckResult> {
    const start = Date.now()
    const invalid: string[] = []

    // Extract projectId from globalPath (last segment)
    const projectId = path.basename(globalPath)

    try {
      await stateStorage.read(projectId)
    } catch (error) {
      if (!isNotFoundError(error)) {
        invalid.push(`state: ${getErrorMessage(error)}`)
      }
    }

    return {
      name: 'State data valid',
      passed: invalid.length === 0,
      output: invalid.length === 0 ? '1 store validated' : undefined,
      error: invalid.length > 0 ? invalid.join('; ') : undefined,
      durationMs: Date.now() - start,
    }
  },

  /**
   * Verify no sensitive data leaked into context files
   */
  async noSensitiveData(globalPath: string): Promise<VerificationCheckResult> {
    const start = Date.now()
    const contextDir = path.join(globalPath, 'context')
    const patterns = [
      /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{10,}/i,
      /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}/i,
      /(?:secret|token)\s*[:=]\s*['"][^'"]{10,}/i,
    ]
    const violations: string[] = []

    try {
      const files = await fs.readdir(contextDir)
      for (const file of files) {
        if (!file.endsWith('.md')) continue
        const content = await fs.readFile(path.join(contextDir, file), 'utf-8')
        for (const pattern of patterns) {
          if (pattern.test(content)) {
            violations.push(`${file}: potential sensitive data detected`)
            break
          }
        }
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        return {
          name: 'No sensitive data',
          passed: false,
          error: `Could not scan: ${getErrorMessage(error)}`,
          durationMs: Date.now() - start,
        }
      }
    }

    return {
      name: 'No sensitive data',
      passed: violations.length === 0,
      output: violations.length === 0 ? 'No sensitive patterns found' : undefined,
      error: violations.length > 0 ? violations.join('; ') : undefined,
      durationMs: Date.now() - start,
    }
  },
}

// SYNC VERIFIER

class SyncVerifier {
  /**
   * Run all verification checks (built-in + custom)
   */
  async verify(
    projectPath: string,
    globalPath: string,
    config?: VerificationConfig
  ): Promise<VerificationReport> {
    const totalStart = Date.now()
    const checks: VerificationCheckResult[] = []
    const failFast = config?.failFast ?? false
    const skippedChecks: string[] = []

    // 1. Run built-in checks
    const builtinChecks = [
      BUILTIN_CHECKS.jsonFilesValid(globalPath),
      BUILTIN_CHECKS.noSensitiveData(globalPath),
    ]

    for (const checkPromise of builtinChecks) {
      const result = await checkPromise
      checks.push(result)
      if (!result.passed && failFast) {
        skippedChecks.push(
          ...(config?.checks?.filter((c) => c.enabled !== false).map((c) => c.name) ?? [])
        )
        break
      }
    }

    // 2. Run custom checks (if configured and not fail-fast-stopped)
    const shouldContinue = !failFast || checks.every((c) => c.passed)
    if (shouldContinue && config?.checks) {
      for (const check2 of config.checks) {
        if (check2.enabled === false) {
          skippedChecks.push(check2.name)
          continue
        }

        const result = await this.runCustomCheck(check2, projectPath)
        checks.push(result)

        if (!result.passed && failFast) {
          // Count remaining enabled checks as skipped
          const remaining = config.checks.slice(config.checks.indexOf(check2) + 1)
          skippedChecks.push(...remaining.filter((c) => c.enabled !== false).map((c) => c.name))
          break
        }
      }
    }

    const failedCount = checks.filter((c) => !c.passed).length
    const passedCount = checks.filter((c) => c.passed).length

    return {
      passed: failedCount === 0,
      checks,
      totalMs: Date.now() - totalStart,
      failedCount,
      passedCount,
      skippedCount: skippedChecks.length,
    }
  }

  /**
   * Run a single custom verification check
   */
  private async runCustomCheck(
    check: VerificationCheck,
    projectPath: string
  ): Promise<VerificationCheckResult> {
    const start = Date.now()
    const command = check.command || (check.script ? `sh ${check.script}` : null)

    if (!command) {
      return {
        name: check.name,
        passed: false,
        error: 'No command or script specified',
        durationMs: Date.now() - start,
      }
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: projectPath,
        timeout: 30_000,
      })

      return {
        name: check.name,
        passed: true,
        output: (stdout.trim() || stderr.trim()).slice(0, 200) || undefined,
        durationMs: Date.now() - start,
      }
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string; message: string }
      return {
        name: check.name,
        passed: false,
        error: (execError.stderr?.trim() || execError.message).slice(0, 200),
        durationMs: Date.now() - start,
      }
    }
  }
}

// EXPORTS

export const syncVerifier = new SyncVerifier()
