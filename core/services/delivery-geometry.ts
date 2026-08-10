/**
 * Delivery-geometry signal — size of the work vs reviewability.
 * Shared by `prjct review-risk` (advisory) and work-start gates (strict packs).
 */

import { gitStdout } from '../utils/exec'

export type DeliveryTier = 'trivial' | 'normal' | 'large'
export type DeliveryGeometry = 'direct' | 'single' | 'split'

export const TRIVIAL_MAX_FILES = 2
export const TRIVIAL_MAX_LOC = 20
export const NORMAL_MAX_FILES = 10
/** Soft threshold from gentle-ai "Review Workload Forecast" — above = decide geometry. */
export const NORMAL_MAX_LOC = 400

export interface Changeset {
  base: string
  files: number
  loc: number
  dirs: string[]
  /** committed | working-tree */
  source: 'committed' | 'working-tree' | 'none'
}

export function tierOf(cs: Pick<Changeset, 'files' | 'loc'>): DeliveryTier {
  if (cs.files <= TRIVIAL_MAX_FILES && cs.loc <= TRIVIAL_MAX_LOC) return 'trivial'
  if (cs.files <= NORMAL_MAX_FILES && cs.loc <= NORMAL_MAX_LOC) return 'normal'
  return 'large'
}

export function geometryOf(tier: DeliveryTier): DeliveryGeometry {
  if (tier === 'trivial') return 'direct'
  if (tier === 'normal') return 'single'
  return 'split'
}

// Typed chokepoint: exit codes stay domain negatives (null — e.g. no default
// branch, no merge-base); git timeout/spawn throws GitInfraError so a strict
// geometry gate can refuse instead of silently passing (callers catch and
// decide the polarity of their gate).
async function safeGit(projectPath: string, args: string[]): Promise<string | null> {
  return gitStdout(projectPath, args)
}

function parseShortstat(shortstat: string): { files: number; loc: number } {
  const filesM = shortstat.match(/(\d+) files? changed/)
  const insM = shortstat.match(/(\d+) insertions?/)
  const delM = shortstat.match(/(\d+) deletions?/)
  const files = filesM ? Number.parseInt(filesM[1]!, 10) : 0
  const loc =
    (insM ? Number.parseInt(insM[1]!, 10) : 0) + (delM ? Number.parseInt(delM[1]!, 10) : 0)
  return { files, loc }
}

/** Committed range vs merge-base with default branch (review-risk path). */
export async function computeCommittedChangeset(projectPath: string): Promise<Changeset | null> {
  const originHead = await safeGit(projectPath, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])
  const defaultRef =
    originHead && originHead !== 'origin/HEAD'
      ? originHead
      : await (async () => {
          for (const candidate of ['main', 'master']) {
            if (
              (await safeGit(projectPath, ['rev-parse', '--verify', '--quiet', candidate])) !== null
            ) {
              return candidate
            }
          }
          return ''
        })()
  if (!defaultRef) return null

  const base = await safeGit(projectPath, ['merge-base', defaultRef, 'HEAD'])
  if (!base) return null
  const headSha = await safeGit(projectPath, ['rev-parse', 'HEAD'])
  if (!headSha || headSha === base) return null

  const shortstat = await safeGit(projectPath, ['diff', '--shortstat', `${base}..HEAD`])
  if (shortstat === null) return null
  const { files, loc } = parseShortstat(shortstat)
  const names = (await safeGit(projectPath, ['diff', '--name-only', `${base}..HEAD`])) ?? ''
  const dirs = [
    ...new Set(
      names
        .split('\n')
        .filter(Boolean)
        .map((f) => (f.includes('/') ? f.slice(0, f.indexOf('/')) : '.'))
    ),
  ].sort()

  return { base: base.slice(0, 7), files, loc, dirs, source: 'committed' }
}

/** Uncommitted working tree (staged + unstaged) — gate before more implementation. */
export async function computeWorkingTreeChangeset(projectPath: string): Promise<Changeset | null> {
  const shortstat = await safeGit(projectPath, ['diff', '--shortstat', 'HEAD'])
  const cached = await safeGit(projectPath, ['diff', '--shortstat', '--cached'])
  if (shortstat === null && cached === null) return null
  const a = parseShortstat(shortstat ?? '')
  const b = parseShortstat(cached ?? '')
  const files = Math.max(a.files, b.files)
  const loc = a.loc + b.loc
  if (files === 0 && loc === 0) return null
  const names =
    (await safeGit(projectPath, ['diff', '--name-only', 'HEAD'])) ??
    (await safeGit(projectPath, ['diff', '--name-only', '--cached'])) ??
    ''
  const dirs = [
    ...new Set(
      names
        .split('\n')
        .filter(Boolean)
        .map((f) => (f.includes('/') ? f.slice(0, f.indexOf('/')) : '.'))
    ),
  ].sort()
  return { base: 'HEAD', files, loc, dirs, source: 'working-tree' }
}

export function geometryBlockMessage(cs: Changeset, geometry: DeliveryGeometry): string {
  const dirs = cs.dirs.length > 1 ? ` Natural split lines: ${cs.dirs.slice(0, 6).join(', ')}.` : ''
  return (
    `Delivery geometry gate: ${cs.loc} LOC / ${cs.files} files (${cs.source}) → ` +
    `suggested \`${geometry}\`.${dirs} Decide explicitly: ` +
    `\`prjct work "<intent>" --geometry split|single|direct\` ` +
    `or split the tree before continuing. (Relax: \`prjct config\` deliveryGeometry off.)`
  )
}

