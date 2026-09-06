/**
 * `prjct verify` — proof-carrying verification.
 *
 *   prjct verify "<cmd>" | auto     one-shot run (Stop-Slop: pass/fail)
 *   prjct verify repro "<cmd>"      record a reproduction (must fail)
 *   prjct verify fix "<cmd>"        record the fix (must pass + tree changed)
 *
 * The repro→fix pair turns a root-cause claim into a measurement: the same
 * command has to flip from failing to passing across a real code change.
 */

import configManager from '../infrastructure/config-manager'
import { recordFix, recordRepro } from '../services/verify-contract'
import { detectVerifyCommand, runVerifyCommand } from '../services/verify-runner'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

interface VerifyOptions {
  md?: boolean
  timeoutMs?: number | string
}

const SUBACTIONS = new Set(['repro', 'fix', 'auto'])

export class VerifyCommands extends PrjctCommandsBase {
  async verify(
    param: string | null = null,
    projectPath: string = process.cwd(),
    options: VerifyOptions = {}
  ): Promise<CommandResult> {
    const md = options.md === true
    try {
      const tokens = (param ?? '').trim().split(/\s+/).filter(Boolean)
      const first = tokens[0] ?? ''
      const sub = SUBACTIONS.has(first) ? first : ''
      const rest = sub ? tokens.slice(1).join(' ') : tokens.join(' ')
      const timeoutMs = options.timeoutMs ? Number(options.timeoutMs) : undefined

      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        out.info('Not a prjct project — run `prjct init` first.')
        return { success: false, error: 'no project' }
      }

      const command =
        rest === 'auto' || first === 'auto' || (!rest && sub !== 'fix')
          ? await detectVerifyCommand(projectPath)
          : rest
      if (sub !== 'fix' && !command) {
        out.info('Usage: prjct verify "<cmd>" | auto | repro "<cmd>" | fix "<cmd>"')
        return { success: false, error: 'no command (and verify:auto found none)' }
      }

      if (sub === 'repro') {
        const res = await recordRepro(projectId, projectPath, command as string, { timeoutMs })
        const body = res.ok
          ? `✓ reproduction recorded for \`${command}\` (exit ${res.receipt?.exitCode}). Now edit, then \`prjct verify fix "${command}"\`.`
          : `✗ ${res.reason}`
        md ? console.log(body) : res.ok ? out.done(body) : out.info(body)
        return { success: res.ok, message: body, error: res.ok ? undefined : res.reason }
      }

      if (sub === 'fix') {
        const cmd = rest || (await detectVerifyCommand(projectPath))
        if (!cmd) return { success: false, error: 'no command for fix' }
        const res = await recordFix(projectId, projectPath, cmd, { timeoutMs })
        const body = res.ok
          ? `✓ fix verified for \`${cmd}\` — failing→passing across a real tree change (red→green).`
          : `✗ ${res.reason}`
        md ? console.log(body) : res.ok ? out.done(body) : out.info(body)
        return { success: res.ok, message: body, error: res.ok ? undefined : res.reason }
      }

      // One-shot verify (Stop-Slop): run and report.
      const run = await runVerifyCommand(projectPath, command as string, { timeoutMs })
      const body = run.ok
        ? `✓ verify passed: \`${command}\``
        : `✗ verify FAILED: \`${command}\`\n${run.detail}\nStop-the-line: fix the failure and re-run.`
      md ? console.log(body) : run.ok ? out.done(body) : out.info(body)
      return { success: run.ok, message: body, error: run.ok ? undefined : 'verification failed' }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  }
}
