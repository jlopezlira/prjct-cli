/**
 * Project CLAUDE.md — native-import pointer writer.
 *
 * Writes (or refreshes between markers) a one-line `@PRJCT.md` import at
 * the project's `CLAUDE.md`, using Claude Code's native file-import syntax
 * instead of duplicating the routing map + per-project facts that already
 * live in `PRJCT.md` (see `prjct-md.ts`). The read-merge-write skeleton
 * lives in `routing-block.ts`, shared with the AGENTS.md writer.
 */

import {
  ROUTING_END_MARKER,
  ROUTING_START_MARKER,
  type RoutingWriteResult,
  writeRoutingBlock,
} from './routing-block'

export const CLAUDE_MD_IMPORT_STUB = '@PRJCT.md'

const FULL_BLOCK = `${ROUTING_START_MARKER}
${CLAUDE_MD_IMPORT_STUB}
${ROUTING_END_MARKER}
`

/** Write or refresh the prjct pointer block at `<projectPath>/CLAUDE.md`. */
export async function writeProjectClaudeMd(projectPath: string): Promise<RoutingWriteResult> {
  return writeRoutingBlock(projectPath, 'CLAUDE.md', FULL_BLOCK)
}

// Exposed for test-only assertions on the exact block shape.
export const _routing = {
  START_MARKER: ROUTING_START_MARKER,
  END_MARKER: ROUTING_END_MARKER,
  FULL_BLOCK,
}
