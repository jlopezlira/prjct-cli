/**
 * Canonical minimal routing map used by global agent skills and context tiers.
 *
 * The actual write path into the user's global agent config (e.g.
 * `~/.claude/CLAUDE.md`) lives in `command-installer/global-config.ts`. prjct
 * never writes AGENTS.md / CLAUDE.md / PRJCT.md / IDE rule files into the
 * client's repository.
 */

export const ROUTING_START_MARKER = '<!-- prjct:routing - do not edit between markers -->'
export const ROUTING_END_MARKER = '<!-- /prjct:routing - managed by prjct -->'

/**
 * Minimal routing map for global agent skills and context previews.
 * Pull commands only — no ruleset, no project history. Budget: ≤400 body bytes.
 */
export const MINIMAL_ROUTING_BODY = `## prjct
This file holds no rules. Tasks: \`work\` · ships: \`ship\` (confirm). Rest pull-on-demand; known verbs bare (never work-wrap).
- work: \`prjct work --md\` · ship: \`prjct ship\`
- pull: \`sync\` / \`search\` / \`remember\` / \`guard\` / \`land\` / \`prime\`
- deep: \`prjct workflows --md\` · grade: \`prjct harness score --md\``
