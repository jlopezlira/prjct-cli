/**
 * Monorepo detection + package discovery.
 *
 * Pure async functions consumed by the PathManager facade. Supports
 * pnpm, lerna, nx, rush, turborepo, plus npm/yarn `workspaces`.
 */

import nodeFs from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { MonorepoInfo, MonorepoPackage } from '../../types/infrastructure'
import * as fileHelper from '../../utils/file-helper'

// `fs.globSync` exists at runtime (Node >=22 / Bun) — typed locally because the
// pinned @types/node predates it. Avoids re-adding the npm `glob` dependency.
const globSync = (
  nodeFs as unknown as {
    globSync: (pattern: string, options?: { cwd?: string }) => string[]
  }
).globSync

export async function detectMonorepo(projectPath: string): Promise<MonorepoInfo> {
  const result: MonorepoInfo = {
    isMonorepo: false,
    type: null,
    rootPath: projectPath,
    packages: [],
  }

  const checks = [
    { file: 'pnpm-workspace.yaml', type: 'pnpm' as const },
    { file: 'lerna.json', type: 'lerna' as const },
    { file: 'nx.json', type: 'nx' as const },
    { file: 'rush.json', type: 'rush' as const },
    { file: 'turbo.json', type: 'turborepo' as const },
  ]

  for (const check of checks) {
    if (await fileHelper.fileExists(path.join(projectPath, check.file))) {
      result.isMonorepo = true
      result.type = check.type
      break
    }
  }

  // Check package.json for workspaces (npm/yarn)
  if (!result.isMonorepo) {
    const packageJsonPath = path.join(projectPath, 'package.json')
    if (await fileHelper.fileExists(packageJsonPath)) {
      try {
        const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))
        if (pkg.workspaces) {
          result.isMonorepo = true
          result.type = 'npm' // Could be yarn too, but npm is more generic
        }
      } catch {
        // Invalid package.json, ignore
      }
    }
  }

  if (result.isMonorepo) {
    result.packages = await discoverMonorepoPackages(projectPath, result.type)
  }

  return result
}

export async function discoverMonorepoPackages(
  rootPath: string,
  type: MonorepoInfo['type']
): Promise<MonorepoPackage[]> {
  const packages: MonorepoPackage[] = []

  try {
    const detectedPatterns = await (async (): Promise<string[]> => {
      if (type === 'pnpm') {
        const yaml = await fs.readFile(path.join(rootPath, 'pnpm-workspace.yaml'), 'utf-8')
        const match = yaml.match(/packages:\s*\n((?:\s*-\s*.+\n?)+)/)
        return match
          ? match[1]
              .split('\n')
              .map((line) => line.replace(/^\s*-\s*['"]?|['"]?\s*$/g, ''))
              .filter(Boolean)
          : []
      }
      if (type === 'npm' || type === 'lerna') {
        const packageJsonPath = path.join(rootPath, 'package.json')
        const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))
        const workspacePatterns = Array.isArray(pkg.workspaces)
          ? pkg.workspaces
          : (pkg.workspaces?.packages ?? [])
        if (type === 'lerna') {
          const lernaPath = path.join(rootPath, 'lerna.json')
          if (await fileHelper.fileExists(lernaPath)) {
            const lerna = JSON.parse(await fs.readFile(lernaPath, 'utf-8'))
            if (lerna.packages) return lerna.packages
          }
        }
        return workspacePatterns
      }
      if (type === 'nx') return ['apps/*', 'libs/*', 'packages/*']
      if (type === 'turborepo') {
        const pkg = JSON.parse(await fs.readFile(path.join(rootPath, 'package.json'), 'utf-8'))
        return Array.isArray(pkg.workspaces) ? pkg.workspaces : []
      }
      return []
    })()
    const patterns =
      detectedPatterns.length > 0 ? detectedPatterns : ['packages/*', 'apps/*', 'libs/*']

    for (const pattern2 of patterns) {
      if (pattern2.startsWith('!')) continue

      // node:fs globSync (node >=22, bun) — replaced the npm `glob` dep;
      // same contract for the simple workspace patterns used here
      // (relative matches under cwd; the package.json probe below filters).
      const matches = globSync(pattern2, { cwd: rootPath })

      for (const match of matches) {
        const packagePath = path.join(rootPath, match)
        const packageJsonPath = path.join(packagePath, 'package.json')

        if (await fileHelper.fileExists(packageJsonPath)) {
          try {
            const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))
            const prjctMdPath = path.join(packagePath, 'PRJCT.md')

            packages.push({
              name: pkg.name || path.basename(match),
              path: packagePath,
              relativePath: match,
              hasPrjctMd: await fileHelper.fileExists(prjctMdPath),
            })
          } catch {
            // Invalid package.json, skip
          }
        }
      }
    }
  } catch {
    // Error reading monorepo config, return empty
  }

  return packages
}

export async function findContainingPackage(
  currentPath: string,
  monoInfo: MonorepoInfo
): Promise<MonorepoPackage | null> {
  if (!monoInfo.isMonorepo) return null

  const normalizedCurrent = path.resolve(currentPath)

  for (const pkg of monoInfo.packages) {
    const normalizedPkg = path.resolve(pkg.path)
    if (normalizedCurrent.startsWith(normalizedPkg)) return pkg
  }

  return null
}

export async function findMonorepoRoot(startPath: string): Promise<string | null> {
  const currentPath = path.resolve(startPath)
  const root = path.parse(currentPath).root
  if (currentPath === root) return null
  const monoInfo = await detectMonorepo(currentPath)
  return monoInfo.isMonorepo ? currentPath : findMonorepoRoot(path.dirname(currentPath))
}
