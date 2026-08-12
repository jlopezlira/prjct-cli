/**
 * Project AGENTS.md — self-contained routing writer.
 *
 * AGENTS.md is the cross-agent convention (OpenAI Codex et al.) for
 * project instructions — the Codex counterpart of `writeProjectClaudeMd`.
 * Verified fact (2026-08, Claude Code docs): only `CLAUDE.md` gets
 * automatically loaded at session start with `@import` resolution — Claude
 * Code does NOT auto-load AGENTS.md, and no cross-tool `@import`-equivalent
 * standard exists for AGENTS.md consumers (Codex, Gemini, Cursor, etc.).
 * A bare "see PRJCT.md" pointer here would depend on the model actively
 * choosing to open another file — unreliable, and the literal bug this file
 * used to cause ("I say ship and the agent doesn't know what it means").
 * So AGENTS.md carries the routing map INLINE (same `MINIMAL_ROUTING_BODY`
 * `PRJCT.md` embeds) — self-contained the way this file's own docstring has
 * always required — plus a one-line pointer to PRJCT.md for the verified
 * per-project facts (stack/commands), which are a lower-stakes pull.
 * The read-merge-write skeleton lives in `routing-block.ts`, shared with
 * the CLAUDE.md writer.
 */

import {
  MINIMAL_ROUTING_BODY,
  ROUTING_END_MARKER,
  ROUTING_START_MARKER,
  type RoutingWriteResult,
  writeRoutingBlock,
} from './routing-block'

export const AGENTS_MD_BODY = `${MINIMAL_ROUTING_BODY}
- project facts (stack/commands): see \`PRJCT.md\``

const FULL_BLOCK = `${ROUTING_START_MARKER}
${AGENTS_MD_BODY}
${ROUTING_END_MARKER}
`

/** Write or refresh the prjct routing block at `<projectPath>/AGENTS.md`. */
export async function writeProjectAgentsMd(projectPath: string): Promise<RoutingWriteResult> {
  return writeRoutingBlock(projectPath, 'AGENTS.md', FULL_BLOCK)
}

// Exposed for test-only assertions on the exact block shape.
export const _routing = {
  START_MARKER: ROUTING_START_MARKER,
  END_MARKER: ROUTING_END_MARKER,
  FULL_BLOCK,
}
