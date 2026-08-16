/**
 * Pi coding-agent skill installer.
 *
 * Writes `~/.pi/agent/skills/prjct/SKILL.md` from the compact multi-host skill
 * (same CONTRACT as Codex/Grok). Pi has no built-in MCP — skills + AGENTS.md
 * are the portable contract. See pi.dev docs: AGENTS.md from ~/.pi/agent/,
 * parents, cwd; skills via skill dirs / packages.
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

const PI_SKILL_META_MARKER = 'prjct-pi-skill'

function getPiSkillPath(): string {
  if (process.env.PRJCT_TEST_MODE === '1') {
    return path.join(resolveUserPath('.prjct-tests'), 'pi', 'agent', 'skills', 'prjct', 'SKILL.md')
  }
  return resolveUserPath('.pi', 'agent', 'skills', 'prjct', 'SKILL.md')
}

export function getPiSkillInstallPath(): string {
  return getPiSkillPath()
}

function getPiSkillMetadata(templateHash: string): string {
  return `<!-- ${PI_SKILL_META_MARKER}: ${JSON.stringify({
    v: VERSION,
    h: templateHash,
  })} -->`
}

function hashContent(content: string): string {
  return sha256(content).slice(0, 12)
}

async function loadPiSkillTemplate(): Promise<string | null> {
  // Prefer Pi-specific template when present; fall back to compact Codex skill
  // (same CONTRACT lines — multi-host parity).
  return getTemplateContent('pi/SKILL.md') ?? getTemplateContent('codex/SKILL.md')
}

export function buildPiSkillContent(templateContent: string): {
  content: string
  templateHash: string
} {
  const normalized = templateContent.trimEnd()
  const templateHash = hashContent(normalized)
  const metadata = getPiSkillMetadata(templateHash)
  return {
    content: `${normalized}\n\n${metadata}\n`,
    templateHash,
  }
}

/**
 * Install prjct as a skill for Pi (`~/.pi/agent/skills/prjct/`).
 */
export async function installPiSkill(): Promise<{
  success: boolean
  action: string | null
  path?: string
}> {
  try {
    const skillMdPath = getPiSkillPath()
    await fs.mkdir(path.dirname(skillMdPath), { recursive: true })

    const skillExists = await fileExists(skillMdPath)

    const templateContent = await loadPiSkillTemplate()
    if (!templateContent) {
      log.warn('Pi SKILL.md template not found')
      return { success: false, action: null }
    }

    return await writeSkillIfChanged({
      skillMdPath,
      skillExists,
      templateContent,
      build: buildPiSkillContent,
      logLabel: 'Pi',
    })
  } catch (error) {
    log.warn(`Pi skill warning: ${getErrorMessage(error)}`)
    return { success: false, action: null }
  }
}
