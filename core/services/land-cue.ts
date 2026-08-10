/**
 * Session-close land cue — inject a short checklist when a cycle is open.
 * Used by SessionStart (advisory) and Stop (strict packs).
 * Also surfaces context-pressure when the cycle is filling (GSD utilization guard)
 * and a prior Judgment Receipt within 24h (closed-loop proof).
 */

import type { LocalConfig } from '../types/config'
import { contextPressureVerdict } from './context-pressure'
import { latestJudgmentReceipt24h } from './judgment-receipt'
import { collectActiveTasks } from './task-overview'

export type LandMode = 'off' | 'advisory' | 'strict'

export function effectiveLandMode(config: LocalConfig | null | undefined): LandMode {
  return config?.land?.mode ?? 'advisory'
}

/**
 * One short block for hooks. Returns null when land is off or nothing to do
 * (no open cycle AND no recent receipt cue).
 */
export async function buildLandCue(
  projectId: string,
  projectPath: string,
  config: LocalConfig | null | undefined
): Promise<string | null> {
  const mode = effectiveLandMode(config)
  if (mode === 'off') return null

  const overview = await collectActiveTasks(projectId, projectPath).catch(() => null)
  const receipt = latestJudgmentReceipt24h(projectId)

  if (!overview?.current && !receipt) return null

  const lines: string[] = []

  if (overview?.current) {
    const title = overview.current.description.slice(0, 60)
    // Load turn/token counters from live state — ActiveTaskView is display-only.
    const live = overview.current.isCurrent
      ? await import('../storage/state-storage')
          .then(({ stateStorage }) => stateStorage.getCurrentTask(projectId))
          .catch(() => null)
      : null
    const pressure = contextPressureVerdict(config, {
      description: overview.current.description,
      turnCount: live?.turnCount,
      tokensIn: live?.tokensIn,
      tokensOut: live?.tokensOut,
    })
    const hard = mode === 'strict' || pressure.level === 'critical' || pressure.level === 'warn'
    const head = hard ? `# prjct: LAND REQUIRED before context dies` : `# prjct: land the plane`
    lines.push(
      head,
      `Open cycle: "${title}${overview.current.description.length > 60 ? '…' : ''}"`,
      hard
        ? 'Before ending the session: `prjct status done` or `prjct log "…"`, then `prjct land` (auto-synthesizes the Session close hand-off — no manual remember). Next window: `prjct prime`.'
        : 'Before ending the session: `prjct land` (auto hand-off + judgment receipt) · optional `prjct memory export` for the team.'
    )
    if (pressure.cue) lines.push('', pressure.cue)
  }

  if (receipt) {
    if (lines.length > 0) lines.push('')
    const trapBit =
      receipt.trapCount > 0
        ? `${receipt.trapCount} trap(s) re-surfaced last session`
        : 'judgment continuity landed last session'
    lines.push(
      `# prjct: prior judgment receipt (24h)`,
      `${trapBit} · \`${receipt.id}\` — closed-loop proof, not bulk memory. \`prjct search "judgment-receipt"\` if you need the full receipt.`
    )
  }

  return lines.length > 0 ? lines.join('\n') : null
}
