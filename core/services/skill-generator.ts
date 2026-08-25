/**
 * Portable multi-host skill installer.
 *
 * One L0 body for all hosts (Claude full + Codex/Gemini compact). Never
 * embeds project identity — last-writer-wins poison. Project facts = L1
 * SessionStart / prompt hooks + pull tools.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { getErrorMessage } from '../errors'
import { resolveUserHome } from '../infrastructure/user-home'
import type { SkillGenerationResult } from '../types/services.js'
import log from '../utils/logger'
import { buildCompactSkill } from './skill-generator/editor-surfaces'
import {
  buildPrjctSkillBody,
  buildPrjctSkillReference,
  PRJCT_SKILL_ALLOWED_TOOLS,
  PRJCT_SKILL_DESCRIPTION,
  PRJCT_SKILL_REFERENCE_FILE,
} from './skill-generator/prjct-skill-body'
import type { SkillDefinition } from './skill-generator/types'

const SKILL_DEFINITIONS: SkillDefinition[] = [
  {
    name: 'prjct',
    description: PRJCT_SKILL_DESCRIPTION,
    allowedTools: [...PRJCT_SKILL_ALLOWED_TOOLS],
    body: () => buildPrjctSkillBody(),
    reference: () => buildPrjctSkillReference(),
    referenceFile: PRJCT_SKILL_REFERENCE_FILE,
  },
]

function buildFrontmatter(skill: SkillDefinition): string {
  const isUserInvocable = skill.userInvocable !== false
  return `---
description: "${skill.description}"
allowed-tools: [${skill.allowedTools.map((t) => `"${t}"`).join(', ')}]
user-invocable: ${isUserInvocable}
---`
}

function buildSkillContent(def: SkillDefinition): string {
  return `${buildFrontmatter(def)}\n\n${def.body()}`
}

function homeDir(): string {
  return resolveUserHome()
}

function claudeSkillsRoot(): string {
  return path.join(homeDir(), '.claude', 'skills')
}

function compactSkillRoots(): string[] {
  const home = homeDir()
  return [
    path.join(home, '.codex', 'skills'),
    path.join(home, '.gemini', 'skills'),
    path.join(home, '.gemini', 'antigravity', 'global_skills'),
    // Kimi Code CLI user tier (docs: kimi.com/code/docs …/customization/skills.html
    // lists BOTH $KIMI_CODE_HOME/skills and ~/.agents/skills as canonical). The
    // shared ~/.agents/skills root is verified live and is tool-agnostic — the
    // prjct skill is host-neutral content, so it belongs in the shared tier.
    path.join(home, '.agents', 'skills'),
  ]
}

/**
 * Detect legacy project-stamped skill bodies (multi-project poison).
 * Portable L0 never has `# name` + stack line or rich delivery sections.
 */
export function skillBodyHasProjectStamp(content: string): boolean {
  if (/^# [^\n]+\n[^\n]*\|\s*\d+\s+files\s*\|/m.test(content)) return true
  if (/## Recent Deliveries/m.test(content)) return true
  if (/## Velocity/m.test(content) && /pts\/sprint/m.test(content)) return true
  return false
}

class SkillGenerator {
  /** Install portable L0 skills to Claude + compact hosts. */
  async generateAndInstall(): Promise<SkillGenerationResult> {
    const result: SkillGenerationResult = { generated: [], skipped: [] }
    const skillsDir = claudeSkillsRoot()

    for (const def of SKILL_DEFINITIONS) {
      try {
        const content = buildSkillContent(def)
        if (skillBodyHasProjectStamp(content)) {
          throw new Error('refusing to install project-stamped skill body (isolation guard)')
        }
        const skillDir = path.join(skillsDir, def.name)
        const skillPath = path.join(skillDir, 'SKILL.md')

        await fs.mkdir(skillDir, { recursive: true })
        await fs.writeFile(skillPath, content, 'utf-8')

        if (def.reference && def.referenceFile) {
          await fs.writeFile(path.join(skillDir, def.referenceFile), def.reference(), 'utf-8')
        }

        result.generated.push({ name: def.name, path: skillPath })
      } catch (error) {
        log.debug(`Failed to generate skill ${def.name}`, {
          error: getErrorMessage(error),
        })
        result.skipped.push({ name: def.name, reason: getErrorMessage(error) })
      }
    }

    const compact = buildCompactSkill()
    for (const root of compactSkillRoots()) {
      try {
        const skillDir = path.join(root, 'prjct')
        const skillPath = path.join(skillDir, 'SKILL.md')
        await fs.mkdir(skillDir, { recursive: true })
        await fs.writeFile(skillPath, compact, 'utf-8')
        result.generated.push({ name: 'prjct-compact', path: skillPath })
      } catch (error) {
        log.debug('Compact skill install skipped', {
          root,
          error: getErrorMessage(error),
        })
      }
    }

    // Drop stale prjct-* skill dirs from older multi-skill layouts
    const knownNames = new Set(SKILL_DEFINITIONS.map((d) => d.name))
    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('prjct-') && !knownNames.has(entry.name)) {
          await fs
            .rm(path.join(skillsDir, entry.name), { recursive: true, force: true })
            .catch(() => {})
        }
      }
    } catch {
      /* non-critical */
    }

    if (result.generated.length > 0) {
      log.info('Generated portable multi-host skills', {
        count: result.generated.length,
        skills: result.generated.map((s) => s.name),
      })
    }

    return result
  }

  getDefinitions(): SkillDefinition[] {
    return SKILL_DEFINITIONS
  }
}

export const skillGenerator = new SkillGenerator()
export { SkillGenerator, SKILL_DEFINITIONS }
