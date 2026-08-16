/**
 * Codex skill installer + router verification.
 *
 * Extracted from infrastructure/setup.ts (god-file split). Installs
 * ~/.codex/skills/prjct/SKILL.md from the generated template (hash-stamped,
 * only rewritten on template change) and verifies the `p.` router end to end.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getTemplateContent } from '../agentic/template-loader'
import { getErrorMessage } from '../types/fs'
import type { CodexPRouterStatus } from '../types/infrastructure.js'
import { fileExists } from '../utils/file-helper'
import { sha256 } from '../utils/hash'
import log from '../utils/logger'
import { VERSION } from '../utils/version'
import { detectCodex } from './ai-provider'
import { writeSkillIfChanged } from './skill-install-helper'

const CODEX_SKILL_META_MARKER = 'prjct-codex-router'

/**
 * Codex enforces a HARD limit of ~1024 bytes on the whole SKILL.md file
 * (not just the description field). Over the limit, the ENTIRE skill is
 * silently rejected and prjct disappears from Codex. Everything written
 * to ~/.codex/skills/prjct/SKILL.md must stay under this — enforced by
 * the size guard below and by codex-skill tests.
 */
export const CODEX_SKILL_MAX_BYTES = 1024

function getCodexSkillPath(): string {
  return path.join(os.homedir(), '.codex', 'skills', 'prjct', 'SKILL.md')
}

// Compact on purpose: every metadata byte counts against the 1024-byte
// Codex cap, so keys are single letters and the hash is truncated.
function getCodexSkillMetadata(templateHash: string): string {
  return `<!-- ${CODEX_SKILL_META_MARKER}: ${JSON.stringify({
    v: VERSION,
    h: templateHash,
  })} -->`
}

function parseCodexSkillMetadata(
  content: string
): { version?: string; templateHash?: string } | null {
  const match = content.match(
    new RegExp(`<!--\\s*${CODEX_SKILL_META_MARKER}:\\s*(\\{[\\s\\S]*?\\})\\s*-->`)
  )
  if (!match) return null
  try {
    const raw = JSON.parse(match[1]) as {
      v?: string
      h?: string
      version?: string
      templateHash?: string
    }
    return {
      version: raw.v ?? raw.version,
      templateHash: raw.h ?? raw.templateHash,
    }
  } catch {
    return null
  }
}

function hashContent(content: string): string {
  return sha256(content).slice(0, 12)
}

async function loadCodexSkillTemplate(): Promise<string | null> {
  return getTemplateContent('codex/SKILL.md')
}

export function buildCodexSkillContent(templateContent: string): {
  content: string
  templateHash: string
} {
  const normalized = templateContent.trimEnd()
  const templateHash = hashContent(normalized)
  const metadata = getCodexSkillMetadata(templateHash)
  return {
    content: `${normalized}\n\n${metadata}\n`,
    templateHash,
  }
}

/**
 * Install prjct as a skill for OpenAI Codex
 *
 * Codex uses SKILL.md files in ~/.codex/skills/
 * Following the same pattern as Antigravity.
 */
export async function installCodexSkill(): Promise<{
  success: boolean
  action: string | null
  path?: string
}> {
  try {
    const skillMdPath = getCodexSkillPath()
    const prjctSkillDir = path.dirname(skillMdPath)
    await fs.mkdir(prjctSkillDir, { recursive: true })

    const skillExists = await fileExists(skillMdPath)

    // Read template content - try bundle first
    const templateContent = await loadCodexSkillTemplate()
    if (!templateContent) {
      log.warn('Codex SKILL.md template not found')
      return { success: false, action: null }
    }

    return await writeSkillIfChanged({
      skillMdPath,
      skillExists,
      templateContent,
      build: (tpl) => {
        const built = buildCodexSkillContent(tpl)
        const bytes = Buffer.byteLength(built.content, 'utf-8')
        if (bytes > CODEX_SKILL_MAX_BYTES) {
          // Install anyway (Codex may relax the cap), but surface it loudly:
          // over the cap, Codex rejects the whole skill with no error shown.
          log.warn(
            `Codex SKILL.md is ${bytes} bytes — over Codex's ~${CODEX_SKILL_MAX_BYTES}-byte hard limit; the skill may be rejected. Trim editor-surfaces.ts.`
          )
        }
        return built
      },
      logLabel: 'Codex',
    })
  } catch (error) {
    log.warn(`Codex skill warning: ${getErrorMessage(error)}`)
    return { success: false, action: null }
  }
}

export async function verifyCodexPRouterReady(
  options: { autoRepair?: boolean } = {}
): Promise<CodexPRouterStatus> {
  const skillPath = getCodexSkillPath()
  const codexDetection = await detectCodex()
  if (!codexDetection.installed) {
    return {
      installed: false,
      verified: true,
      skillPath,
      message: 'Codex not detected',
    }
  }

  const templateContent = await loadCodexSkillTemplate()
  if (!templateContent) {
    return {
      installed: true,
      verified: false,
      skillPath,
      message: 'Codex SKILL.md template missing from prjct installation',
      fix: ['Reinstall prjct-cli package', 'Run `prjct setup`'],
    }
  }

  const expected = buildCodexSkillContent(templateContent)

  const maybeRepair = async (): Promise<boolean> => {
    if (!options.autoRepair) return false
    const result = await installCodexSkill()
    return result.success
  }

  if (!(await fileExists(skillPath))) {
    if (!(await maybeRepair())) {
      return {
        installed: true,
        verified: false,
        skillPath,
        templateHash: expected.templateHash,
        message: 'Codex skill missing at ~/.codex/skills/prjct/SKILL.md',
        fix: ['Run `prjct start` to install Codex skill'],
      }
    }
  }

  const readVerification = async () => {
    const content = await fs.readFile(skillPath, 'utf-8').catch(() => '')
    const metadata = parseCodexSkillMetadata(content)
    return {
      matches: metadata?.version === VERSION && metadata?.templateHash === expected.templateHash,
    }
  }
  const initialVerification = await readVerification()

  if (!initialVerification.matches) {
    if (!(await maybeRepair())) {
      return {
        installed: true,
        verified: false,
        skillPath,
        templateHash: expected.templateHash,
        message: 'Codex skill metadata mismatch (outdated router)',
        fix: ['Run `prjct start` or `prjct setup` to refresh Codex skill'],
      }
    }

    const repairedVerification = await readVerification()
    if (!repairedVerification.matches) {
      return {
        installed: true,
        verified: false,
        skillPath,
        templateHash: expected.templateHash,
        message: 'Codex skill could not be repaired automatically',
        fix: ['Delete ~/.codex/skills/prjct/SKILL.md', 'Run `prjct setup`'],
      }
    }
  }

  return {
    installed: true,
    verified: true,
    skillPath,
    templateHash: expected.templateHash,
    message: 'Codex p. router ready',
  }
}
