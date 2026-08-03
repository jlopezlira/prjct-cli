/**
 * Package manager detection for `prjct update`.
 *
 * Owns all knowledge about how npm/pnpm/bun/yarn install global packages,
 * how to detect which one launched the running binary, and how to
 * redirect PACKAGE_ROOT to the freshly installed copy after Phase 1.
 */

import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { resetPackageRoot } from '../../utils/version'
import { commandOnPath } from '../../utils/which'

export type PkgManagerName = 'npm' | 'pnpm' | 'bun' | 'yarn'

export interface PkgManager {
  name: PkgManagerName
  installArgs: string[]
  /** Returns the path to the directory containing prjct-cli/, or null. */
  getInstallRoot: () => string | null
}

export interface InstalledLocation {
  pm: PkgManager
  version: string
}

const HOME = os.homedir()

/**
 * Global install args always pin the npm registry package name.
 * Never pass a relative path / `.` / monorepo root — that installs LOCAL source
 * (user doctrine mem_9174: install from registry only).
 */
export const MANAGERS: Record<PkgManagerName, PkgManager> = {
  npm: {
    name: 'npm',
    // --prefer-online: bypass stale local npm cache of old tarballs
    installArgs: ['install', '-g', 'prjct-cli@latest', '--prefer-online'],
    getInstallRoot: () => {
      try {
        return execFileSync('npm', ['root', '-g'], {
          encoding: 'utf-8',
          stdio: 'pipe',
        }).trim()
      } catch {
        return null
      }
    },
  },
  pnpm: {
    name: 'pnpm',
    // pnpm 10 rejects npm's --prefer-online flag. The exact registry version
    // pin already prevents a stale dist-tag from selecting an older release.
    installArgs: ['add', '-g', 'prjct-cli@latest'],
    getInstallRoot: () => {
      try {
        return execFileSync('pnpm', ['root', '-g'], {
          encoding: 'utf-8',
          stdio: 'pipe',
        }).trim()
      } catch {
        return null
      }
    },
  },
  bun: {
    name: 'bun',
    installArgs: ['add', '-g', 'prjct-cli@latest'],
    getInstallRoot: () => path.join(HOME, '.bun', 'install', 'global', 'node_modules'),
  },
  yarn: {
    name: 'yarn',
    installArgs: ['global', 'add', 'prjct-cli@latest'],
    getInstallRoot: () => {
      try {
        const dir = execFileSync('yarn', ['global', 'dir'], {
          encoding: 'utf-8',
          stdio: 'pipe',
        }).trim()
        return path.join(dir, 'node_modules')
      } catch {
        return null
      }
    },
  },
}

/** Neutral cwd for global installs — never monorepo (avoids npm linking local package). */
export function registryInstallCwd(): string {
  return os.tmpdir()
}

/**
 * Rewrite install args so the package spec is always the exact npm registry
 * pin (`prjct-cli@X.Y.Z`). Falls back to `@latest` only when pin is null.
 */
export function registryInstallArgs(pm: PkgManager, pinnedSpec: string | null): string[] {
  const target = pinnedSpec ?? 'prjct-cli@latest'
  return pm.installArgs.map((a) =>
    a === 'prjct-cli@latest' || a.startsWith('prjct-cli@') ? target : a
  )
}

