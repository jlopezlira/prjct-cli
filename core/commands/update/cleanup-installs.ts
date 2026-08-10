/**
 * Install consolidation — the durable fix for the "4 parallel prjct installs"
 * footgun the README warns about. After Phase 1 has updated every detected
 * install, the user still has N copies across pnpm/bun/npm/yarn/brew at the
 * same version, with one shadowing the rest in PATH. This removes the
 * redundant non-winner copies so the machine ends with ONE canonical install.
 *
 * Destructive — the README explicitly warns aggressive cleanup can brick a
 * shell, so removal is gated behind a strict safety model and (by default)
 * a TTY confirmation; non-interactive runs warn only.
 *
 * Winner logic is pure (`planCleanupFrom`) so unit tests can pin the
 * multi-install footgun without shelling out to real package managers.
 */

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { whichSync } from '../../utils/which'
import {
  detectInstallerFromRunningBinary,
  getAllInstalledLocations,
  isHomebrewInstall,
  type PkgManagerName,
} from './package-managers'

/** How aggressively `prjct update` consolidates parallel installs. */
export type CleanupMode = 'auto' | 'force' | 'off'

/** PM-native global uninstall argv (execFile — no shell). */
const UNINSTALL_ARGV: Record<PkgManagerName, [string, ...string[]]> = {
  npm: ['npm', 'uninstall', '-g', 'prjct-cli'],
  pnpm: ['pnpm', 'remove', '-g', 'prjct-cli'],
  bun: ['bun', 'remove', '-g', 'prjct-cli'],
  yarn: ['yarn', 'global', 'remove', 'prjct-cli'],
}

export interface CleanupPlan {
  /** the PM that owns the PATH-winning binary — never removed */
  winner: PkgManagerName | 'brew' | null
  /** redundant copies safe to remove */
  removable: Array<{ pm: PkgManagerName | 'brew'; version: string }>
  /** copies left alone, with a human reason */
  skipped: Array<{ pm: string; reason: string }>
}

/** One detected global install (name + root + version) for pure planning. */
export interface CleanupLocation {
  name: PkgManagerName
  installRoot: string | null
  version: string
}

/** Injectable inputs for pure cleanup planning (unit-testable). */
export interface CleanupPlanInput {
  winnerReal: string | null
  winnerPm: PkgManagerName | null
  locations: CleanupLocation[]
  brewInstalled: boolean
  sourceRoot: string
  /**
   * True when installRoot owns the PATH-winning binary. Defaults to
   * realpath-aware prefix match used in production.
   */
  ownsWinner?: (installRoot: string | null | undefined, winnerReal: string | null) => boolean
  /**
   * Resolve a package path for the dev-tree gate. Defaults to realpathSync
   * with fallback to the input path.
   */
  resolvePath?: (p: string) => string
}

