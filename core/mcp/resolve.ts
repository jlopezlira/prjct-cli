/**
 * Project path/ID resolution for MCP tools.
 *
 * Schema tax: every tool used to require `projectPath` in ListTools JSON.
 * Path is now optional — defaults to PRJCT_PROJECT_PATH / MCP server cwd.
 */

import { z } from 'zod'
import configManager from '../infrastructure/config-manager'

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

/**
 * Resolve filesystem project root for a tool call.
 * Order: explicit arg → PRJCT_PROJECT_PATH → process.cwd().
 */
export function resolveProjectPath(explicit?: string | null): string {
  const e = explicit?.trim()
  if (e) return e
  const env = process.env.PRJCT_PROJECT_PATH?.trim() || process.env.PRJCT_CWD?.trim()
  if (env) return env
  return process.cwd()
}

export async function resolveProjectId(projectPath?: string | null): Promise<string> {
  return configManager.getProjectId(resolveProjectPath(projectPath))
}
