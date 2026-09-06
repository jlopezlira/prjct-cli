/**
 * Project path/ID resolution for MCP tools.
 *
 * Schema tax: every tool used to require `projectPath` in ListTools JSON.
 * Path is now optional — defaults to PRJCT_PROJECT_PATH / MCP server cwd.
 */

import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import configManager from '../infrastructure/config-manager'
import { realpathOrNearest, resolveInsideProject } from '../utils/path-jail'

/** Shared schema field — omit on single-project MCP installs. */
export const optionalProjectPath = z.string().optional()

/**
 * Bounded list-size param: schema-enforced ceiling so no client can request
 * an effectively unbounded response — every returned char is context tax the
 * caller re-pays for the rest of its session.
 */
export function boundedLimit(def: number, max: number) {
  return z.number().int().min(1).max(max).optional().default(def)
}

/** The project this MCP server was started for: PRJCT_PROJECT_PATH → cwd. */
export function serverProjectRoot(): string {
  const env = process.env.PRJCT_PROJECT_PATH?.trim() || process.env.PRJCT_CWD?.trim()
  return env || process.cwd()
}

function hasLocator(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, '.prjct', 'prjct.config.json')).isFile()
  } catch {
    return false
  }
}

/**
 * An initialized prjct project carries its locator; `/etc` does not. A git
 * worktree whose locator is untracked inherits it from the main worktree
 * (`.git` is then a file pointing at `<main>/.git/worktrees/<name>`).
 */
function isPrjctProjectRoot(dir: string): boolean {
  if (hasLocator(dir)) return true
  try {
    const gitPointer = fs.readFileSync(path.join(dir, '.git'), 'utf-8').trim()
    const gitdir = /^gitdir:\s*(.+)$/.exec(gitPointer)?.[1]?.trim()
    if (!gitdir) return false
    const worktreesDir = path.dirname(path.resolve(dir, gitdir))
    const mainGitDir = path.dirname(worktreesDir)
    return path.basename(worktreesDir) === 'worktrees' && hasLocator(path.dirname(mainGitDir))
  } catch {
    return false
  }
}

/**
 * Resolve filesystem project root for a tool call.
 *
 * The model is an untrusted caller of this server, so an explicit arg is
 * honoured in exactly two shapes: a path inside the server's own project,
 * or the root of another initialized prjct project (multi-project installs).
 * `projectPath=/etc` is neither and is refused, loudly — a silent fallback
 * would route the call into the server's project instead (confused deputy).
 */
export function resolveProjectPath(explicit?: string | null): string {
  const root = serverProjectRoot()
  const e = explicit?.trim()
  if (!e) return root
  const inside = resolveInsideProject(root, e)
  if (inside) return inside
  const canonical = realpathOrNearest(path.isAbsolute(e) ? e : path.join(root, e))
  if (isPrjctProjectRoot(canonical)) return canonical
  throw new Error(
    `projectPath ${e} is outside this MCP server's project and is not an initialized prjct project; omit projectPath or point it at a project root with .prjct/prjct.config.json`
  )
}

export async function resolveProjectId(projectPath?: string | null): Promise<string> {
  return configManager.getProjectId(resolveProjectPath(projectPath))
}
