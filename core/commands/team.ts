/**
 * `prjct team` — turn this repo into a prjct-shared project.
 *
 * What it does:
 *   1. Records `{required, minVersion}` in project SQLite (`team:enrollment`).
 *   2. Prints what teammates need to run. Nothing else.
 *
 * What it deliberately does NOT do: write anything into the customer
 * worktree. There is no `.prjct/team.json` mirror and no generated
 * `.githooks/pre-commit` — `legacy-crew-sweep` purges any leftover mirror
 * from an older install on the next `prjct sync`, so a writer here would
 * only fight it. `.prjct/` carries the pointer to global storage
 * (`prjct.config.json`) and nothing more; agent-facing context lives only
 * in the user's global agent configuration.
 *
 * Retiring the mirror retired `--enforce` with it: that hook existed to
 * block contributors who do NOT have prjct installed, and it read the
 * committed mirror because a fresh clone has no local SQLite to consult.
 * With state SQL-only there is nothing a fresh clone could enforce
 * against, so the flag is gone rather than silently inert.
 *
 * Anti-harness contract (mem_899): no automatic git commits, no
 * background pushes, no LLM-mediated decisions.
 */

import configManager from '../infrastructure/config-manager'
import { type TeamEnrollment, teamEnrollmentStorage } from '../storage/team-enrollment-storage'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { failHard } from '../utils/md-aware'
import { mdOutput, mdSection } from '../utils/md-formatter'
import out from '../utils/output'
import { VERSION } from '../utils/version'
import { PrjctCommandsBase } from './base'

interface TeamOptions {
  md?: boolean
  required?: boolean
  minVersion?: string
}

export class TeamCommands extends PrjctCommandsBase {
  async team(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: TeamOptions = {}
  ): Promise<CommandResult> {
    // Subverb dispatch. `prjct team check` reports the stored enrollment.
    if (input === 'check') {
      return this.check(projectPath, options)
    }

    try {
      const teamConfig: TeamEnrollment = {
        required: options.required === true,
        minVersion: options.minVersion ?? VERSION ?? '0.0.0',
        enrolledAt: new Date().toISOString(),
        enrolledBy: null,
      }

      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        return failHard('No prjct project. Run `prjct init` first.', options)
      }
      teamEnrollmentStorage.set(projectId, teamConfig)

      const summary = `${teamConfig.required ? '✓ team mode (required)' : '✓ team mode (optional)'} — minVersion ${teamConfig.minVersion}`
      const storedHint =
        'Stored in project SQLite (`team:enrollment`). No files were written to the repository.'
      const nextSteps = [
        '1. Teammates install prjct once: `curl -sSL https://raw.githubusercontent.com/prjct-app/cli/main/scripts/install-standalone.sh | bash` (or `npm install -g prjct-cli@latest`).',
        '2. Each teammate runs `prjct team --required` in their clone to record the same expectation locally.',
        '3. Verify anytime with `prjct team check`.',
      ].join('\n')

      if (options.md) {
        console.log(
          mdOutput(
            mdSection('Team mode enrolled', summary),
            mdSection('Stored', storedHint),
            mdSection('Next', nextSteps)
          )
        )
      } else {
        out.done(summary)
        console.log(storedHint)
        console.log('\nNext steps:')
        console.log(nextSteps)
      }

      return {
        success: true,
        teamConfig,
        staged: false,
      }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }

  /**
   * `prjct team check` — report the stored enrollment.
   *
   * Previously a mirror drift detector that healed `.prjct/team.json`
   * from the DB. With no mirror there is no drift to detect: SQLite is
   * the only copy, so this reads it back. A legacy mirror left by an
   * older install is not read here — `prjct sync` adopts and deletes it.
   */
  async check(
    projectPath: string = process.cwd(),
    options: TeamOptions = {}
  ): Promise<CommandResult> {
    try {
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        return failHard('No prjct project. Run `prjct init` first.', options)
      }

      const dbRow = teamEnrollmentStorage.get(projectId)
      if (dbRow === null) {
        const msg = '✓ team check: no enrollment configured'
        if (options.md) console.log(`> ${msg}`)
        else out.done(msg)
        return { success: true, empty: true }
      }

      const msg = `✓ team check: ${dbRow.required ? 'required' : 'optional'} — minVersion ${dbRow.minVersion}`
      if (options.md) console.log(`> ${msg}`)
      else out.done(msg)
      return { success: true, empty: false, teamConfig: dbRow }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }
}
