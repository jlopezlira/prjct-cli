/**
 * Shared idempotent-install flow for the per-host SKILL.md installers
 * (Grok, Pi, Codex, …): build the file content from a template, skip the
 * write when it already matches on disk, otherwise write it — and always
 * report `{success, action, path}` the same way.
 *
 * Extracted from grok-skill.ts / pi-skill.ts, which duplicated this tail
 * end to end (jscpd). Host-specific concerns (path resolution, template
 * loading/fallback, byte-cap warnings) stay in each host's own module —
 * only `build` and `logLabel` differ per caller.
 */

import fs from 'node:fs/promises'
import { getErrorMessage } from '../types/fs'
import log from '../utils/logger'

export interface SkillContentBuild {
  content: string
  templateHash: string
}

export interface WriteSkillIfChangedInput {
  /** Destination SKILL.md path. */
  skillMdPath: string
  /** Whether a file already exists at `skillMdPath` (caller already checked). */
  skillExists: boolean
  /** Raw template text to build from. */
  templateContent: string
  /** Builds the final file content (+ metadata hash) from the template. */
  build: (templateContent: string) => SkillContentBuild
  /** Host name used in the warning log line, e.g. "Grok", "Pi", "Codex". */
  logLabel: string
}

export interface WriteSkillIfChangedResult {
  success: boolean
  action: string | null
  path?: string
}

/**
 * Build → skip if unchanged → write → report. Never throws — any failure
 * (build, read, write) is logged via `logLabel` and reported as
 * `{success: false, action: null}`, matching each installer's existing
 * fail-soft contract.
 */
export async function writeSkillIfChanged(
  input: WriteSkillIfChangedInput
): Promise<WriteSkillIfChangedResult> {
  const { skillMdPath, skillExists, templateContent, build, logLabel } = input
  try {
    const built = build(templateContent)

    if (skillExists) {
      const existing = await fs.readFile(skillMdPath, 'utf-8').catch(() => '')
      if (existing === built.content) {
        return { success: true, action: 'unchanged', path: skillMdPath }
      }
    }

    await fs.writeFile(skillMdPath, built.content, 'utf-8')

    return { success: true, action: skillExists ? 'updated' : 'created', path: skillMdPath }
  } catch (error) {
    log.warn(`${logLabel} skill warning: ${getErrorMessage(error)}`)
    return { success: false, action: null }
  }
}
