/**
 * `prjct review-risk [--md]` — advisory size/delivery-geometry signal.
 * Never gates (use deliveryGeometry strict on work start for hard gates).
 */

import type { ReviewIntensity } from '../schemas/judgment'
import {
  computeCommittedChangeset,
  type DeliveryGeometry,
  type DeliveryTier,
  geometryOf,
  tierOf,
} from '../services/delivery-geometry'
import { intensityProtocol, routeIntensity } from '../services/precision-judgment'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { failHard } from '../utils/md-aware'
import { PrjctCommandsBase } from './base'
import { requireProject } from './guards'

export class ReviewRiskCommands extends PrjctCommandsBase {
  async reviewRisk(
    _arg: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const cs = await computeCommittedChangeset(projectPath)
      if (!cs) {
        const msg = 'review-risk: no comparable changeset (no base branch or nothing committed).'
        console.log(options.md ? `## Review risk\n\n_${msg}_\n` : msg)
        return {
          success: true,
          tier: 'trivial',
          files: 0,
          loc: 0,
          geometry: geometryOf('trivial'),
          intensity: 'skip' as ReviewIntensity,
        }
      }

      const tier = tierOf(cs)
      const geometry = geometryOf(tier)
      const intensity = routeIntensity(tier, { paths: cs.dirs })
      const protocol = intensityProtocol(intensity)

      // Optional structural blast/risk when symbol index exists
      const blastNote = await (async () => {
        try {
          const proj = await requireProject(projectPath, options)
          if (!proj.ok) return ''
          const { hasSymbolIndex } = await import('../domain/symbol-graph')
          if (!hasSymbolIndex(proj.value)) return ''
          const { detectChanges } = await import('../services/detect-changes')
          const det = await detectChanges(projectPath, proj.value, { source: 'committed' })
          return det.changedFiles.length > 0
            ? `Structural risk: critical=${det.summary.critical} high=${det.summary.high} medium=${det.summary.medium} low=${det.summary.low} · blast ${det.affectedFiles.length} files`
            : ''
        } catch {
          return ''
        }
      })()

      console.log(
        options.md
          ? formatMd(cs, tier, geometry, intensity, protocol, blastNote)
          : formatText(cs, tier, geometry, intensity, protocol, blastNote)
      )
      return { success: true, tier, files: cs.files, loc: cs.loc, geometry, intensity }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }
}

function suggestion(geometry: DeliveryGeometry, dirs: string[]): string {
  if (geometry === 'direct') return 'Small + low-risk — fine to land directly or as one tiny PR.'
  if (geometry === 'single') return 'Cohesive — one reviewable PR.'
  const along =
    dirs.length > 1
      ? ` Natural split lines: ${dirs.join(', ')}.`
      : ' Consider splitting by concern even within this area.'
  return `Large — hard to review in one pass. Consider stacked PRs.${along}`
}

function formatText(
  cs: { base: string; files: number; loc: number; dirs: string[] },
  tier: DeliveryTier,
  geometry: DeliveryGeometry,
  intensity: ReviewIntensity,
  protocol: ReturnType<typeof intensityProtocol>,
  blastNote = ''
): string {
  return [
    `Review risk: ${tier.toUpperCase()} — ${cs.files} files, ${cs.loc} LOC vs ${cs.base}`,
    `Delivery: ${geometry} — ${suggestion(geometry, cs.dirs)}`,
    `Judgment intensity: ${intensity} — ${protocol.reviewers}`,
    `  severity floor: ${protocol.severityFloor}`,
    ...(blastNote ? [`  ${blastNote}`] : []),
    `  next: prjct judgment plan | open  (ledger + ship gate)`,
    '(advisory for delivery; judgment ledger enforces intensity on code-strict ship)',
  ].join('\n')
}

function formatMd(
  cs: { base: string; files: number; loc: number; dirs: string[] },
  tier: DeliveryTier,
  geometry: DeliveryGeometry,
  intensity: ReviewIntensity,
  protocol: ReturnType<typeof intensityProtocol>,
  blastNote = ''
): string {
  return [
    '## Review risk',
    '',
    `- **Tier**: ${tier}`,
    `- **Changeset**: ${cs.files} files, ${cs.loc} LOC (vs \`${cs.base}\`)`,
    `- **Dirs touched**: ${cs.dirs.join(', ') || '—'}`,
    `- **Suggested delivery**: \`${geometry}\` — ${suggestion(geometry, cs.dirs)}`,
    `- **Judgment intensity**: \`${intensity}\` — ${protocol.reviewers}`,
    `- **Severity floor**: ${protocol.severityFloor}`,
    `- **Max fix rounds**: ${protocol.maxFixRounds}`,
    ...(blastNote ? [`- **${blastNote}**`] : []),
    '',
    '_Delivery is advisory. On code-strict packs, `prjct ship` hard-gates on `prjct judgment` ledger.approved._',
  ].join('\n')
}

export const _internal = { tierOf, geometryOf }
