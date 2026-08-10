/**
 * Shared helpers for nested-context discovery.
 *
 * Keep tiny on purpose — anything bigger should live in its own
 * discovery module (context-discovery, agents-discovery).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import * as fileHelper from '../../utils/file-helper'

export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage'])
export const MAX_SCAN_DEPTH = 5

interface NodeBase {
  path: string
  depth: number
}

/**
 * Recursively walk `rootDir` looking for `fileName`, invoking `onFound` for each
 * match not already in `alreadyFoundPaths`. Skips dotfiles, node_modules, dist,
 * build, coverage. Caps at MAX_SCAN_DEPTH to avoid runaway recursion.
 */
export async function scanForNestedFiles(
  rootDir: string,
  fileName: string,
  alreadyFoundPaths: Set<string>,
  onFound: (filePath: string) => Promise<void>
): Promise<void> {
  const scan = async (currentDir: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH) return

    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => null)
    if (!entries) return

    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      if (!entry.isDirectory()) continue

      const subDir = path.join(currentDir, entry.name)
      const filePath = path.join(subDir, fileName)

      if ((await fileHelper.fileExists(filePath)) && !alreadyFoundPaths.has(filePath)) {
        await onFound(filePath)
        alreadyFoundPaths.add(filePath)
      }

      await scan(subDir, depth + 1)
    }
  }

  await scan(rootDir, 0)
}

/**
 * Find the closest ancestor (by directory) for `filePath` among `items`.
 */
export function findParentByDir<T extends NodeBase>(filePath: string, items: T[]): T | null {
  const fileDir = path.dirname(filePath)
  const sorted = [...items].sort((a, b) => b.depth - a.depth)

  for (const item of sorted) {
    const itemDir = path.dirname(item.path)
    if (fileDir.startsWith(itemDir) && fileDir !== itemDir) return item
  }
  return null
}

/**
 * Pick the most specific (deepest matching) node for `targetPath`.
 */
export function pickBestMatchForPath<T extends NodeBase>(targetPath: string, items: T[]): T | null {
  const targetDir = path.resolve(targetPath)
  return items.reduce<T | null>((best, item) => {
    const itemDir = path.dirname(item.path)
    return targetDir.startsWith(itemDir) && (!best || item.depth > best.depth) ? item : best
  }, null)
}

/**
 * Build inheritance chain (root → leaf) by walking `parent` links.
 */
export function buildInheritanceChain<T extends { parent: T | null }>(node: T): T[] {
  const ascend = (current: T | null): T[] => (current ? [...ascend(current.parent), current] : [])
  return ascend(node)
}

/**
 * Depth of `filePath` relative to `rootPath` (0 = root).
 */
export function computeDepth(rootPath: string, filePath: string): number {
  const rel = path.relative(rootPath, filePath)
  return rel.split(path.sep).length - 1
}
