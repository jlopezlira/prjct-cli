/**
 * Read-only scan for crew files an OLDER prjct wrote into the client repo
 * (`.claude/agents/<role>.md`, `CREW.md`, a `CLAUDE.md` marker block).
 *
 * They instruct agents to write into `.prjct/sessions/<task-slug>/` — a
 * directory every `prjct sync` now purges as a worktree ghost. Left alone
 * they steer agents at a path deleted underneath them, silently.
 *
 * REPORTS ONLY: "never touch the customer repo" cuts both ways, and the
 * user may have hand-edited `leader.md` or authored their own. Removal is
 * theirs; `legacy-crew-sweep` deletes only under `.prjct/`, which we own.
 *
 * Detection is narrow on purpose — a file counts only if it carries an
 * affirmative write-here instruction, so a user's own agent that never
 * names `.prjct/sessions/` stays invisible.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { CREW_ROLES } from './agent-dispatch'
import { containsForbiddenWriteInstruction } from './legacy-crew-sweep'

/** Marker an older `crew install` wrote around its CLAUDE.md block. */
const CREW_BLOCK_START = '<!-- prjct:crew:start -->'

export interface LegacyRepoCrewScan {
  /** Repo-relative paths carrying pre-fix worktree-write instructions. */
  staleFiles: string[]
  /** Files that could not be read (permissions, races). Never throws. */
  errors: string[]
}

async function readIfPresent(filePath: string, errors: string[]): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EISDIR') return null
    errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * Candidate repo-relative paths an older `crew install` could have written.
 * Derived from CREW_ROLES so this cannot drift from the roster.
 */
function candidatePaths(): string[] {
  return [...CREW_ROLES.map((role) => path.join('.claude', 'agents', `${role.name}.md`)), 'CREW.md']
}

/**
 * Scan the worktree for leftover crew files. Reads only; never writes,
 * never deletes. Returns an empty result on a clean tree.
 */
export async function scanLegacyRepoCrewFiles(projectPath: string): Promise<LegacyRepoCrewScan> {
  const errors: string[] = []

  const scanned = await Promise.all(
    candidatePaths().map(async (relative) => {
      const content = await readIfPresent(path.join(projectPath, relative), errors)
      if (content === null) return null
      return containsForbiddenWriteInstruction(content) ? relative : null
    })
  )

  // CLAUDE.md is flagged on the marker alone: the block is unambiguously
  // prjct-authored, so it is ours to name even when the crew wording drifted.
  const claudeMd = await readIfPresent(path.join(projectPath, 'CLAUDE.md'), errors)
  const claudeMdStale =
    claudeMd !== null &&
    (claudeMd.includes(CREW_BLOCK_START) || containsForbiddenWriteInstruction(claudeMd))

  return {
    staleFiles: scanned
      .filter((entry): entry is string => entry !== null)
      .concat(claudeMdStale ? ['CLAUDE.md'] : []),
    errors,
  }
}

/** One-line summary for the doctor row. Empty scan → null. */
export function formatLegacyRepoCrewLine(scan: LegacyRepoCrewScan): string | null {
  if (scan.staleFiles.length === 0) return null
  const plural = scan.staleFiles.length > 1 ? 's' : ''
  return `${scan.staleFiles.length} legacy crew file${plural} (${scan.staleFiles.join(', ')}) still instruct writes to .prjct/sessions/, which sync purges — delete them by hand; prjct never touches your worktree`
}
