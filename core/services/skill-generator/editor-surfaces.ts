/**
 * Multi-editor agent surfaces — GENERATED from one source.
 *
 * The canonical Claude skill lives in `prjct-skill-body.ts`. The compact
 * surfaces for non-Claude rigs (Codex, Gemini, Antigravity) used to be static
 * templates that drifted from it. This module is the single source for those
 * surfaces: every one composes the same atomic CONTRACT lines (which include
 * the canonical verbs and the sovereign KB facets), so editing the contract
 * once updates every rig. `scripts/generate-skill-template.ts` writes the
 * generated files into `templates/` at build time; the install paths read them
 * unchanged. Codex enforces a hard ~1024-byte cap (mem_3723) — keep the compact
 * skill tight.
 */

import { KB_MEMORY_TYPES } from '../../memory/entries'
import { MINIMAL_ROUTING_BODY } from '../routing-block'

const KB = KB_MEMORY_TYPES.join('/')
const FOOTER = 'Generated with [p/](https://www.prjct.app/)'
const POINTER_START = '<!-- prjct:start - DO NOT REMOVE THIS MARKER -->'
const POINTER_END = '<!-- prjct:end - DO NOT REMOVE THIS MARKER -->'

/**
 * Atomic, rig-agnostic contract lines — the single source of truth every
 * compact editor surface composes. The protocol phrases here ("RAG-backed
 * project memory harness", "do not preload project history", "Pull", "not
 * something to load wholesale") are load-bearing: agent-rag-protocol.test
 * asserts every surface carries them.
 */
export const CONTRACT = {
  rag: 'prjct is a RAG-backed project memory harness; do not preload project history.',
  /**
   * Verb dispatch — load-bearing. "work = single entrypoint" alone caused hosts to
   * wrap bin verbs (`prjct work "sync"`). Tasks use work; known commands run bare.
   */
  entrypoint:
    'Tasks → `prjct work "…"`. Known cmds (`sync`/`search`/`remember`/…) → `prjct <cmd>` — never work-wrap.',
  pull: 'Pull only what surfaces: `prjct search` / `context memory` / `guard` / MCP — not something to load wholesale.',
  remember:
    'Save synthesized memory in English: `prjct remember <decision|learning|gotcha|context> "<text>"`.',
  kb: `KB (\`${KB}\`): \`remember <facet>\` / \`context memory <facet>\` — on demand, never injected here.`,
  ship: 'Ship only after user OKs: `prjct ship --md`.',
  /** Loop-discipline parity across Claude/Codex/Gemini/Cursor/Grok (SUPERIOR multi-runtime). */
  // Kept short: Codex SKILL.md hard cap ~1024B including metadata marker.
  loop: 'Loop: land; H2+ intent; tip→user SoT; close.',
  /** Multi-project isolation — skill is never project identity. Keep short (Codex ~1024B). */
  identity: 'L0 portable; id=cwd.',
} as const

/**
 * The compact skill for a rig that loads a `SKILL.md` (Codex, Antigravity).
 * Kept tight enough to clear Codex's ~1024-byte cap with metadata headroom.
 */
