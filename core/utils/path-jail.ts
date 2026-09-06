/**
 * Path jail shared by every surface that accepts a caller-supplied path.
 *
 * A lexical check (`resolve` + `startsWith(project + sep)`) passes a symlink
 * that lives inside the project and points outside it. Both sides are
 * canonicalised through `realpath` here, so the check sees where the bytes
 * actually are; a path that does not exist yet resolves through its nearest
 * existing ancestor, so a not-yet-created file still jails correctly and a
 * symlinked parent still escapes.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Canonical absolute path for `target`, resolving through the nearest
 * existing ancestor when the leaf does not exist. Never throws — falls back
 * to the lexical `path.resolve` only if nothing along the chain exists.
 */
export function realpathOrNearest(target: string): string {
  const absolute = path.resolve(target)
  const resolveFrom = (probe: string, trailing: readonly string[]): string => {
    try {
      const real = fs.realpathSync.native(probe)
      return trailing.length === 0 ? real : path.join(real, ...trailing)
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return absolute
      return resolveFrom(parent, [path.basename(probe), ...trailing])
    }
  }
  return resolveFrom(absolute, [])
}

/**
 * The canonical path of `candidate` when it resolves inside `projectPath`
 * (the project root itself counts), otherwise null.
 */
export function resolveInsideProject(projectPath: string, candidate: string): string | null {
  const root = realpathOrNearest(projectPath)
  const absolute = path.isAbsolute(candidate) ? candidate : path.join(root, candidate)
  const real = realpathOrNearest(absolute)
  if (real === root) return real
  const rel = path.relative(root, real)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return real
}

/** True when `candidate` canonicalises to a path under `projectPath`. */
export function isInsideProject(projectPath: string, candidate: string): boolean {
  return resolveInsideProject(projectPath, candidate) !== null
}
