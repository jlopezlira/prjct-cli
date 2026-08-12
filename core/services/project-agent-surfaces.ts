import path from 'node:path'
import { fileExists } from '../utils/file-helper'
import { writeProjectAgentsMd } from './host-agents-md'
import { writeProjectClaudeMd } from './host-claude-md'
import { writeProjectPrjctMd } from './prjct-md'
import { writeProjectIdeRules } from './project-ide-rules'
import type { RoutingWriteResult } from './routing-block'

export interface ProjectAgentSurfacesResult {
  prjctMd: RoutingWriteResult
  agentsMd: RoutingWriteResult
  claudeMd?: RoutingWriteResult
  ideRules: string[]
}

export interface ProjectAgentSurfacesOptions {
  agents?: readonly string[]
  explicit?: boolean
  /**
   * Keep already-adopted surfaces current on every sync, without creating
   * the FIRST copy in a repo that never opted in. Checks whether PRJCT.md /
   * AGENTS.md / CLAUDE.md already exists; if so, refreshes exactly like an
   * explicit `prjct agents doctor --fix` (same idempotent merge-by-markers
   * writer), which also migrates any pre-PRJCT.md duplicated inline block
   * to the current pointer shape for free. If none exist, still a no-op —
   * a virgin repo's first pointer always requires an explicit opt-in.
   */
  refreshIfAdopted?: boolean
}

async function hasAdoptedSurfaces(projectPath: string): Promise<boolean> {
  const [prjctMd, agentsMd, claudeMd] = await Promise.all([
    fileExists(path.join(projectPath, 'PRJCT.md')),
    fileExists(path.join(projectPath, 'AGENTS.md')),
    fileExists(path.join(projectPath, 'CLAUDE.md')),
  ])
  return prjctMd || agentsMd || claudeMd
}

/**
 * Install/refresh repo-local agent instruction surfaces — ONLY when the
 * caller explicitly asks (`options.explicit`), or when `options.refreshIfAdopted`
 * finds the project already carries a surface to keep current.
 *
 * Clean-repo sovereignty doctrine: prjct never CREATES rule/routing files in
 * a client repo automatically — the first pointer always requires an
 * explicit opt-in (`prjct agents doctor --fix`). Once a project has opted
 * in, `prjct sync` keeps that surface fresh (and migrates stale/legacy
 * content via the same marker-merge writer) so agents never read a drifted
 * AGENTS.md/CLAUDE.md/PRJCT.md. All rules + knowledge otherwise live in the
 * global agent config + prjct's SQLite and are pulled on demand.
 */
export async function writeProjectAgentSurfaces(
  projectPath: string,
  options: ProjectAgentSurfacesOptions = {}
): Promise<ProjectAgentSurfacesResult> {
  const explicit =
    options.explicit || (options.refreshIfAdopted && (await hasAdoptedSurfaces(projectPath)))
  if (!explicit) {
    return {
      prjctMd: { action: 'unchanged', path: path.join(projectPath, 'PRJCT.md') },
      agentsMd: { action: 'unchanged', path: path.join(projectPath, 'AGENTS.md') },
      ideRules: [],
    }
  }
  // CLAUDE.md is written only when Claude is actually in play for this
  // project — either explicitly selected/detected in `options.agents`, or a
  // CLAUDE.md already exists here. Writing it unconditionally for every
  // project regardless of which runtime is actually used (e.g. a Kimi-only
  // team that only reads AGENTS.md) would be exactly the kind of forced,
  // irrelevant footprint the clean-repo doctrine exists to prevent. The
  // real bug was elsewhere: some callers (`prjct agents doctor --fix`,
  // `prjct install`) never populated `options.agents` from runtime
  // detection at all, so `selected.has('claude')` was always false even on
  // a real Claude Code machine — fixed at those call sites, not here.
  const selected = new Set(options.agents ?? [])
  const projectClaude = await fileExists(path.join(projectPath, 'CLAUDE.md'))
  const shouldWriteClaude = selected.has('claude') || projectClaude

  const [prjctMd, agentsMd, claudeMd, ideRules] = await Promise.all([
    writeProjectPrjctMd(projectPath),
    writeProjectAgentsMd(projectPath),
    shouldWriteClaude ? writeProjectClaudeMd(projectPath) : undefined,
    writeProjectIdeRules(projectPath, options),
  ])

  return {
    prjctMd,
    agentsMd,
    ...(claudeMd ? { claudeMd } : {}),
    ideRules: ideRules.written,
  }
}