export function buildCompactSkill(): string {
  return `${[
    '---',
    'name: prjct',
    'description: prjct work cycles + memory; run prjct verbs, do not preload context.',
    '---',
    '',
    '# prjct',
    '',
    'Run `prjct <cmd> --md` and follow it.',
    '',
    `- ${CONTRACT.rag}`,
    `- ${CONTRACT.entrypoint}`,
    `- ${CONTRACT.pull}`,
    `- ${CONTRACT.remember}`,
    `- ${CONTRACT.kb}`,
    `- ${CONTRACT.ship}`,
    `- ${CONTRACT.loop}`,
    `- ${CONTRACT.identity}`,
    '',
    `Commit footer: \`${FOOTER}\``,
  ].join('\n')}\n`
}

export const buildCodexSkill = buildCompactSkill
export const buildAntigravitySkill = buildCompactSkill

/**
 * The marker-wrapped global config for a rig that reads one (Gemini,
 * Antigravity). Composes the same CONTRACT core plus rig-agnostic operational
 * guidance, so the core can never drift from the canonical skill.
 */
export function buildGlobalConfig(rigName: string): string {
  return `${[
    '<!-- prjct:start - DO NOT REMOVE THIS MARKER -->',
    '# p/ — Context layer for AI agents',
    '',
    'Skills auto-activate for: work, intent, ship, sync, guard, remember, search, insights, performance',
    'Other commands: run `prjct <command> --md` and follow CLI output',
    '',
    'Flow: known verbs run as `prjct <cmd> --md` (sync, search, remember, ship, guard, land, prime…).',
    '`prjct work` is only for task/work cycles — never wrap a bare verb as work "sync".',
    'Substantive implementation follows the persisted work-cycle station from `prjct work --md`:',
    'reviewed intent, evidence, tests when required, then code.',
    'Sync analysis: prefer schema v1 JSON via `prjct analysis-save-llm` (markdown = thin notes only).',
    '',
    'Data:',
    '- Persist everything (memories, context, intents) in ENGLISH, whatever language the user speaks',
    `- ${CONTRACT.rag}`,
    `- ${CONTRACT.entrypoint}`,
    `- ${CONTRACT.pull}`,
    `- Sovereign knowledge base — ${CONTRACT.kb}`,
    `- ${CONTRACT.remember}`,
    `- ${CONTRACT.loop}`,
    '- On close, save synthesized context; raw quotes, counters, detector rows, and transcript chunks are inputs, not final memory',
    '- prjct remembers and shows the path; the agent decides how to execute with its own native tools',
    '- Treat prjct output as signals, not a prescriptive harness',
    `- Commit footer: \`${FOOTER}\``,
    '- Path resolution: `.prjct/prjct.config.json` → `~/.prjct-cli/projects/{projectId}`',
    '- Storage: `prjct` CLI (SQLite internally)',
    '- Worktree hygiene: if working in a git worktree, remove it AFTER its PR merges — `git worktree remove` from the main worktree; never with uncommitted/unpushed work, never `--force`',
    '',
    `Crew (opt-in via \`prjct crew install\`): Leader (blue) · Implementer (purple) · Reviewer (pink). Subagent dispatch is Claude-Code-only; in ${rigName}, identify the role you are playing explicitly.`,
    '',
    '**Auto-managed by prjct-cli** | https://prjct.app',
    '<!-- prjct:end - DO NOT REMOVE THIS MARKER -->',
  ].join('\n')}\n`
}

export const buildGeminiConfig = (): string => buildGlobalConfig('Gemini')
export const buildAntigravityConfig = (): string => buildGlobalConfig('Antigravity')

/**
 * IDE rule pointers. Clean-repo doctrine: these carry the SAME minimal
 * pointer as AGENTS.md/CLAUDE.md (MINIMAL_ROUTING_BODY, one source) — never a
 * ruleset. Only the per-rig frontmatter differs.
 */
function buildIdePointer(frontmatter: string): string {
  return `${[
    '---',
    frontmatter,
    '---',
    '',
    POINTER_START,
    MINIMAL_ROUTING_BODY,
    '',
    '**Auto-managed by prjct-cli** | https://prjct.app',
    POINTER_END,
  ].join('\n')}\n`
}

export const buildCursorRule = (): string =>
  buildIdePointer(
    'description: "prjct — pull project memory + workflow on demand"\nalwaysApply: true'
  )

/**
 * Runtime-only editor surfaces. Consumers request a logical template key;
 * keeping the key→builder relationship here prevents physical template copies
 * and keeps routing beside the content's single source of truth.
 */
export const EDITOR_SURFACE_BUILDERS: Readonly<Record<string, () => string>> = {
  'codex/SKILL.md': buildCodexSkill,
  'antigravity/SKILL.md': buildAntigravitySkill,
  'global/GEMINI.md': buildGeminiConfig,
  'global/ANTIGRAVITY.md': buildAntigravityConfig,
  'global/CURSOR.mdc': buildCursorRule,
}

export const EDITOR_SURFACE_PATHS = Object.freeze(Object.keys(EDITOR_SURFACE_BUILDERS))

export function buildEditorSurface(relativePath: string): string | null {
  return EDITOR_SURFACE_BUILDERS[relativePath]?.() ?? null
}
