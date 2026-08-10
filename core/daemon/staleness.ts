/**
 * Stale-code + version-drift detection for the long-running daemon.
 *
 * Two complementary checks:
 * 1. mtime of `dist/daemon/entry.mjs` — catches local rebuilds.
 * 2. version-string comparison against the global `prjct` symlink target —
 *    catches pnpm content-store upgrades where the old daemon's files are
 *    untouched but the user-facing binary now points elsewhere.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DAEMON_PATHS } from './protocol'

function ancestorDirectories(start: string, limit: number): string[] {
  return Array.from({ length: Math.max(0, limit - 1) }).reduce<string[]>(
    (directories) => {
      const current = directories.at(-1)!
      const parent = path.dirname(current)
      return parent === current ? directories : [...directories, parent]
    },
    [start]
  )
}

/**
 * Resolve a build artifact path for stale-code detection.
 * Always uses dist/daemon/entry.mjs as the sentinel file since it gets
 * regenerated on every `npm run build`, regardless of whether the daemon
 * is running from source (dev/bun) or compiled (production/node).
 */
export function resolveEntryPath(): string | null {
  // Find the project root by looking for package.json
  for (const dir of ancestorDirectories(__dirname, 5)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const sentinel = path.join(dir, 'dist', 'daemon', 'entry.mjs')
      if (fs.existsSync(sentinel)) return sentinel
      break
    }
  }

  // Fallback: check paths relative to this file
  const candidates = [
    path.join(__dirname, '..', 'daemon', 'entry.mjs'), // from dist/bin/
    path.join(__dirname, '..', 'dist', 'daemon', 'entry.mjs'), // from bin/
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  // Last resort: use the script being executed
  const scriptPath = process.argv[1]
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath

  return null
}

/**
 * Pure restart decision, separated from the fs-touching detectors so the
 * ordering/throttle contract is unit-testable:
 *   - a rebuilt entry file (cheap mtime check) always wins immediately;
 *   - global-install drift is checked at most once per `driftMinIntervalMs`
 *     (time-throttled, not request-counted) and skipped for health pings.
 * The drift probe is injected (`checkDrift`) so tests don't touch the fs.
 * Returns whether to restart plus the (possibly advanced) throttle timestamp.
 */
export function decideRestart(opts: {
  codeStale: boolean
  command: string
  ownVersion: string | null
  now: number
  lastDriftCheckMs: number
  driftMinIntervalMs: number
  checkDrift: (ownVersion: string) => boolean
}): { restart: boolean; lastDriftCheckMs: number } {
  if (opts.codeStale) return { restart: true, lastDriftCheckMs: opts.lastDriftCheckMs }

  if (opts.ownVersion && opts.command !== '__ping') {
    if (opts.now - opts.lastDriftCheckMs >= opts.driftMinIntervalMs) {
      return { restart: opts.checkDrift(opts.ownVersion), lastDriftCheckMs: opts.now }
    }
  }

  return { restart: false, lastDriftCheckMs: opts.lastDriftCheckMs }
}

export function isCodeStale(entryPath: string | null, originalMtime: number | null): boolean {
  if (!entryPath || originalMtime === null) return false

  try {
    const currentMtime = fs.statSync(entryPath).mtimeMs
    return currentMtime !== originalMtime
  } catch {
    return false
  }
}

/**
 * Walk up from __dirname to find this package's own package.json and return
 * its `version`. Cached at startup; null if not found.
 */
export function readOwnPackageVersion(): string | null {
  for (const dir of ancestorDirectories(__dirname, 6)) {
    const pkgPath = path.join(dir, 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      if (pkg?.name === 'prjct-cli' && typeof pkg.version === 'string') return pkg.version
    } catch {
      /* not here — keep walking */
    }
  }
  return null
}

/**
 * True when `candidate` is a strictly greater semver than `baseline`.
 * Pre-release / build metadata are ignored; non-semver strings compare equal
 * (no drift) so we never false-positive restart on weird labels.
 */
export function isStrictlyNewerVersion(candidate: string, baseline: string): boolean {
  const parse = (v: string): number[] | null => {
    const core = v.trim().replace(/^v/i, '').split('-')[0].split('+')[0]
    const parts = core.split('.').map((p) => Number.parseInt(p, 10))
    if (parts.length < 1 || parts.some((n) => Number.isNaN(n))) return null
    return [...parts, 0, 0].slice(0, 3)
  }
  const a = parse(candidate)
  const b = parse(baseline)
  if (!a || !b) return false
  const difference = a.map((value, index) => value - b[index]).find((value) => value !== 0)
  return difference !== undefined && difference > 0
}

/**
 * Best-effort detection that a *newer* `prjct-cli` has been installed globally
 * while this daemon is still running. Returns `true` only when the global
 * install is strictly greater than our own version — on any lookup failure we
 * return `false` (daemon keeps running; no false positives).
 *
 * Equality → fine. Global older than own (monorepo ahead of published, or a
 * local build) → not drift; thrashing a 3.49 monorepo daemon because the
 * machine still has 3.48 on PATH was a production-log footgun in reverse.
 */
export function isGlobalVersionDrifted(ownVersion: string | null): boolean {
  if (!ownVersion) return false
  const home = os.homedir()

  const candidates = [
    `${home}/Library/pnpm/prjct`, // pnpm (macOS default)
    `${home}/.local/share/pnpm/prjct`, // pnpm (Linux)
    `${home}/.npm-global/bin/prjct`, // npm (custom prefix)
    '/usr/local/bin/prjct', // npm (default prefix)
    '/opt/homebrew/bin/prjct', // homebrew symlink
    `${home}/.volta/bin/prjct`, // volta
    `${home}/.asdf/shims/prjct`, // asdf
  ]

  for (const symlink of candidates) {
    const realPath = (() => {
      try {
        return fs.realpathSync(symlink)
      } catch {
        return null
      }
    })()
    if (!realPath) continue

    // Walk up from the resolved binary to find its package.json
    for (const dir of ancestorDirectories(path.dirname(realPath), 6)) {
      const pkgPath = path.join(dir, 'package.json')
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        if (pkg?.name === 'prjct-cli' && typeof pkg.version === 'string') {
          return isStrictlyNewerVersion(pkg.version, ownVersion)
        }
      } catch {
        /* keep walking */
      }
    }
  }

  return false // couldn't resolve any install — can't tell, assume OK
}

const MAX_LOG_BYTES = 1024 * 1024 // 1 MB

export function rotateLog(): void {
  const logPath = DAEMON_PATHS.log()
  try {
    const stat = fs.statSync(logPath)
    if (stat.size > MAX_LOG_BYTES) {
      const backupPath = `${logPath}.1`
      try {
        fs.unlinkSync(backupPath)
      } catch {
        /* no previous backup */
      }
      fs.renameSync(logPath, backupPath)
    }
  } catch {
    // Log file doesn't exist yet — nothing to rotate
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
