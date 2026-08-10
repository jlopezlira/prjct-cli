/**
 * `prjct sdd` — opt-in Spec-Driven Development discipline (same shape as
 * `prjct lean`/`tdd`: one registered verb, subcommand-parsed, a single file).
 *
 *   prjct sdd                       → show mode + the active work's spec station
 *   prjct sdd off|advisory|strict   → set intensity (writes config.sdd)
 *
 * prjct already HAS the spec pipeline (intent/spec → audit-spec → work --spec → ship);
 * this only gates it. `off` (default) changes nothing — the pipeline stays
 * escalate-only. `advisory` nudges (skill + the existing ship acceptance
 * surface). `strict` enforces: every `prjct work` cycle must link a REVIEWED spec
 * (gate lives in task-service so CLI + MCP share it) and `ship` blocks work
 * with no linked spec (`--no-spec-gate` overrides). The CLI carries no
 * enforcement engine beyond those gates — the agent walks the stations.
 */

import configManager from '../infrastructure/config-manager'
import { resolveActiveTask } from '../services/task-service'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import type { LocalConfig } from '../types/config'
import { failHard, failWith } from '../utils/md-aware'
import { mdOutput } from '../utils/md-formatter'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

type SddMode = 'off' | 'advisory' | 'strict'
const SDD_MODES: readonly SddMode[] = ['off', 'advisory', 'strict']

// The pipeline stations, in order — rendered as a checklist against the
// active work cycle's linked spec status so a dev can see where the work stands.
const STATIONS: ReadonlyArray<{ key: string; reached: (status: string) => boolean }> = [
  { key: 'spec drafted', reached: () => true },
  { key: 'audit-spec passed (reviewed)', reached: (s) => s !== 'draft' },
  { key: 'task linked', reached: (s) => s === 'in_progress' || s === 'shipped' },
  { key: 'shipped', reached: (s) => s === 'shipped' },
]

export class SddCommands extends PrjctCommandsBase {
  async sdd(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    const parts = (input ?? '').trim().split(/\s+/).filter(Boolean)
    const sub = (parts[0] ?? '').toLowerCase()

    if (!sub || sub === 'status' || sub === 'show') return this.showStatus(projectPath, options)
    if ((SDD_MODES as readonly string[]).includes(sub)) {
      return this.setMode(sub as SddMode, projectPath, options)
    }
    return failWith(`Unknown sdd subcommand "${sub}". Use: ${SDD_MODES.join('|')}.`, options)
  }

  /** Mode + the active work cycle's spec station (the pipeline as a checklist). */
  private async showStatus(projectPath: string, options: MdOption): Promise<CommandResult> {
    const config = await configManager.readConfig(projectPath).catch(() => null)
    if (!config?.projectId)
      return failHard('No prjct project here — run `prjct init` first.', options)

    const mode = effectiveSddMode(config)
    const status = await (async () => {
      try {
        const active = await resolveActiveTask(config.projectId, projectPath)
        if (active?.linkedSpecId) {
          const { specService } = await import('../services/spec-service')
          const spec = await specService.get(projectPath, active.linkedSpecId)
          if (spec) {
            return {
              specLine: `Active spec: \`${spec.title}\` (${spec.status})`,
              station: STATIONS.map((s) => `${s.reached(spec.status) ? '✓' : '○'} ${s.key}`).join(
                '  '
              ),
            }
          }
        } else if (active) {
          return {
            specLine: 'Active work cycle has NO linked spec',
            station: 'no active work cycle',
          }
        }
        return { specLine: 'Active spec: none', station: 'no active work cycle' }
      } catch {
        return { specLine: 'Active spec: none', station: 'no active work cycle' }
      }
    })()

    const lines = [
      `Mode: ${mode}${mode === 'off' ? ' (pipeline stays escalate-only)' : ''}`,
      status.specLine,
      `Pipeline: ${status.station}`,
      'Set: prjct sdd off|advisory|strict',
    ]
    if (options.md) {
      console.log(mdOutput('## SDD', `> **Mode**: \`${mode}\``, lines.slice(1).join('\n')))
    } else {
      out.info(`SDD — ${lines.join('\n  ')}`)
    }
    return { success: true, mode }
  }

  /** Persist the intensity to `config.sdd.mode`. */
  private async setMode(
    mode: SddMode,
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const config = await configManager.readConfig(projectPath).catch(() => null)
    if (!config?.projectId)
      return failHard('No prjct project here — run `prjct init` first.', options)

    config.sdd = { mode }
    await configManager.writeConfig(projectPath, config)

    const msg =
      mode === 'off'
        ? 'SDD mode off — the spec pipeline stays escalate-only (no gating).'
        : mode === 'advisory'
          ? 'SDD mode → advisory. The skill nudges toward a spec for complex work; `ship` surfaces acceptance criteria.'
          : 'SDD mode → strict. Every `prjct work` cycle must link a REVIEWED intent/spec, and `ship` blocks unspecced work (override: `prjct ship --no-spec-gate`).'
    if (options.md) console.log(mdOutput('## SDD', `> ${msg}`))
    else out.done(msg)
    return { success: true, mode }
  }
}

/** Config wins; `PRJCT_SDD_MODE` env is the fallback. Unknown ⇒ `off`. */
export function effectiveSddMode(config: LocalConfig | null): SddMode {
  const fromConfig = config?.sdd?.mode
  if (fromConfig && (SDD_MODES as readonly string[]).includes(fromConfig)) return fromConfig
  const fromEnv = process.env.PRJCT_SDD_MODE?.toLowerCase()
  if (fromEnv && (SDD_MODES as readonly string[]).includes(fromEnv)) return fromEnv as SddMode
  return 'off'
}

/** Exported for unit tests. */
export const _internal = { effectiveSddMode, SDD_MODES }
