/**
 * Grok Build skill installer.
 *
 * Writes `~/.grok/skills/prjct/SKILL.md` from the compact multi-host skill
 * (same CONTRACT as Codex). Grok has no hard byte cap, but keeping the
 * surface compact avoids drift and matches the Body/Brain split: skill points
 * at verbs; SQLite memory lives in prjct.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { getTemplateContent } from '../agentic/template-loader'
import { getErrorMessage } from '../types/fs'
import { fileExists } from '../utils/file-helper'
import { sha256 } from '../utils/hash'
import log from '../utils/logger'
import { VERSION } from '../utils/version'
import { writeSkillIfChanged } from './skill-install-helper'
import { resolveUserPath } from './user-home'

const GROK_SKILL_META_MARKER = 'prjct-grok-skill'

function getGrokSkillPath(): string {
  if (process.env.PRJCT_TEST_MODE === '1') {
    return path.join(resolveUserPath('.prjct-tests'), 'grok', 'skills', 'prjct', 'SKILL.md')
  }
  return resolveUserPath('.grok', 'skills', 'prjct', 'SKILL.md')
}

export function getGrokSkillInstallPath(): string {
  return getGrokSkillPath()
}

function getGrokSkillMetadata(templateHash: string): string {
  return `<!-- ${GROK_SKILL_META_MARKER}: ${JSON.stringify({
    v: VERSION,
    h: templateHash,
  })} -->`
}

function hashContent(content: string): string {
  return sha256(content).slice(0, 12)
}

/** Grok deliberately reuses the compact multi-host skill source. */
export function getGrokSkillTemplate(): string | null {
  return getTemplateContent('codex/SKILL.md')
}

export function buildGrokSkillContent(templateContent: string): {
  content: string
  templateHash: string
} {
  const normalized = templateContent.trimEnd()
  const templateHash = hashContent(normalized)
  const metadata = getGrokSkillMetadata(templateHash)
  return {
    content: `${normalized}\n\n${metadata}\n`,
    templateHash,
  }
}

/**
 * Install prjct as a skill for xAI Grok Build (`~/.grok/skills/prjct/`).
 */
export async function installGrokSkill(): Promise<{
  success: boolean
  action: string | null
  path?: string
}> {
  try {
    const skillMdPath = getGrokSkillPath()
    await fs.mkdir(path.dirname(skillMdPath), { recursive: true })

    const skillExists = await fileExists(skillMdPath)

    const templateContent = getGrokSkillTemplate()
    if (!templateContent) {
      log.warn('Grok SKILL.md template not found')
      return { success: false, action: null }
    }

    return await writeSkillIfChanged({
      skillMdPath,
      skillExists,
      templateContent,
      build: buildGrokSkillContent,
      logLabel: 'Grok',
    })
  } catch (error) {
    log.warn(`Grok skill warning: ${getErrorMessage(error)}`)
    return { success: false, action: null }
  }
}
