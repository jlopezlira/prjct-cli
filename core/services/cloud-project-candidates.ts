/**
 * Discover local projects that can be connected/disconnected from cloud.
 *
 * Paths come from (best-effort):
 *   1. cloud-linked.json registry (known projectPath)
 *   2. project doc `repoPath` written on local sync
 *
 * Entries without a resolvable path are listed as pathless (status only).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import configManager from '../infrastructure/config-manager'
import pathManager from '../infrastructure/path-manager'
import prjctDb from '../storage/database'
import { listLinkedProjects } from '../sync/cloud-registry'

export interface CloudProjectCandidate {
  projectId: string
  /** Absolute repo path when known and still present on disk. */
  projectPath: string | null
  name: string
  connected: boolean
  paused: boolean
}

async function pathExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p)
    return st.isDirectory()
  } catch {
    return false
  }
}

async function resolveFromDoc(projectId: string): Promise<{
  path: string | null
  name: string
}> {
  try {
    const doc = prjctDb.getDoc<{ repoPath?: string; path?: string; name?: string }>(
      projectId,
      'project'
    )
    const raw = doc?.repoPath || doc?.path || null
    if (raw && (await pathExists(raw))) {
      return { path: raw, name: doc?.name || path.basename(raw) }
    }
    return { path: null, name: doc?.name || projectId.slice(0, 8) }
  } catch {
    return { path: null, name: projectId.slice(0, 8) }
  }
}

/**
 * Union of storage project ids + linked registry, with best-effort paths.
 */
export async function listCloudProjectCandidates(): Promise<CloudProjectCandidate[]> {
  const byId = new Map<string, CloudProjectCandidate>()

  const linked = await listLinkedProjects()
  for (const entry of linked) {
    const ok = await pathExists(entry.projectPath)
    const config = ok ? await configManager.readConfig(entry.projectPath).catch(() => null) : null
    byId.set(entry.projectId, {
      projectId: entry.projectId,
      projectPath: ok ? entry.projectPath : null,
      name: ok ? path.basename(entry.projectPath) : entry.projectId.slice(0, 8),
      connected: !!config?.cloud?.enabled || ok,
      paused: !!config?.cloud?.paused,
    })
  }

  const ids = await pathManager.listProjects()
  for (const projectId of ids) {
    if (byId.has(projectId)) {
      // Prefer registry path; fill name/connected from config if path works
      const cur = byId.get(projectId)!
      if (cur.projectPath) {
        const config = await configManager.readConfig(cur.projectPath).catch(() => null)
        if (config?.cloud) {
          cur.connected = !!config.cloud.enabled
          cur.paused = !!config.cloud.paused
        }
      }
      continue
    }
    const resolved = await resolveFromDoc(projectId)
    const config = resolved.path
      ? await configManager.readConfig(resolved.path).catch(() => null)
      : null
    const matchesConfig = Boolean(config?.projectId === projectId || config?.projectId)
    const connected = matchesConfig && Boolean(config?.cloud?.enabled)
    const paused = matchesConfig && Boolean(config?.cloud?.paused)
    const name = matchesConfig && resolved.path ? path.basename(resolved.path) : resolved.name
    byId.set(projectId, {
      projectId,
      projectPath: resolved.path,
      name,
      connected,
      paused,
    })
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Candidates with a live path that can run link/unlink in that cwd. */
export function actionableCandidates(
  list: CloudProjectCandidate[],
  mode: 'connect' | 'disconnect'
): CloudProjectCandidate[] {
  return list.filter((c) => {
    if (!c.projectPath) return false
    if (mode === 'connect') return !c.connected
    return c.connected
  })
}
