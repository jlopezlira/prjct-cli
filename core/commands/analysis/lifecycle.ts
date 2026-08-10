/**
 * Analysis lifecycle commands — `seal`, `rollback`, `verify`,
 * `semanticVerify`. Manages the analysis state machine
 * (draft → sealed → archived) with cryptographic + semantic
 * integrity checks.
 *
 * Extracted from the AnalysisCommands god-class for the 500-LOC
 * limit. None of these touch `this` beyond the project-init guard
 * (replaced with `requireProject`).
 */

import { analysisStorage } from '../../storage/analysis-storage'
import { prjctDb } from '../../storage/database'
import type { CommandResult } from '../../types/commands'
import { getErrorMessage } from '../../types/fs'
import { failHard } from '../../utils/md-aware'
import { mdDone, mdOutput, mdStats } from '../../utils/md-formatter'
import out from '../../utils/output'
import { requireProject } from '../guards'

export async function seal(
  projectPath: string = process.cwd(),
  options: { json?: boolean } = {}
): Promise<CommandResult> {
  try {
    const proj = await requireProject(projectPath)
    if (!proj.ok) {
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: 'No project ID found' }))
      }
      return proj.result
    }
    const projectId = proj.value

    const result = await analysisStorage.seal(projectId)

    if (options.json) {
      console.log(
        JSON.stringify({
          success: result.success,
          signature: result.signature,
          error: result.error,
        })
      )
      return { success: result.success, error: result.error }
    }

    if (!result.success) {
      out.fail(result.error || 'Seal failed')
      return { success: false, error: result.error }
    }

    out.done('Analysis sealed')
    console.log(`  Signature: ${result.signature?.substring(0, 16)}...`)
    console.log('')

    return { success: true, data: { signature: result.signature } }
  } catch (error) {
    const errMsg = getErrorMessage(error)
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: errMsg }))
    } else {
      out.fail(errMsg)
    }
    return { success: false, error: errMsg }
  }
}

/**
 * prjct rollback - Rollback to the previous sealed analysis (PRJ-276)
 *
 * Restores the previous sealed version. The current sealed becomes a draft.
 * Only one level of rollback is supported.
 */
export async function rollback(
  projectPath: string = process.cwd(),
  options: { json?: boolean; md?: boolean } = {}
): Promise<CommandResult> {
  try {
    const proj = await requireProject(projectPath)
    if (!proj.ok) {
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: 'No project ID found' }))
      }
      return proj.result
    }
    const projectId = proj.value

    const result = await analysisStorage.rollback(projectId)

    if (options.json) {
      console.log(
        JSON.stringify({
          success: result.success,
          restoredSignature: result.restoredSignature,
          error: result.error,
        })
      )
      return { success: result.success, error: result.error }
    }

    if (options.md) {
      if (!result.success) {
        console.log(mdOutput(`## Rollback Failed`, `> ${result.error}`))
        return { success: false, error: result.error }
      }

      console.log(
        mdOutput(
          mdDone('Analysis Rolled Back'),
          mdStats({
            'Restored signature': `${result.restoredSignature?.substring(0, 16)}...`,
            Note: 'Previous sealed version is now active. Current version moved to draft.',
          })
        )
      )
      return { success: true, data: { restoredSignature: result.restoredSignature } }
    }

    if (!result.success) {
      out.fail(result.error || 'Rollback failed')
      return { success: false, error: result.error }
    }

    out.done('Analysis rolled back to previous sealed version')
    console.log(`  Restored signature: ${result.restoredSignature?.substring(0, 16)}...`)
    console.log(`  Previous sealed version demoted to draft`)
    console.log('')

    return { success: true, data: { restoredSignature: result.restoredSignature } }
  } catch (error) {
    const errMsg = getErrorMessage(error)
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: errMsg }))
    } else if (options.md) {
      console.log(mdOutput(`## Rollback Failed`, `> ${errMsg}`))
    } else {
      out.fail(errMsg)
    }
    return { success: false, error: errMsg }
  }
}

/**
 * prjct verify - Verify integrity of sealed analysis (PRJ-263)
 *
 * Modes:
 * - Default: Cryptographic verification (signature check)
 * - --semantic: Semantic verification (data accuracy check, PRJ-270)
 */
export async function verify(
  projectPath: string = process.cwd(),
  options: { json?: boolean; semantic?: boolean } = {}
): Promise<CommandResult> {
  // Semantic verification mode (PRJ-270)
  if (options.semantic) {
    return semanticVerifyCommand(projectPath, options)
  }

  // Default: Cryptographic verification (PRJ-263)
  try {
    const proj = await requireProject(projectPath)
    if (!proj.ok) return proj.result
    const projectId = proj.value

    const result = await analysisStorage.verify(projectId)

    if (options.json) {
      console.log(JSON.stringify(result))
      return { success: result.valid }
    }

    if (result.valid) {
      out.done(result.message)
    } else {
      out.fail(result.message)
    }
    console.log('')

    return { success: result.valid, data: result }
  } catch (error) {
    const errMsg = getErrorMessage(error)
    return failHard(errMsg)
  }
}

/**
 * prjct analysis verify --semantic - Semantic verification of analysis results (PRJ-270)
 *
 * Validates that analysis data matches actual project state:
 * - Frameworks exist in package.json
 * - Languages match file extensions
 * - Pattern locations reference real files
 * - File count is accurate
 * - Anti-pattern files exist
 */
export async function semanticVerifyCommand(
  projectPath: string = process.cwd(),
  options: { json?: boolean } = {}
): Promise<CommandResult> {
  try {
    const proj = await requireProject(projectPath)
    if (!proj.ok) {
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: 'No project ID found' }))
      } else {
        out.fail('No project ID found')
      }
      return proj.result
    }
    const projectId = proj.value

    // Get project path from project doc
    const repoPath = (() => {
      try {
        const projectDoc = prjctDb.getDoc<Record<string, unknown>>(projectId, 'project')
        return (projectDoc?.repoPath as string) || projectPath
      } catch {
        return projectPath
      }
    })()

    // Run semantic verification
    const result = await analysisStorage.semanticVerify(projectId, repoPath)

    // JSON output mode
    if (options.json) {
      console.log(JSON.stringify(result))
      return { success: result.passed, data: result }
    }

    // Human-readable output
    console.log('')
    if (result.passed) {
      out.done('Semantic verification passed')
      console.log(
        `  ${result.passedCount}/${result.checks.length} checks passed (${result.totalMs}ms)`
      )
    } else {
      out.fail('Semantic verification failed')
      console.log(`  ${result.failedCount}/${result.checks.length} checks failed`)
    }
    console.log('')

    // Show check details
    console.log('Check Results:')
    for (const check of result.checks) {
      const icon = check.passed ? '✓' : '✗'
      const status = check.passed
        ? `${check.output} (${check.durationMs}ms)`
        : check.error || 'Failed'
      console.log(`  ${icon} ${check.name}: ${status}`)
    }
    console.log('')

    return { success: result.passed, data: result }
  } catch (error) {
    const errMsg = getErrorMessage(error)
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: errMsg }))
    } else {
      out.fail(errMsg)
    }
    return { success: false, error: errMsg }
  }
}
