/**
 * `prjct gauntlet` — run the project's registered verify commands as a
 * recorded machine gate. Exit ≠ 0 on red, so it slots into any CI.
 */

import configManager from '../infrastructure/config-manager'
import { renderGauntletMd, renderGauntletText, runGauntlet } from '../services/gauntlet'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'

export class GauntletCommands {
  async run(projectPath: string = process.cwd(), options: MdOption = {}): Promise<CommandResult> {
    try {
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        return { success: false, error: 'No prjct project found in the current directory.' }
      }
      const receipt = await runGauntlet(projectPath, projectId)
      console.log(options.md ? renderGauntletMd(receipt) : renderGauntletText(receipt))
      return {
        success: receipt.passed,
        passed: receipt.passed,
        vacuous: receipt.vacuous,
        checks: receipt.checks.length,
      }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  }
}
