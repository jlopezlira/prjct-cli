import fs from 'node:fs'
import path from 'node:path'
import { getErrorMessage } from '../types/fs'

/**
 * Version Manager - Single source of truth for application version
 *
 * Reads version from package.json dynamically to ensure consistency
 * across the entire application.
 *
 * Uses sync I/O intentionally: runs once at cold start, results cached.
 * CJS build (postinstall) requires sync module-level exports.
 */

interface PackageJson {
  version: string
  name?: string
  description?: string
  [key: string]: unknown
}

const versionCache: { version: string | null; packageRoot: string | null } = {
  version: null,
  packageRoot: null,
}

/**
 * Find the package root by searching up from __dirname for package.json
 * Works whether running from source (core/utils/) or compiled (dist/core/utils/)
 */
export function getPackageRoot(): string {
  if (versionCache.packageRoot) {
    return versionCache.packageRoot
  }
  const findPackageRoot = (currentDir: string, depth: number): string | null => {
    if (depth >= 5) return null
    const packageJsonPath = path.join(currentDir, 'package.json')
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
        if (pkg.name === 'prjct-cli') {
          return currentDir
        }
      } catch (_error) {
        // Continue searching
      }
    }
    return findPackageRoot(path.dirname(currentDir), depth + 1)
  }
  versionCache.packageRoot = findPackageRoot(__dirname, 0) ?? path.join(__dirname, '..', '..', '..')
  return versionCache.packageRoot
}

/**
 * Get the current application version.
 *
 * Resolution order:
 *   1. `process.env.PRJCT_VERSION` — baked in at build time via
 *      `bun build --compile --define`. Standalone binaries MUST
 *      use this path because their compiled __dirname points at the
 *      CI runner's filesystem (which doesn't exist on the user's box).
 *   2. `package.json` walked up from __dirname — works for source +
 *      dist runs where the package is installed normally.
 *   3. `'0.0.0'` — last-resort fallback so the binary still functions.
 */
export function getVersion(): string {
  if (versionCache.version) {
    return versionCache.version
  }

  const baked = process.env.PRJCT_VERSION
  if (baked && /^\d+\.\d+\.\d+/.test(baked)) {
    versionCache.version = baked
    return versionCache.version
  }

  try {
    const packageJsonPath = path.join(getPackageRoot(), 'package.json')
    const packageJson: PackageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
    versionCache.version = packageJson.version
    return versionCache.version
  } catch (error) {
    // Stay silent in standalone binaries — the env-var fallback above
    // covered the expected path. Logging here would surface the
    // internal "looking for /home/runner/..." path to the user.
    if (process.env.PRJCT_DEBUG === '1') {
      console.error('Failed to read version from package.json:', getErrorMessage(error))
    }
    return '0.0.0'
  }
}

/**
 * Reset the cached package root to a new path.
 * Used by `prjct update` after npm install to redirect
 * from source/old paths to the newly installed package.
 */
export function resetPackageRoot(newRoot: string): void {
  versionCache.packageRoot = newRoot
  versionCache.version = null
}

export const VERSION = getVersion()
export const PACKAGE_ROOT = getPackageRoot()