export function isHomebrewInstall(): boolean {
  try {
    const result = execFileSync('brew', ['list', 'prjct-cli'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    return !!result
  } catch {
    return false
  }
}

/** Whether `name` resolves to an executable in the current PATH (all OS). */
export function isOnPath(name: PkgManagerName): boolean {
  return commandOnPath(name) || (process.platform === 'win32' && commandOnPath(`${name}.cmd`))
}

/**
 * Detect which package manager owns the running prjct binary by inspecting
 * its real path. Works on macOS, Linux, and Windows path layouts.
 */
export function detectInstallerFromRunningBinary(): PkgManagerName | null {
  const candidates = [process.argv[1], process.execPath].filter(Boolean) as string[]
  for (const candidate of candidates) {
    let real = candidate
    try {
      real = require('node:fs').realpathSync(candidate)
    } catch {
      // ignore
    }
    // Normalize so Windows backslashes match the same markers.
    const p = real.replace(/\\/g, '/').toLowerCase()
    if (p.includes('/.bun/install/global') || p.includes('/.bun/bin/')) return 'bun'
    if (p.includes('/library/pnpm/') || p.includes('/.pnpm/')) return 'pnpm'
    if (p.includes('/.local/share/pnpm/')) return 'pnpm'
    // Windows pnpm store / shim layouts
    if (p.includes('/pnpm/') && (p.includes('/global') || p.includes('/prjct'))) return 'pnpm'
    if (p.includes('/.yarn/') || p.includes('/yarn/global') || p.includes('/yarn/berry')) {
      return 'yarn'
    }
    // npm global: …/node_modules/prjct-cli or Windows %APPDATA%\npm\node_modules
    if (
      p.includes('/node_modules/prjct-cli') ||
      p.includes('/npm/node_modules/') ||
      p.endsWith('/npm/prjct.cmd') ||
      p.endsWith('/npm/prjct')
    ) {
      return 'npm'
    }
  }
  return null
}

/**
 * Pick the package manager to use for the upgrade.
 * Priority: detected installer (if available on PATH) → first available among
 * bun/pnpm/npm/yarn. Throws if none are available.
 */
export function selectPackageManager(): PkgManager {
  const detected = detectInstallerFromRunningBinary()
  if (detected && isOnPath(detected)) return MANAGERS[detected]

  for (const name of ['bun', 'pnpm', 'npm', 'yarn'] as PkgManagerName[]) {
    if (isOnPath(name)) return MANAGERS[name]
  }
  throw new Error(
    'No supported package manager found in PATH (tried npm, pnpm, bun, yarn). ' +
      'Install one and re-run, or upgrade manually: bun add -g prjct-cli@latest'
  )
}

/**
 * Find every package manager that has prjct-cli installed globally.
 * Returns one entry per manager, with the version read from its package.json.
 * Use this to update all installs (not just the running binary's manager) —
 * users with multiple installs hit PATH-resolution bugs where updating one
 * leaves the other stale and shadowing it.
 */
export function getAllInstalledLocations(): InstalledLocation[] {
  const found: InstalledLocation[] = []
  for (const pm of [MANAGERS.bun, MANAGERS.pnpm, MANAGERS.npm, MANAGERS.yarn]) {
    const root = pm.getInstallRoot()
    if (!root) continue
    const pkgPath = path.join(root, 'prjct-cli', 'package.json')
    try {
      const pkg = JSON.parse(require('node:fs').readFileSync(pkgPath, 'utf-8'))
      if (pkg?.name === 'prjct-cli' && typeof pkg.version === 'string') {
        found.push({ pm, version: pkg.version })
      }
    } catch {
      // not installed via this manager
    }
  }
  return found
}

/**
 * After Phase 1 installs the new package, redirect PACKAGE_ROOT and the
 * template cache to the INSTALLED copy. Without this the running process
 * keeps using paths from whatever started it (source tree via npm link,
 * old install). Phase 2+3 must operate on the installed files.
 */
export function redirectToInstalledPackage(): void {
  try {
    const { existsSync, realpathSync, readFileSync } = require('node:fs')

    const sourceRoot = (() => {
      try {
        return realpathSync(path.resolve(__dirname, '..', '..', '..'))
      } catch {
        return ''
      }
    })()

    const roots = [
      MANAGERS.bun.getInstallRoot(),
      MANAGERS.pnpm.getInstallRoot(),
      MANAGERS.npm.getInstallRoot(),
      MANAGERS.yarn.getInstallRoot(),
    ].filter((p): p is string => !!p)

    for (const root of roots) {
      const candidate = path.join(root, 'prjct-cli')
      const pkgJsonPath = path.join(candidate, 'package.json')
      if (!existsSync(pkgJsonPath)) continue

      let resolved = candidate
      try {
        resolved = realpathSync(candidate)
      } catch {
        // ignore
      }

      // Skip if the install resolves back to our source tree (e.g. npm link)
      if (sourceRoot && resolved === sourceRoot) continue

      try {
        const pkg = JSON.parse(readFileSync(path.join(resolved, 'package.json'), 'utf-8'))
        if (pkg?.name !== 'prjct-cli') continue
      } catch {
        continue
      }

      resetPackageRoot(resolved)
      const { resetBundle } = require('../../agentic/template-loader')
      resetBundle()
      return
    }
  } catch {
    // Non-blocking: fall through to use current PACKAGE_ROOT
  }
}
