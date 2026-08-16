/**
 * Shared scaffold for the small "mode commands" (`sdd`, `tdd`, `notify`,
 * `lean`) — each parses a first token into status/mode/unknown, then gates
 * on having a prjct project before reading/writing `config.<domain>.mode`.
 *
 * `cloud.ts` looks similar on the surface (it also short-circuits `status`)
 * but routes everything else to a full subcommand switch (link/unlink/sync/
 * pull/pause/resume) rather than a fixed mode list, and already has its own
 * `readProject` + null-check idiom — it doesn't share this shape and isn't
 * wired to these helpers.
 */

import configManager from '../infrastructure/config-manager'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import type { LocalConfig } from '../types/config'
import { failHard } from '../utils/md-aware'

export type ModeSubcommand =
  | { kind: 'status' }
  | { kind: 'mode'; mode: string }
  | { kind: 'unknown'; sub: string }

/**
 * Classify a mode-command's first token: no token (or `status`/`show`) is
 * a status request, a token in `validModes` sets that mode, anything else
 * is unknown — the caller decides how to report it, since some mode
 * commands have extra subcommands (`tdd check`, `lean review|audit|debt`).
 */
export function parseModeSubcommand(
  input: string | null,
  validModes: readonly string[]
): ModeSubcommand {
  const parts = (input ?? '').trim().split(/\s+/).filter(Boolean)
  const sub = (parts[0] ?? '').toLowerCase()
  if (!sub || sub === 'status' || sub === 'show') return { kind: 'status' }
  if (validModes.includes(sub)) return { kind: 'mode', mode: sub }
  return { kind: 'unknown', sub }
}

type ConfigGuard = { ok: true; value: LocalConfig } | { ok: false; result: CommandResult }

/**
 * Read the project config or fail with the uniform "no project here"
 * message. Every mode command's `showStatus`/`setMode` (and lean's
 * review/audit/debt) opened with this exact three-line check.
 */
export async function requireProjectConfig(
  projectPath: string,
  options: MdOption = {}
): Promise<ConfigGuard> {
  const config = await configManager.readConfig(projectPath).catch(() => null)
  if (!config?.projectId) {
    return {
      ok: false,
      result: failHard('No prjct project here — run `prjct init` first.', options),
    }
  }
  return { ok: true, value: config }
}
