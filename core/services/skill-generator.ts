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
import { getKimiSkillPath } from '../infrastructure/kimi-skill-path'
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
    // Kimi Code CLI user tier. Docs (kimi.com/code/docs …/customization/skills.html)
    // list $KIMI_CODE_HOME/skills as canonical; we deliberately do NOT use the
    // shared ~/.agents/skills root: pi (and other Agent Skills-standard hosts)
    // scan it too, and a same-named `prjct` skill there collides with the
    // dedicated ~/.pi/agent/skills/prjct install (pi warns every session and
    // keeps only the first). The Kimi-specific root keeps coverage without the
    // cross-harness name collision.
    path.dirname(path.dirname(getKimiSkillPath())),
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
        if (skillPath === getKimiSkillPath()) {
          const directory = await fs.lstat(skillDir).catch(() => null)
          const stat = await fs.lstat(skillPath).catch(() => null)
          const existing = stat?.isFile() ? await fs.readFile(skillPath, 'utf8') : null
          if (directory?.isSymbolicLink() || (stat && (!stat.isFile() || existing !== compact))) {
            result.skipped.push({
              name: 'prjct-compact',
              reason: `Preserved customized Kimi skill: ${skillPath}`,
            })
            continue
          }
        }
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

    // Legacy sweep: older versions fanned the compact skill out to the shared
    // ~/.agents/skills tier. pi scans that root natively, so the leftover copy
    // collides with the dedicated ~/.pi/agent/skills/prjct skill (pi warns and
    // keeps the first). Remove only copies that are provably prjct-managed.
    const kimiSkill = getKimiSkillPath()
    if (result.generated.some((skill) => skill.path === kimiSkill)) {
      await this.sweepLegacySharedSkill(result)
    }

    if (result.generated.length > 0) {
      log.info('Generated portable multi-host skills', {
        count: result.generated.length,
        skills: result.generated.map((s) => s.name),
      })
    }

    return result
  }

  /**
   * Remove prjct-managed skills left under the shared `~/.agents/skills` root
   * by pre-pi-compat fan-out (or manual backups). pi discovers skills
   * recursively and reads the name from frontmatter, so ANY directory whose
   * SKILL.md declares `name: prjct` collides with the dedicated
   * ~/.pi/agent/skills/prjct install — not just a `prjct/` dir. Conservative:
   * only migrates exact generated content; foreign content is left untouched.
   * Auxiliary files and symlinks are never removed.
   */
  private async sweepLegacySharedSkill(result: SkillGenerationResult): Promise<void> {
    const sharedRoot = path.join(homeDir(), '.agents', 'skills')
    try {
      const entries = await fs.readdir(sharedRoot, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillFile = path.join(sharedRoot, entry.name, 'SKILL.md')
        const stat = await fs.lstat(skillFile).catch(() => null)
        if (!stat?.isFile()) continue // Never follow user-managed symlinks.
        const content = await fs.readFile(skillFile, 'utf-8').catch(() => '')
        if (!content || !/^name:\s*prjct\s*$/m.test(content)) continue
        if (content.trimEnd() !== buildCompactSkill().trimEnd()) {
          result.skipped.push({
            name: 'prjct-legacy-shared',
            reason: `Preserved customized or unknown skill at ${skillFile}; pi may report a collision`,
          })
          continue
        }
        // Backups must be OUTSIDE skill discovery roots; renaming the skill
        // directory in place still leaves name: prjct discoverable by pi.
        const backupRoot = path.join(homeDir(), '.prjct', 'backups', 'skills')
        await fs.mkdir(backupRoot, { recursive: true })
        const backupDir = await fs.mkdtemp(path.join(backupRoot, 'pi-migration-'))
        await fs.rename(skillFile, path.join(backupDir, 'SKILL.md'))
        // Do not remove the directory: it may hold user scripts or references.
        result.skipped.push({
          name: 'prjct-legacy-shared',
          reason: `Backed up ${skillFile} to ${backupDir}`,
        })
      }
    } catch {
      /* non-critical */
    }
  }

  getDefinitions(): SkillDefinition[] {
    return SKILL_DEFINITIONS
  }
}

export const skillGenerator = new SkillGenerator()
export { SkillGenerator, SKILL_DEFINITIONS }
