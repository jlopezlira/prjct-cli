/**
 * Grok Build host-plugin materializer.
 *
 * Installs a user-level plugin at `~/.grok/plugins/prjct/` (auto-trusted by
 * Grok). Bundles skill + optional slash command; MCP stays in
 * `~/.grok/config.toml` (ensureGrokMcpServer) so we never double-register
 * `prjct_*` tools via both plugin `.mcp.json` and config.toml.
 *
 * Layout matches Grok plugin convention:
 *   plugin.json
 *   skills/prjct/SKILL.md
 *   commands/plan.md   (slash-command → prjct plan ceremony)
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { buildGrokSkillContent, getGrokSkillTemplate } from '../infrastructure/grok-skill'
import { resolveUserPath } from '../infrastructure/user-home'
import { getErrorMessage } from '../types/fs'
import log from './logger'
import { VERSION } from './version'

const PLUGIN_NAME = 'prjct'

export function getGrokPluginRoot(): string {
  if (process.env.PRJCT_TEST_MODE === '1') {
    return path.join(resolveUserPath('.prjct-tests'), 'grok', 'plugins', PLUGIN_NAME)
  }
  return resolveUserPath('.grok', 'plugins', PLUGIN_NAME)
}

function buildPluginJson(): string {
  return `${JSON.stringify(
    {
      name: PLUGIN_NAME,
      version: VERSION,
      description:
        'prjct agentic harness: SQLite work cycles, memory, guards. Grok is Brain; prjct is Body. Run prjct verbs / MCP prjct_*.',
      author: { name: 'prjct.app' },
    },
    null,
    2
  )}\n`
}

function buildPlanCommandMarkdown(): string {
  return `---
description: Enter or manage prjct plan mode (read-only until approve). Use when the approach is ambiguous and you need a written plan before editing code.
---

# prjct plan

Run this ceremony yourself (do not ask the user to type it):

\`\`\`bash
prjct plan "\${ARGUMENTS}" --md
\`\`\`

Follow the host contract printed by the CLI:

- While plan status is **draft**, do not edit project source — only update the plan via \`prjct plan write\` / \`prjct plan\`.
- When the plan is ready, ask the user to approve, then run \`prjct plan approve --md\`.
- After approve, implement against the plan; persist decisions with \`prjct remember\`.
`
}

async function writeIfChanged(filePath: string, content: string): Promise<boolean> {
  try {
    const existing = await fs.readFile(filePath, 'utf-8')
    if (existing === content) return false
  } catch {
    // missing
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
  return true
}

/**
 * Idempotently install/refresh the user-level Grok plugin.
 */
export async function installGrokPlugin(pluginRoot = getGrokPluginRoot()): Promise<{
  success: boolean
  path: string
  changed: boolean
  files: string[]
}> {
  try {
    const template = getGrokSkillTemplate()
    if (!template) {
      log.warn('Grok plugin: skill template missing')
      return { success: false, path: pluginRoot, changed: false, files: [] }
    }

    const skill = buildGrokSkillContent(template)
    const targets: Array<{ rel: string; content: string }> = [
      { rel: 'plugin.json', content: buildPluginJson() },
      { rel: path.join('skills', 'prjct', 'SKILL.md'), content: skill.content },
      { rel: path.join('commands', 'plan.md'), content: buildPlanCommandMarkdown() },
    ]

    const written: string[] = []
    for (const t of targets) {
      const abs = path.join(pluginRoot, t.rel)
      if (await writeIfChanged(abs, t.content)) written.push(t.rel)
    }

    return {
      success: true,
      path: pluginRoot,
      changed: written.length > 0,
      files: written,
    }
  } catch (error) {
    log.warn(`Grok plugin warning: ${getErrorMessage(error)}`)
    return { success: false, path: pluginRoot, changed: false, files: [] }
  }
}

/** True if the managed plugin directory exists with plugin.json. */
export async function grokPluginInstalled(pluginRoot = getGrokPluginRoot()): Promise<boolean> {
  try {
    await fs.access(path.join(pluginRoot, 'plugin.json'))
    return true
  } catch {
    return false
  }
}
