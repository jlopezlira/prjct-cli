/**
 * Host-session rollover policy.
 *
 * Work-cycle limits cannot bound a host conversation: several healthy cycles
 * can still accumulate hundreds of turns in one expensive session. This
 * verdict uses the host's stable session identity and an explicitly configured
 * project limit. It emits only on threshold transitions and stops project
 * tools at the limit; a new session id resets naturally.
 */

import type { LocalConfig } from '../types/config'

const WARNING_RATIO = 0.8
export const CODE_SESSION_TURN_LIMIT = 100

export interface SessionRolloverVerdict {
  level: 'ok' | 'warn' | 'stopped'
  stopped: boolean
  turns: number
  limit: number
  cue: string | null
}

export function sessionRolloverLimit(
  config: Pick<LocalConfig, 'maxTurnsPerSession' | 'persona'> | null | undefined
): number {
  const configured = config?.maxTurnsPerSession
  const packs = config?.persona?.packs ?? []
  const codeDefault = packs.some((pack) => pack === 'code' || pack === 'code-strict')
    ? CODE_SESSION_TURN_LIMIT
    : 0
  // Explicit zero disables the pack default; global project policy always wins.
  return configured ?? codeDefault
}

export function sessionRolloverVerdict(
  config: Pick<LocalConfig, 'maxTurnsPerSession' | 'persona'> | null | undefined,
  turns: number | null | undefined
): SessionRolloverVerdict {
  const limit = sessionRolloverLimit(config)
  const measuredTurns = Math.max(0, turns ?? 0)
  if (limit <= 0 || measuredTurns <= 0) {
    return { level: 'ok', stopped: false, turns: measuredTurns, limit, cue: null }
  }

  if (measuredTurns >= limit) {
    return {
      level: 'stopped',
      stopped: true,
      turns: measuredTurns,
      limit,
      cue: [
        '# prjct: SESSION ROLLOVER REQUIRED',
        `This host session reached its configured ${limit}-turn limit. Project tools are stopped here.`,
        'Run `prjct land --md`, start a fresh host session (do not resume this one), then run `prjct prime --md` to restore the compact hand-off.',
      ].join('\n'),
    }
  }

  if (measuredTurns >= Math.ceil(limit * WARNING_RATIO)) {
    return {
      level: 'warn',
      stopped: false,
      turns: measuredTurns,
      limit,
      cue: [
        '# prjct: session rollover approaching (80%)',
        `This host session crossed the warning boundary for its ${limit}-turn limit.`,
        'Finish the current atomic step; then `prjct land --md`, start a fresh host session (do not resume this one), and run `prjct prime --md`.',
      ].join('\n'),
    }
  }

  return { level: 'ok', stopped: false, turns: measuredTurns, limit, cue: null }
}

/** Only the exact hand-off command stays available after a hard rollover. */
export function isSessionRolloverSafeCommand(command: string): boolean {
  return /^prjct\s+land(?:\s+--md)?$/.test(command.trim())
}
