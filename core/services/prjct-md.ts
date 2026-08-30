/**
 * Project facts formatter used by global context previews and MCP tools.
 *
 * Builds a small, budget-capped, *verified-only* slice of per-project facts —
 * real `package.json` commands (never guessed), a one-line stack summary when a
 * project style snapshot exists. Everything narrative (patterns, conventions,
 * anti-patterns, architecture) deliberately stays out — that remains
 * pull-on-demand via `prjct context --md` / MCP, same L0/L2 discipline as
 * `context-tiers.ts`.
 *
 * prjct never writes a `PRJCT.md` file into the client's repository. The
 * formatting helpers below are used only for live global surfaces (skills,
 * context commands, MCP responses).
 */

import configManager from '../infrastructure/config-manager'
import { detectVerifiedCommands, type VerifiedCommand } from './project-command-facts'
import { MINIMAL_ROUTING_BODY } from './routing-block'

const MAX_FRAMEWORKS = 6
const MAX_LANGUAGES = 3
const MAX_COMMAND_CHARS = 80

/**
 * Dedupe by kind, keeping the first (detectVerifiedCommands' own priority
 * order — node, cargo, go, python). A polyglot repo with several ecosystems
 * would otherwise surface multiple commands per kind (e.g. three different
 * "format" commands) — one representative real command per kind is enough
 * to keep the byte footprint structurally bounded.
 */
function dedupeByKind(commands: readonly VerifiedCommand[]): VerifiedCommand[] {
  const seen = new Set<string>()
  return commands.filter((cmd) => {
    if (seen.has(cmd.kind)) return false
    seen.add(cmd.kind)
    return true
  })
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

async function buildStackLine(projectPath: string): Promise<string | null> {
  try {
    const projectId = await configManager.getProjectId(projectPath)
    const { getActiveProjectStyle } = await import('./project-style-evolution')
    const style = getActiveProjectStyle(projectId)
    if (!style) return null
    const stack = style.payload.stack
    const parts = [
      stack.ecosystem && stack.ecosystem !== 'unknown' ? stack.ecosystem : null,
      stack.languages.slice(0, MAX_LANGUAGES).join(', ') || null,
      stack.frameworks.slice(0, MAX_FRAMEWORKS).join(', ') || null,
    ].filter((part): part is string => Boolean(part))
    return parts.length > 0 ? parts.join(' · ') : null
  } catch {
    return null
  }
}

/**
 * Build the bounded "this project" section — stack line + verified
 * commands, deduped by kind. Shared by the PRJCT.md-style body and the
 * live-preview surfaces (`prjct context project --md`, the
 * `prjct_project_facts` MCP tool) so all stay in lockstep with one
 * formatter. Returns null when there's nothing verified yet (no project
 * style snapshot, no recognized manifest).
 */
export async function buildProjectFactsSection(projectPath: string): Promise<string | null> {
  const [stackLine, facts] = await Promise.all([
    buildStackLine(projectPath),
    detectVerifiedCommands(projectPath),
  ])
  const commands = dedupeByKind(facts.commands)
  if (!stackLine && commands.length === 0) return null

  const lines: string[] = []
  if (stackLine) lines.push(`- stack: ${stackLine}`)
  for (const cmd of commands) {
    const tag = cmd.mutating ? 'mutating' : 'read-only'
    lines.push(`- ${cmd.kind}: \`${truncate(cmd.command, MAX_COMMAND_CHARS)}\` (${tag})`)
  }
  lines.push('- deeper: `prjct context --md` · `prjct_analysis` MCP · `prjct_relevant_files` MCP')
  return lines.join('\n')
}

/**
 * Build the PRJCT.md-style body: routing map + the bounded "this project"
 * section. Never embeds anything that changes on every call (timestamps,
 * commit hashes). Used only for global skill/context previews, never written
 * to the client repo.
 */
export async function buildPrjctMdBody(projectPath: string): Promise<string> {
  const section = await buildProjectFactsSection(projectPath)
  const lines: string[] = [MINIMAL_ROUTING_BODY]
  if (section) lines.push('', '## This project', section)
  return lines.join('\n')
}

/**
 * Live preview of the "this project" facts — no write, always fresh.
 * Used by `prjct context project --md` and the `prjct_project_facts` MCP
 * tool, so projects still get verified facts on demand without any file
 * footprint in the repo.
 */
export async function formatProjectFactsMd(projectPath: string): Promise<string> {
  const section = await buildProjectFactsSection(projectPath)
  if (!section) {
    return [
      '# Project facts',
      '',
      'No verified facts yet — run `prjct sync` for the stack line, and make sure a recognized manifest exists (package.json / Cargo.toml / go.mod / pyproject.toml) for verified commands.',
    ].join('\n')
  }
  return ['# Project facts', '', section].join('\n')
}
