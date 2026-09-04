/**
 * `prjct config` — read/write the global config at
 * `~/.prjct-cli/config/global.json`.
 *
 * Subcommands:
 *   list                Show all keys + values
 *   get <key>           Read one value
 *   set <key> <value>   Write one value (booleans as 'on'/'off',
 *                       numbers parsed automatically)
 *   unset <key>         Remove a key
 *
 * Anti-harness contract: this is a deterministic file editor, no
 * network, no LLM mediation, no auto-updates triggered as a side
 * effect.
 */

import configManager from '../infrastructure/config-manager'
import { configPath, getAll, getConfig, setConfig, unsetConfig } from '../services/global-config'
import type { CommandResult } from '../types/commands'
import { mdOutput, mdSection } from '../utils/md-formatter'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

interface ConfigOptions {
  md?: boolean
}

export class ConfigCommands extends PrjctCommandsBase {
  async config(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: ConfigOptions = {}
  ): Promise<CommandResult> {
    const parts = (input ?? '').trim().split(/\s+/).filter(Boolean)
    const sub = parts[0] ?? 'list'

    switch (sub) {
      case 'list':
        return this.list(options)
      case 'get':
        return this.get(parts[1], options)
      case 'set':
        return this.set(parts[1], parts.slice(2).join(' '), options)
      case 'unset':
        return this.unset(parts[1], options)
      case 'migrate-project-settings':
        return this.migrateProjectSettings(projectPath, parts[1] === 'confirm', options)
      default:
        out.fail(
          `Unknown config subcommand: ${sub}. Use: list, get <k>, set <k> <v>, unset <k>, migrate-project-settings [confirm].`
        )
        return { success: false, error: 'Unknown config subcommand' }
    }
  }

  private list(options: ConfigOptions): CommandResult {
    const all = getAll()
    const keys = Object.keys(all).sort()
    if (options.md) {
      const body =
        keys.length === 0
          ? '_No global config set._'
          : keys.map((k) => `- \`${k}\`: \`${JSON.stringify(all[k])}\``).join('\n')
      console.log(
        mdOutput(mdSection('Global config', body), mdSection('Path', `\`${configPath()}\``))
      )
    } else {
      if (keys.length === 0) {
        out.info('No global config set.')
      } else {
        for (const k of keys) console.log(`  ${k} = ${JSON.stringify(all[k])}`)
      }
    }
    return { success: true, config: all }
  }

  private get(key: string | undefined, options: ConfigOptions): CommandResult {
    if (!key) {
      out.fail('Usage: prjct config get <key>')
      return { success: false, error: 'Missing key' }
    }
    const value = getConfig(key as never)
    if (options.md) {
      console.log(
        mdOutput(mdSection(key, value === undefined ? '_(unset)_' : `\`${JSON.stringify(value)}\``))
      )
    } else if (value === undefined) {
      out.info(`(unset)`)
    } else {
      console.log(JSON.stringify(value))
    }
    return { success: true, key, value }
  }

  private set(
    key: string | undefined,
    rawValue: string | undefined,
    options: ConfigOptions
  ): CommandResult {
    if (!key || rawValue === undefined || rawValue === '') {
      out.fail('Usage: prjct config set <key> <value>')
      return { success: false, error: 'Missing key or value' }
    }
    const parsed = parseValue(rawValue)
    setConfig(key as never, parsed as never)
    const msg = `${key} = ${JSON.stringify(parsed)}`
    if (options.md) {
      console.log(mdOutput(mdSection('Set', msg)))
    } else {
      out.done(msg)
    }
    return { success: true, key, value: parsed }
  }

  private unset(key: string | undefined, options: ConfigOptions): CommandResult {
    if (!key) {
      out.fail('Usage: prjct config unset <key>')
      return { success: false, error: 'Missing key' }
    }
    unsetConfig(key as never)
    const msg = `Removed ${key}`
    if (options.md) {
      console.log(mdOutput(mdSection('Unset', msg)))
    } else {
      out.done(msg)
    }
    return { success: true, key }
  }

  private async migrateProjectSettings(
    projectPath: string,
    confirmed: boolean,
    options: ConfigOptions
  ): Promise<CommandResult> {
    const recovered = await configManager.previewLegacyProjectSettings(projectPath)
    if (!recovered) {
      const message = 'No recoverable legacy project settings were found.'
      if (options.md) console.log(mdOutput(mdSection('Project settings migration', message)))
      else out.info(message)
      return { success: true, migrated: false }
    }
    if (!confirmed) {
      const preview = JSON.stringify(recovered, null, 2)
      const instruction =
        'Nothing was imported. Review the settings above, then run `prjct config migrate-project-settings confirm` to apply them globally.'
      if (options.md) {
        console.log(
          mdOutput(
            mdSection('Recovered legacy project settings', `\`\`\`json\n${preview}\n\`\`\``),
            mdSection('Confirmation required', instruction)
          )
        )
      } else {
        console.log(preview)
        out.info(instruction)
      }
      return { success: false, migrated: false, confirmationRequired: true, settings: recovered }
    }

    const migrated = await configManager.migrateLegacyProjectSettings(projectPath, {
      allowGitRecovery: true,
    })
    const message = migrated
      ? 'Recovered settings were imported into the global project store.'
      : 'No settings were imported.'
    if (options.md) console.log(mdOutput(mdSection('Project settings migration', message)))
    else out.done(message)
    return { success: migrated, migrated }
  }
}

function parseValue(raw: string): string | number | boolean {
  const lower = raw.toLowerCase()
  if (lower === 'true' || lower === 'on') return 'on'
  if (lower === 'false' || lower === 'off') return 'off'
  const num = Number(raw)
  if (!Number.isNaN(num) && /^-?\d+(\.\d+)?$/.test(raw)) return num
  return raw
}