export interface IntentGeometryVerdict {
  blocked: boolean
  message: string | null
  reason:
    | 'none'
    | 'not-large'
    | 'has-geometry'
    | 'h2-intent-advisory'
    | 'h2-intent-strict'
    | 'tree-strict'
  geometry: DeliveryGeometry
}

/**
 * Geometry-at-intent (Dynasty D4 / C3): large H2+ work must choose delivery
 * geometry *before* code — not only at ship or when the working tree is already fat.
 *
 * largeSurface = predicted (H3 / H2+high risk / multi-surface feature) OR tree already large.
 * mode off → still advisory nudge on large H2+ (never hard-block).
 * mode strict → hard-block without `--geometry`.
 */
export function intentGeometryVerdict(input: {
  harnessLevel: 'H0' | 'H1' | 'H2' | 'H3' | string
  /** high | medium | low | unknown — from task harness risk */
  harnessRisk?: string | null
  mode: 'off' | 'advisory' | 'strict'
  explicitGeometry?: DeliveryGeometry | null
  /** Working tree already past LOC threshold */
  treeLarge?: boolean
}): IntentGeometryVerdict {
  const level = input.harnessLevel
  const highRisk = input.harnessRisk === 'high'
  // Large H2+ surface: H3 always, H2+high-risk, or working tree already fat.
  const predictedLarge = level === 'H3' || (level === 'H2' && highRisk)
  const largeSurface = Boolean(input.treeLarge) || predictedLarge

  const geometry: DeliveryGeometry =
    level === 'H3' || highRisk || input.treeLarge ? 'split' : 'single'

  if (input.explicitGeometry) {
    return {
      blocked: false,
      message: null,
      reason: 'has-geometry',
      geometry: input.explicitGeometry,
    }
  }

  if (!largeSurface) {
    return { blocked: false, message: null, reason: 'not-large', geometry: 'direct' }
  }

  const msg =
    `Delivery geometry (intent): ${level}` +
    (highRisk ? ' high-risk' : '') +
    (input.treeLarge ? ' + large working tree' : '') +
    ` → plan as \`${geometry}\` before coding. ` +
    `Pass \`prjct work "<intent>" --geometry split|single|direct\` ` +
    `(or stamp geometry on the linked intent/spec). ` +
    `Dynasty: geometry is first-class plan, not only a ship-time afterthought.`

  if (input.mode === 'strict') {
    return {
      blocked: true,
      message: msg,
      reason: input.treeLarge ? 'tree-strict' : 'h2-intent-strict',
      geometry,
    }
  }

  // off + advisory: always nudge on large H2+/tree (never hard-block)
  return {
    blocked: false,
    message: `⚠️  ${msg}`,
    reason: 'h2-intent-advisory',
    geometry,
  }
}

export interface ShipGeometryVerdict {
  blocked: boolean
  message: string | null
  tier: DeliveryTier
  geometry: DeliveryGeometry
  reason: 'none' | 'ok-small' | 'advisory' | 'strict-block' | 'override'
}

/**
 * Ship-time delivery geometry — large committed diffs must decide strategy.
 * SUPERIOR to work-only advisory: hard-blocks ship on strict packs without
 * explicit `--geometry` (consent-scoped, not --no-spec-gate).
 */
export function shipGeometryVerdict(input: {
  changeset: Pick<Changeset, 'files' | 'loc' | 'source' | 'dirs'> | null
  mode: 'off' | 'advisory' | 'strict'
  /** Explicit geometry from `prjct ship --geometry …` */
  explicitGeometry?: DeliveryGeometry | null
  locThreshold?: number
}): ShipGeometryVerdict {
  if (input.mode === 'off' || !input.changeset) {
    return {
      blocked: false,
      message: null,
      tier: 'trivial',
      geometry: 'direct',
      reason: 'none',
    }
  }
  const threshold = input.locThreshold ?? NORMAL_MAX_LOC
  const tier = tierOf(input.changeset)
  const geometry = geometryOf(tier)
  if (input.changeset.loc < threshold && tier !== 'large') {
    return { blocked: false, message: null, tier, geometry, reason: 'ok-small' }
  }
  if (input.explicitGeometry) {
    return {
      blocked: false,
      message: null,
      tier,
      geometry: input.explicitGeometry,
      reason: 'override',
    }
  }
  const dirs =
    input.changeset.dirs && input.changeset.dirs.length > 1
      ? ` Natural split lines: ${input.changeset.dirs.slice(0, 6).join(', ')}.`
      : ''
  const msg =
    `Delivery geometry (ship): ${input.changeset.loc} LOC / ${input.changeset.files} files ` +
    `(${input.changeset.source}) → suggested \`${geometry}\`.${dirs} ` +
    `Decide with \`prjct ship --geometry split|single|direct\` before publishing. ` +
    `(SUPERIOR to silent large PRs — gentle-ai forecast with teeth.)`
  if (input.mode === 'strict') {
    return { blocked: true, message: msg, tier, geometry, reason: 'strict-block' }
  }
  return { blocked: false, message: `⚠️  ${msg}`, tier, geometry, reason: 'advisory' }
}