/** realpath of the prjct binary the user's shell actually runs, or null. */
function pathWinnerReal(): string | null {
  // Cross-platform: which/where.exe — never shell `command -v` alone (Windows).
  const p = whichSync('prjct') ?? whichSync('prjct.cmd')
  if (!p) return null
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** The dev source tree (npm/bun link) — never remove it. */
function sourceRoot(): string {
  try {
    return realpathSync(path.resolve(__dirname, '..', '..', '..'))
  } catch {
    return ''
  }
}

/**
 * Normalize paths for ownership comparison across OS:
 * - path.normalize (collapses . / ..)
 * - forward slashes for stable prefix checks
 * - case-fold on win32 (NTFS default is case-insensitive)
 */
export function normalizePathForCompare(p: string): string {
  const normalized = path.normalize(p).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** True when this install root owns the PATH-winning binary realpath. */
export function locationOwnsWinner(
  installRoot: string | null | undefined,
  winnerReal: string | null
): boolean {
  if (!installRoot || !winnerReal) return false
  try {
    const root = normalizePathForCompare(realpathSync(installRoot))
    const win = normalizePathForCompare(realpathSync(winnerReal))
    return win === root || win.startsWith(`${root}/`)
  } catch {
    const root = normalizePathForCompare(installRoot)
    const win = normalizePathForCompare(winnerReal)
    return win === root || win.startsWith(`${root}/`) || win.includes(root)
  }
}

function defaultResolvePath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * True only for Homebrew *formula* install paths of prjct itself.
 *
 * Must NOT match npm/pnpm/yarn globals that happen to live under Homebrew's
 * Node prefix (e.g. `/opt/homebrew/lib/node_modules/prjct-cli`) — those are
 * package-manager installs, not `brew install prjct-cli`.
 */
/**
 * Homebrew formula paths only (macOS + Linuxbrew). Never matches Windows,
 * and never matches npm globals under Homebrew's Node prefix.
 */
export function isBrewWinnerPath(winnerReal: string | null): boolean {
  if (!winnerReal) return false
  // Windows install roots never come from brew formula Cellar layouts.
  if (process.platform === 'win32') return false
  const p = winnerReal.replace(/\\/g, '/')
  if (p.includes('/Cellar/prjct-cli') || p.includes('/Cellar/prjct/')) {
    return true
  }
  // brew symlink: /opt/homebrew/bin/prjct or /home/linuxbrew/.linuxbrew/bin/prjct
  if (/(?:^|\/)(?:opt\/)?homebrew\/bin\/prjct(?:$|\/)/.test(p)) return true
  if (p.includes('/.linuxbrew/bin/prjct') || p.includes('/linuxbrew/.linuxbrew/bin/prjct')) {
    return true
  }
  if (p.endsWith('/homebrew/bin/prjct') || p.endsWith('/opt/homebrew/bin/prjct')) {
    return true
  }
  return false
}

/**
 * Pure: decide which copies are safe to remove. Never removes the PATH
 * winner, the dev checkout, or anything whose ownership can't be proven.
 */
export function planCleanupFrom(input: CleanupPlanInput): CleanupPlan {
  const {
    winnerReal,
    winnerPm,
    locations,
    brewInstalled,
    sourceRoot: src,
    ownsWinner = locationOwnsWinner,
    resolvePath = defaultResolvePath,
  } = input
  const skipped: CleanupPlan['skipped'] = []

  // Gate #1: a provable winner is mandatory. Without it we cannot know
  // which copy to keep → refuse to remove anything.
  if (!winnerReal && !winnerPm) {
    return {
      winner: null,
      removable: [],
      skipped: [
        { pm: '(all)', reason: 'cannot resolve the PATH-winning binary — refusing to remove' },
      ],
    }
  }

  const brewWinner = isBrewWinnerPath(winnerReal)
  // Prefer the PM that owns the winning *binary path* over a mis-detected
  // installer string (fixes multi-install footgun that deleted the active copy).
  const pathOwner =
    !brewWinner && winnerReal
      ? locations.find((loc) => {
          const root = loc.installRoot
          return (
            ownsWinner(root, winnerReal) ||
            ownsWinner(root ? path.join(root, 'prjct-cli') : null, winnerReal)
          )
        })?.name
      : undefined
  const winner = brewWinner ? 'brew' : (pathOwner ?? winnerPm)

  const removable: CleanupPlan['removable'] = []
  for (const loc2 of locations) {
    const root = loc2.installRoot
    // Keep only the definitive winner, or any root that owns the PATH binary.
    // Do NOT keep a mis-detected winnerPm when path ownership points elsewhere
    // (that was the multi-install footgun: active copy deleted, shadow kept).
    // When winnerReal is unknown, fall back to keeping winnerPm by name.
    const pathOwned =
      ownsWinner(root, winnerReal) ||
      ownsWinner(root ? path.join(root, 'prjct-cli') : null, winnerReal)
    const owns = loc2.name === winner || pathOwned || (!winnerReal && loc2.name === winnerPm)
    if (owns) {
      skipped.push({
        pm: loc2.name,
        reason: 'PATH winner (or owns winning binary) — kept',
      })
      continue
    }
    // Gate: never remove the dev source tree (npm/bun link).
    if (root && src) {
      const resolved = resolvePath(path.join(root, 'prjct-cli'))
      if (resolved === src) {
        skipped.push({
          pm: loc2.name,
          reason: 'resolves to the dev source tree (link) — kept',
        })
        continue
      }
    }
    removable.push({ pm: loc2.name, version: loc2.version })
  }

  // Brew: only if a brew copy exists AND it is not the winner.
  if (brewInstalled && !brewWinner && winner !== 'brew') {
    removable.push({ pm: 'brew', version: '(homebrew)' })
  } else if (brewInstalled && (brewWinner || winner === 'brew')) {
    skipped.push({ pm: 'brew', reason: 'PATH winner — kept' })
  }

  // Safety: never propose removals when we still cannot name a winner.
  if (winner === null) {
    return {
      winner: null,
      removable: [],
      skipped: [
        ...skipped,
        { pm: '(all)', reason: 'no definitive winner — refusing to remove any copy' },
      ],
    }
  }

  return { winner, removable, skipped }
}

/** Live cleanup plan — shells out for PATH/PM detection, then pure planning. */
export function planCleanup(): CleanupPlan {
  return planCleanupFrom({
    winnerReal: pathWinnerReal(),
    winnerPm: detectInstallerFromRunningBinary(),
    locations: getAllInstalledLocations().map((loc) => ({
      name: loc.pm.name,
      installRoot: loc.pm.getInstallRoot(),
      version: loc.version,
    })),
    brewInstalled: isHomebrewInstall(),
    sourceRoot: sourceRoot(),
  })
}

function removeOne(pm: PkgManagerName | 'brew'): { ok: boolean; error?: string } {
  const argv: [string, ...string[]] =
    pm === 'brew' ? ['brew', 'uninstall', 'prjct-cli'] : UNINSTALL_ARGV[pm]
  try {
    execFileSync(argv[0], argv.slice(1), { stdio: 'pipe' })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `${pm}: ${(e as Error).message.split('\n')[0]}` }
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const a = await new Promise<string>((res) => rl.question(`${question} [y/N] `, res))
    return /^y(es)?$/i.test(a.trim())
  } finally {
    rl.close()
  }
}

/**
 * Consolidate parallel installs. Returns details/errors to merge into the
 * update Cleanup phase (no new top-level phase — keeps the 3-phase shape).
 *
 *   mode 'off'   → skip entirely
 *   mode 'force' → remove without asking (used by `--yes`)
 *   mode 'auto'  → TTY: preview + confirm; non-TTY: warn only, remove nothing
 */
export async function consolidateInstalls(
  mode: CleanupMode,
  dryRun: boolean,
  assumeYes: boolean
): Promise<{ details: string[]; errors: string[] }> {
  const details: string[] = []
  const errors: string[] = []

  if (mode === 'off') {
    details.push('Install consolidation skipped (--no-cleanup)')
    return { details, errors }
  }

  const plan = planCleanup()

  if (plan.removable.length === 0) {
    details.push(
      plan.skipped.some((s) => s.pm === '(all)')
        ? `Consolidation skipped — ${plan.skipped[0].reason}`
        : 'Single install — nothing to consolidate'
    )
    return { details, errors }
  }

  const list = plan.removable.map((r) => `${r.pm} (${r.version})`).join(', ')
  details.push(`Winner: ${plan.winner ?? 'unknown'} — redundant copies: ${list}`)

  if (dryRun) {
    for (const r of plan.removable) details.push(`Would remove ${r.pm} copy`)
    return { details, errors }
  }

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true
  const proceed =
    mode === 'force' ||
    assumeYes ||
    (interactive &&
      (await confirm(
        `Remove ${plan.removable.length} redundant prjct install(s) [${list}], keeping ${plan.winner}?`
      )))

  if (!proceed) {
    if (interactive) {
      details.push('Consolidation declined — left all installs in place')
    } else {
      details.push(
        `Multiple installs detected [${list}]. Run \`prjct upgrade --yes\` to consolidate (kept ${plan.winner}).`
      )
    }
    return { details, errors }
  }

  for (const r2 of plan.removable) {
    const res = removeOne(r2.pm)
    if (res.ok) details.push(`Removed redundant ${r2.pm} install`)
    else errors.push(res.error ?? `failed to remove ${r2.pm}`)
  }
  for (const s of plan.skipped) details.push(`Kept ${s.pm}: ${s.reason}`)

  return { details, errors }
}
