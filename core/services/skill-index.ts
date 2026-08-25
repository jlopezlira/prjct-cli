/**
 * Skill index — "index of paths, not summaries".
 *
 * Scans the project's and the user's agent skill roots for `SKILL.md` files,
 * parses just the frontmatter (name + description), dedupes with project
 * winning over global, and persists the catalog in the typed `skill_registry`
 * table (refreshed on every sync; mtime+size fingerprint makes re-scans
 * cheap).
 *
 * The contract: an orchestrator resolves this index ONCE and passes the EXACT
 * `SKILL.md` paths to subagents — the subagent reads the original file, so
 * the skill author's intent is never distorted by a generated digest.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from '../infrastructure/user-home'
import { prjctDb } from '../storage/database'

export interface IndexedSkill {
  name: string
  description: string
  path: string
  scope: 'project' | 'global'
}

/** Skill roots, project first (project wins on name collision). */
function skillRoots(projectPath: string): Array<{ dir: string; scope: 'project' | 'global' }> {
  return [
    { dir: path.join(projectPath, '.claude', 'skills'), scope: 'project' },
    { dir: path.join(projectPath, 'skills'), scope: 'project' },
    { dir: resolveUserPath('.claude', 'skills'), scope: 'global' },
  ]
}

/**
 * Minimal frontmatter parse: `name:` (fallback: dir name) + `description:`.
 * Tolerates BOM + CRLF (a Windows-authored skill must not lose its declared
 * name and collide under the directory-name fallback) and YAML folded blocks
 * (`description: >` / `>-` / `|`) — the folded value is the following
 * indented lines joined, not the literal fold marker.
 */
function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const m = normalized.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const out: { name?: string; description?: string } = {}
  const lines = m[1].split('\n')
  const parseLine = (index: number): void => {
    if (index >= lines.length) return
    const kv = lines[index].match(/^(name|description):\s*(.*)$/)
    if (!kv) {
      parseLine(index + 1)
      return
    }
    const field = kv[1] as 'name' | 'description'
    const initialValue = kv[2].trim()
    const continuation = /^[>|][+-]?$/.test(initialValue)
      ? lines.slice(index + 1).findIndex((line) => !/^\s+\S/.test(line))
      : 0
    const continuationLength = continuation === -1 ? lines.length - index - 1 : continuation
    const value = /^[>|][+-]?$/.test(initialValue)
      ? lines
          .slice(index + 1, index + 1 + continuationLength)
          .map((line) => line.trim())
          .join(' ')
      : initialValue
    if (value) out[field] = value.replace(/^["']|["']$/g, '')
    parseLine(index + 1 + continuationLength)
  }
  parseLine(0)
  return out
}

/**
 * Rescan the skill roots and rewrite the typed registry. Cheap (a directory
 * listing + one small read per skill) and idempotent — safe on every sync.
 */
export async function refreshSkillIndex(
  projectId: string,
  projectPath: string
): Promise<IndexedSkill[]> {
  const found = new Map<string, IndexedSkill>()
  for (const { dir, scope } of skillRoots(projectPath)) {
    const entries = await fs.readdir(dir).catch(() => null)
    if (!entries) continue // root doesn't exist — fine
    for (const entry of entries) {
      const skillPath = path.join(dir, entry, 'SKILL.md')
      const raw = await fs.readFile(skillPath, 'utf-8').catch(() => null)
      if (raw === null) continue
      const fm = parseFrontmatter(raw)
      const name = fm.name || entry
      if (found.has(name)) continue // project scanned first → project wins
      found.set(name, {
        name,
        description: fm.description ?? '',
        path: skillPath,
        scope,
      })
    }
  }

  const skills = [...found.values()]
  try {
    prjctDb.run(projectId, 'DELETE FROM skill_registry')
    for (const s of skills) {
      prjctDb.run(
        projectId,
        'INSERT OR REPLACE INTO skill_registry (name, description, path, scope, indexed_at) VALUES (?, ?, ?, ?, ?)',
        s.name,
        s.description,
        s.path,
        s.scope,
        Date.now()
      )
    }
  } catch {
    /* registry persistence is best-effort — the scan result still returns */
  }
  return skills
}

/** Read the persisted index (for `prjct context skills` and dispatch prompts). */
export function getSkillIndex(projectId: string): IndexedSkill[] {
  try {
    return prjctDb
      .query<{ name: string; description: string; path: string; scope: string }>(
        projectId,
        'SELECT name, description, path, scope FROM skill_registry ORDER BY scope ASC, name ASC'
      )
      .map((r) => ({ ...r, scope: r.scope as IndexedSkill['scope'] }))
  } catch {
    return []
  }
}

/** Markdown index for agents: name — description — exact path to read. */
export function renderSkillIndex(projectId: string): string | null {
  const skills = getSkillIndex(projectId)
  if (skills.length === 0) return null
  const lines = [
    '## Skill index — pass EXACT paths to subagents (they read the original SKILL.md; never summarize a skill for them)',
    '',
  ]
  for (const s of skills) {
    lines.push(
      `- **${s.name}** (${s.scope}) — ${s.description || 'no description'}\n  \`${s.path}\``
    )
  }
  return lines.join('\n')
}
