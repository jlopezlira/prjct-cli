/**
 * Shared writer for prjct's per-project routing blocks (CLAUDE.md,
 * AGENTS.md). One read-merge-write skeleton, marker-managed via
 * `mergeWithMarkers` — the per-file modules supply only their filename
 * and body. Keeping the skeleton in one place means the merge/idempotency
 * contract can't silently desync between agent surfaces.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { mergeWithMarkers } from '../infrastructure/ide-project-installer'
import { getErrorMessage, isNotFoundError } from '../types/fs'

export const ROUTING_START_MARKER = '<!-- prjct:routing - do not edit between markers -->'
export const ROUTING_END_MARKER = '<!-- /prjct:routing - managed by prjct -->'

/**
 * Minimal routing map for AGENTS.md / CLAUDE.md (written only via `prjct agents`).
 * Pull commands only — no ruleset, no project history. Budget: ≤400 body bytes.
 */
export const MINIMAL_ROUTING_BODY = `## prjct
This file holds no rules. Tasks: \`work\` · ships: \`ship\` (confirm). Rest pull-on-demand; known verbs bare (never work-wrap).
- work: \`prjct work --md\` · ship: \`prjct ship\`
- pull: \`sync\` / \`search\` / \`remember\` / \`guard\` / \`land\` / \`prime\`
- deep: \`prjct workflows --md\` · grade: \`prjct harness score --md\``

export interface RoutingWriteResult {
  action: 'created' | 'updated' | 'unchanged'
  path: string
}

/**
 * Write or refresh a prjct routing block at `<projectPath>/<filename>`.
 *
 * - File missing → create with just the block + trailing newline.
 * - File present without markers → append (with separator).
 * - File present with markers → replace block content; user content
 *   outside markers is preserved.
 */
export async function writeRoutingBlock(
  projectPath: string,
  filename: string,
  fullBlock: string
): Promise<RoutingWriteResult> {
  const file = path.join(projectPath, filename)
  const existing = await fs.readFile(file, 'utf-8').catch((error) => {
    if (!isNotFoundError(error))
      throw new Error(`Could not read ${file}: ${getErrorMessage(error)}`)
    return null
  })
  const fileExists = existing !== null

  const merged = mergeWithMarkers(
    existing ?? '',
    fullBlock,
    ROUTING_START_MARKER,
    ROUTING_END_MARKER
  )

  if (fileExists && merged.content === existing) {
    return { action: 'unchanged', path: file }
  }

  await fs.writeFile(file, merged.content, 'utf-8')
  return { action: fileExists ? 'updated' : 'created', path: file }
}
