/**
 * `prjct tdd` — opt-in Test-Driven Development discipline (same shape as
 * `prjct lean`: one registered verb, subcommand-parsed, a single file).
 *
 *   prjct tdd                     → show mode + the detected test command
 *   prjct tdd off|assist|strict   → set intensity (writes config.tdd)
 *   prjct tdd check               → run the project's test command (red/green)
 *
 * Philosophy (mirrors `lean`): `off` is the default and changes nothing. The
 * CLI carries no enforcement engine — it sets the mode, runs the detected test
 * command on demand (`check`), and the skill guidance + the `ship` TDD gate
 * make the agent work test-first and not ship on red. The test command is
 * auto-detected per stack via `detectProjectCommands`, so nothing to configure.
 */

import configManager from '../infrastructure/config-manager'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import type { LocalConfig } from '../types/config'
import { getErrorMessage } from '../types/fs'
import { execAsync } from '../utils/exec'
import { failWith } from '../utils/md-aware'
import { mdOutput } from '../utils/md-formatter'
import out from '../utils/output'
import { detectProjectCommands } from '../utils/project-commands'
import { PrjctCommandsBase } from './base'
import { parseModeSubcommand, requireProjectConfig } from './mode-command-helpers'

type TddMode = 'off' | 'assist' | 'strict'
const TDD_MODES: readonly TddMode[] = ['off', 'assist', 'strict']

export class TddCommands extends PrjctCommandsBase {
  async tdd(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    const parsed = parseModeSubcommand(input, TDD_MODES)
    if (parsed.kind === 'status') return this.showStatus(projectPath, options)
    if (parsed.kind === 'mode') return this.setMode(parsed.mode as TddMode, projectPath, options)
    if (parsed.sub === 'check') return this.check(projectPath, options)
    return failWith(
      `Unknown tdd subcommand "${parsed.sub}". Use: check, or ${TDD_MODES.join('|')}.`,
      options
    )
  }

  /** Effective mode + the detected test command (what `check`/`ship` use). */
  private async showStatus(projectPath: string, options: MdOption): Promise<CommandResult> {
    const guard = await requireProjectConfig(projectPath, options)
    if (!guard.ok) return guard.result
    const config = guard.value

    const mode = effectiveTddMode(config)
    const detected = await detectProjectCommands(projectPath).catch(() => null)
    const testCmd = detected?.test?.command ?? null
    const summary = [
      `Mode: ${mode}${mode === 'off' ? ' (guidance + ship TDD gate dormant)' : ''}`,
      `Test command: ${testCmd ?? 'none detected (add tests to enable the gate)'}`,
      'Set:   prjct tdd off|assist|strict',
      'Check: prjct tdd check   — run the test command now (red/green)',
    ]
    if (options.md) {
      console.log(
        mdOutput(
          '## TDD',
          `> **Mode**: \`${mode}\``,
          `- Test command: \`${testCmd ?? 'none detected'}\``,
          summary.slice(2).join('\n')
        )
      )
    } else {
      out.info(`TDD — ${summary.join('\n  ')}`)
    }
    return { success: true, mode, testCommand: testCmd }
  }

  /** Persist the intensity to `config.tdd.mode`. */
  private async setMode(
    mode: TddMode,
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const guard = await requireProjectConfig(projectPath, options)
    if (!guard.ok) return guard.result
    const config = guard.value

    config.tdd = { mode }
    await configManager.writeConfig(projectPath, config)

    const msg =
      mode === 'off'
        ? 'TDD mode off — test-first guidance and the ship TDD gate are dormant.'
        : mode === 'assist'
          ? 'TDD mode → assist. Guidance biases test-first (red→green→refactor); `ship` reminds.'
          : "TDD mode → strict. Test-first expected; `ship` surfaces a hard gate — run `prjct tdd check` and don't ship on red."
    if (options.md) console.log(mdOutput('## TDD', `> ${msg}`))
    else out.done(msg)
    return { success: true, mode }
  }

  /** Run the detected test command and report red/green — the real teeth. */
  private async check(projectPath: string, options: MdOption): Promise<CommandResult> {
    const detected = await detectProjectCommands(projectPath).catch(() => null)
    const testCmd = detected?.test?.command
    if (!testCmd) {
      const msg = 'tdd check: no test command detected for this stack. Add a test script first.'
      console.log(options.md ? mdOutput('## TDD check', `> ${msg}`) : msg)
      return { success: false, reason: 'no_test_command' }
    }
    try {
      await execAsync(testCmd, { cwd: projectPath, maxBuffer: 32 * 1024 * 1024 })
      const msg = `tdd check: GREEN — \`${testCmd}\` passed.`
      console.log(options.md ? mdOutput('## TDD check', `> ✅ ${msg}`) : msg)
      return { success: true, green: true, testCommand: testCmd }
    } catch (error) {
      const msg = `tdd check: RED — \`${testCmd}\` failed. Fix before shipping.`
      if (options.md) console.log(mdOutput('## TDD check', `> ❌ ${msg}`, getErrorMessage(error)))
      else {
        out.fail(msg)
        out.info(getErrorMessage(error))
      }
      return { success: false, green: false, testCommand: testCmd }
    }
  }
}

/** Config wins; `PRJCT_TDD_MODE` env is the fallback. Unknown ⇒ `off`. */
export function effectiveTddMode(config: LocalConfig | null): TddMode {
  const fromConfig = config?.tdd?.mode
  if (fromConfig && (TDD_MODES as readonly string[]).includes(fromConfig)) return fromConfig
  const fromEnv = process.env.PRJCT_TDD_MODE?.toLowerCase()
  if (fromEnv && (TDD_MODES as readonly string[]).includes(fromEnv)) return fromEnv as TddMode
  return 'off'
}

/** Exported for unit tests. */
export const _internal = { effectiveTddMode, TDD_MODES }
