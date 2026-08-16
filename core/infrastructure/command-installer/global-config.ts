/**
 * Install / update the global AI agent configuration (CLAUDE.md / GEMINI.md).
 *
 * Extracted from command-installer.ts to keep that facade focused on
 * commands. The CLAUDE.md content is inlined here (post-template
 * deprecation) so the facade no longer carries a 50-line string literal.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { getTemplateContent } from '../../agentic/template-loader'
import { getErrorMessage } from '../../types/fs'
import type { GlobalConfigResult } from '../../types/infrastructure'
import { readExistingFileOrEmpty } from '../../utils/file-helper'
import { mergeWithMarkers } from '../ide-project-installer'

const GLOBAL_CLAUDE_MD_CONTENT = `<!-- prjct:start - DO NOT REMOVE THIS MARKER -->
# p/ — Project knowledge layer

prjct stores project memory (decisions, learnings, gotchas, patterns, ships, analyses) per project in SQLite and serves it to you through tools. **Query it — don't re-read source from scratch.**

prjct remembers and shows the path; it does not own execution. Treat prjct output as durable signals (task state, memories, specs, workflows, risks, recent learnings). Claude, GPT, and other agents decide the concrete HOW with their own native tools and judgment, then persist meaningful outcomes back to prjct.

You are in a prjct project when \`.prjct/\` is in cwd OR \`~/.prjct-cli/projects/\` has an entry for the current path.

## Lookup FIRST, source LAST

Before reading source code or running broad searches for ANY question about the project (architecture, conventions, decisions, recent ships, bugs, patterns, tech debt, past analyses), QUERY prjct first — bounded, ranked answers from SQLite, no markdown trees to wade through:

- \`prjct context memory <topic>\` / \`prjct search "<q>"\` — captured decisions, gotchas, learnings, facts
- \`prjct context --md\` — current state: active cycle, ships, recent learnings
- architecture / conventions / patterns / anti-patterns / tech-debt / insights → MCP \`prjct_analysis\` (add \`mode:archive\` for history)
- developer preferences → MCP \`prjct_developer\`; machine signals → MCP \`prjct_signals\`
- specs → MCP \`prjct_spec_list\` / \`prjct_spec_get\`; per-file traps before editing → \`prjct guard <file>\`

Only fall through to source/repo reading when prjct does not contain the answer.

**Skill ≠ project identity.** The prjct skill is a portable multi-LLM contract (L0). Live name/stack/branch come from SessionStart + \`prjct context --md\` for **this cwd**. If skill text and the tree disagree, trust the cwd and the tree.

## Capture analyses BACK to prjct

When you complete substantive work — analysis, decision, learning, gotcha — persist it: \`prjct remember <decision|learning|gotcha|fact> "..."\` or \`prjct capture "<text>" --tags k:v\`. **Author every entry in ENGLISH**, whatever language the user speaks. **Default to capturing — under-capture is the failure mode that makes prjct useless.** The full verb map and task workflow live in the \`prjct\` skill.

## Where things live

- Source of truth: SQLite at \`~/.prjct-cli/projects/<id>/\` (don't read directly — use \`prjct\` CLI / MCP tools)
- Project config: \`.prjct/prjct.config.json\` in repo root

**Auto-managed by prjct-cli** | https://prjct.app
<!-- prjct:end - DO NOT REMOVE THIS MARKER -->
`

export async function installGlobalConfig(): Promise<GlobalConfigResult> {
  const aiProvider = require('../ai-provider')
  const activeProvider = await aiProvider.getActiveProvider()
  const providerName = activeProvider.name

  const detection = await aiProvider.detectProvider(providerName)
  if (!detection.installed && !activeProvider.configDir) {
    return {
      success: false,
      error: `${activeProvider.displayName} not detected`,
      action: 'skipped',
    }
  }

  try {
    await fs.mkdir(activeProvider.configDir, { recursive: true })

    const globalConfigPath = path.join(activeProvider.configDir, activeProvider.contextFile)

    // Use inline content for Claude, or provider-specific template for others
    const templateContent = await (async () => {
      if (providerName === 'claude') return GLOBAL_CLAUDE_MD_CONTENT
      // Try provider-specific template (bundle then filesystem)
      const bundled = getTemplateContent(`global/${activeProvider.contextFile}`)
      if (bundled) return bundled
      const { PACKAGE_ROOT } = require('../../utils/version')
      const templatePath = path.join(
        PACKAGE_ROOT,
        'templates',
        'global',
        activeProvider.contextFile
      )
      return fs
        .readFile(templatePath, 'utf-8')
        .catch(() =>
          providerName === 'gemini'
            ? GLOBAL_CLAUDE_MD_CONTENT.replace(/Claude/g, 'Gemini')
            : GLOBAL_CLAUDE_MD_CONTENT
        )
    })()

    const existingFile = await readExistingFileOrEmpty(globalConfigPath)

    // Strip legacy prjct-project sections (static context generation removed)
    const projectStartMarker = '<!-- prjct-project:start - DO NOT REMOVE THIS MARKER -->'
    const projectEndMarker = '<!-- prjct-project:end - DO NOT REMOVE THIS MARKER -->'
    const existingContent = (() => {
      if (
        !existingFile.content.includes(projectStartMarker) ||
        !existingFile.content.includes(projectEndMarker)
      ) {
        return existingFile.content
      }
      const beforeProject = existingFile.content.substring(
        0,
        existingFile.content.indexOf(projectStartMarker)
      )
      const afterProject = existingFile.content.substring(
        existingFile.content.indexOf(projectEndMarker) + projectEndMarker.length
      )
      return `${(beforeProject + afterProject).replace(/\n{3,}/g, '\n\n').trim()}\n`
    })()

    const startMarker = '<!-- prjct:start - DO NOT REMOVE THIS MARKER -->'
    const endMarker = '<!-- prjct:end - DO NOT REMOVE THIS MARKER -->'

    const merged = mergeWithMarkers(
      existingFile.exists ? existingContent : '',
      templateContent,
      startMarker,
      endMarker
    )

    await fs.writeFile(globalConfigPath, merged.content, 'utf-8')
    return { success: true, action: merged.action, path: globalConfigPath }
  } catch (error) {
    return { success: false, error: getErrorMessage(error), action: 'failed' }
  }
}
