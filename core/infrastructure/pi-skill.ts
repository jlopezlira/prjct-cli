/**
 * Pi coding-agent integration installer, called by setup and upgrades.
 *
 * Writes `~/.pi/agent/skills/prjct/SKILL.md` from the compact multi-host skill
 * (same CONTRACT as Codex/Grok), plus the native hook and tool bridge.
 * Customized files are preserved. Workflow policy stays in the CLI;
 * this installer does not configure providers or add an MCP server.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { getTemplateContent } from '../agentic/template-loader'
import { getErrorMessage } from '../types/fs'
import { fileExists } from '../utils/file-helper'
import { sha256 } from '../utils/hash'
import log from '../utils/logger'
import { VERSION } from '../utils/version'
import { installPiBridge } from './pi-bridge'
import { resolveUserPath } from './user-home'

const PI_SKILL_META_MARKER = 'prjct-pi-skill'
const LEGACY_PI_INTEGRATION =
  '## Pi integration\n\n- All CLI verbs are available through the prjct tool (exact argv) or bash.\n- When a workflow requests Agent/subagents, use prjct_agent; it inherits this session model and returns independent results. Parent records results through the existing CLI; never invent approval.\n- /prjct is the native entry point. After installation use /reload to load the bridge.'

function getPiSkillPath(): string {
  if (process.env.PRJCT_TEST_MODE === '1') {
    return path.join(resolveUserPath('.prjct-tests'), 'pi', 'agent', 'skills', 'prjct', 'SKILL.md')
  }
  return process.env.PI_CODING_AGENT_DIR
    ? path.join(process.env.PI_CODING_AGENT_DIR, 'skills', 'prjct', 'SKILL.md')
    : resolveUserPath('.pi', 'agent', 'skills', 'prjct', 'SKILL.md')
}

export function getPiSkillInstallPath(): string {
  return getPiSkillPath()
}

function getPiSkillMetadata(templateHash: string, bodyHash: string): string {
  return `<!-- ${PI_SKILL_META_MARKER}: ${JSON.stringify({
    v: VERSION,
    h: templateHash,
    b: bodyHash,
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
  const body = `${normalized}\n\n${LEGACY_PI_INTEGRATION}\n- Native lifecycle events run the shared prjct hooks, including context injection, source inspection and edit protection.`
  const metadata = getPiSkillMetadata(templateHash, hashContent(body))
  return {
    content: `${body}\n\n${metadata}\n`,
    templateHash,
  }
}

function isManagedPiSkill(content: string): boolean {
  const match = content.match(/^([\s\S]*?)\s*<!-- prjct-pi-skill: (\{[^\n]+\}) -->\s*$/)
  if (!match) return false
  try {
    const metadata = JSON.parse(match[2])
    const body = match[1].trimEnd()
    if (metadata.b) return hashContent(body) === metadata.b
    if (hashContent(body) === metadata.h) return true
    return (
      body.endsWith(LEGACY_PI_INTEGRATION) &&
      hashContent(body.slice(0, -LEGACY_PI_INTEGRATION.length).trimEnd()) === metadata.h
    )
  } catch {
    return false
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

    const built = buildPiSkillContent(templateContent)
    const previous = skillExists ? await fs.readFile(skillMdPath, 'utf8') : null
    await installPiBridge(path.resolve(path.dirname(skillMdPath), '..', '..'), {
      content: built.content,
      acceptsExisting: isManagedPiSkill,
    })
    return {
      success: true,
      action: previous === built.content ? 'unchanged' : skillExists ? 'updated' : 'created',
      path: skillMdPath,
    }
  } catch (error) {
    log.warn(`Pi skill warning: ${getErrorMessage(error)}`)
    return { success: false, action: null }
  }
}
