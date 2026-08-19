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
import type { AIProviderConfig } from '../../types/provider'
import { readExistingFileOrEmpty } from '../../utils/file-helper'
import { mergeWithMarkers } from '../ide-project-installer'

// Re-sent by the host on EVERY turn of EVERY session across ALL projects —
// each line here is the most expensive prose in the product. Rules only,
// no rationale: the skill (L0) and pull verbs carry the rest.
const GLOBAL_CLAUDE_MD_CONTENT = `<!-- prjct:start - DO NOT REMOVE THIS MARKER -->
# p/ — Project knowledge layer

prjct = per-project memory (decisions, gotchas, learnings, ships, analyses) in SQLite, served via tools. In a prjct project (\`.prjct/\` in cwd or registered path):

1. **Lookup FIRST, source LAST.** Any project question (architecture, conventions, decisions, past bugs/analyses): \`prjct search "<q>"\` / \`prjct context --md\` / MCP \`prjct_analysis\`; per-file traps: \`prjct guard <file>\`. Read source only when prjct lacks the answer.
2. **Capture back.** Substantive outcomes → \`prjct remember <decision|learning|gotcha|fact> "..."\` — always in ENGLISH; default to capturing.
3. **Trust the cwd, not the skill text** for project identity. Never read \`~/.prjct-cli/\` SQLite directly — use the CLI/MCP.

**Auto-managed by prjct-cli** | https://prjct.app
<!-- prjct:end - DO NOT REMOVE THIS MARKER -->
`

export async function installGlobalConfig(
  resolvedProvider?: AIProviderConfig
): Promise<GlobalConfigResult> {
  const aiProvider = require('../ai-provider')
  // Callers that already resolved the active provider (e.g. sync) pass it in
  // to skip a redundant detectAllProviders + `<cli> --version` spawn (~0.3-0.5s).
  const activeProvider = resolvedProvider ?? (await aiProvider.getActiveProvider())
  const providerName = activeProvider.name

  // The CLI probe below only matters when the provider has no config dir —
  // for claude/gemini/codex the install proceeds on configDir alone, so skip
  // the spawn entirely when the caller already resolved the provider.
  if (!resolvedProvider) {
    const detection = await aiProvider.detectProvider(providerName)
    if (!detection.installed && !activeProvider.configDir) {
      return {
        success: false,
        error: `${activeProvider.displayName} not detected`,
        action: 'skipped',
      }
    }
  } else if (!activeProvider.configDir) {
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

    // Compare-before-write (same idiom as writeSkillIfChanged): the merged
    // content is byte-stable between prjct releases, so most syncs would
    // rewrite an identical file and bump its mtime for nothing. Compare
    // against the RAW existing file — if a legacy prjct-project section was
    // stripped above, merged.content differs and the write still happens.
    if (existingFile.exists && existingFile.content === merged.content) {
      return { success: true, action: 'unchanged', path: globalConfigPath }
    }

    await fs.writeFile(globalConfigPath, merged.content, 'utf-8')
    return { success: true, action: merged.action, path: globalConfigPath }
  } catch (error) {
    return { success: false, error: getErrorMessage(error), action: 'failed' }
  }
}
