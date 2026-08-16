/**
 * `prjct notify` — desktop notifications toggle (default ON).
 *
 *   prjct notify            → show mode + what fires
 *   prjct notify on|off     → set config.notify.mode
 *
 * prjct pings you (best-effort OS notification) when Claude is waiting for
 * input and when a subagent finishes — so a wait never hangs silently. The
 * mode resolver + the desktop-notify primitive live in `utils/notify.ts` so
 * the cold-path hooks share them without importing this command.
 */

import configManager from '../infrastructure/config-manager'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { failWith } from '../utils/md-aware'
import { mdOutput } from '../utils/md-formatter'
import { effectiveNotifyMode, NOTIFY_MODES, type NotifyMode } from '../utils/notify'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'
import { parseModeSubcommand, requireProjectConfig } from './mode-command-helpers'

export class NotifyCommands extends PrjctCommandsBase {
  async notify(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    const parsed = parseModeSubcommand(input, NOTIFY_MODES)
    if (parsed.kind === 'status') return this.showStatus(projectPath, options)
    if (parsed.kind === 'mode') return this.setMode(parsed.mode as NotifyMode, projectPath, options)
    return failWith(
      `Unknown notify subcommand "${parsed.sub}". Use: ${NOTIFY_MODES.join('|')}.`,
      options
    )
  }

  private async showStatus(projectPath: string, options: MdOption): Promise<CommandResult> {
    const guard = await requireProjectConfig(projectPath, options)
    if (!guard.ok) return guard.result
    const config = guard.value

    const mode = effectiveNotifyMode(config)
    const summary = [
      `Mode: ${mode}${mode === 'on' ? ' (default)' : ''}`,
      'Fires on: Claude waiting for input · a subagent finishing',
      'Set: prjct notify on|off',
    ]
    if (options.md) {
      console.log(mdOutput('## Notify', `> **Mode**: \`${mode}\``, summary.slice(1).join('\n')))
    } else {
      out.info(`Notify — ${summary.join('\n  ')}`)
    }
    return { success: true, mode }
  }

  private async setMode(
    mode: NotifyMode,
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const guard = await requireProjectConfig(projectPath, options)
    if (!guard.ok) return guard.result
    const config = guard.value

    config.notify = { mode }
    await configManager.writeConfig(projectPath, config)

    const msg =
      mode === 'on'
        ? 'Desktop notifications ON — pings on Claude-waiting + subagent-finished.'
        : 'Desktop notifications OFF — silenced (the per-prompt work-state block stays).'
    if (options.md) console.log(mdOutput('## Notify', `> ${msg}`))
    else out.done(msg)
    return { success: true, mode }
  }
}
