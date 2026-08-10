/**
 * Project-level IDE rules for agents without global CLI config.
 *
 * IDEs can read project-specific rule targets declared by the runtime
 * registry. These are the project-level counterparts to `CLAUDE.md` and
 * `AGENTS.md`.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { getTemplateContent } from '../agentic/template-loader'
import { listProjectRuleTargets } from '../infrastructure/agent-runtime-registry'
import { fileExists } from '../utils/file-helper'
import { PACKAGE_ROOT } from '../utils/version'

export interface ProjectIdeRulesResult {
  written: string[]
}

async function loadTemplate(templateKey: string): Promise<string> {
  const bundled = getTemplateContent(templateKey)
  if (bundled) return bundled
  return fs.readFile(path.join(PACKAGE_ROOT, 'templates', templateKey), 'utf-8')
}

async function writeRule(projectPath: string, relativePath: string, templateKey: string) {
  const destination = path.join(projectPath, relativePath)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.writeFile(destination, await loadTemplate(templateKey), 'utf-8')
}

export async function writeProjectIdeRules(
  projectPath: string,
  options: { agents?: readonly string[] } = {}
): Promise<ProjectIdeRulesResult> {
  const selected = new Set(options.agents ?? [])
  const written: string[] = []

  for (const target of listProjectRuleTargets()) {
    const shouldWrite =
      selected.has(target.relativePath.split('/')[0].replace(/^\./, '')) ||
      (target.detectPath ? await fileExists(path.join(projectPath, target.detectPath)) : false)

    if (shouldWrite) {
      await writeRule(projectPath, target.relativePath, target.templateKey)
      written.push(target.relativePath)
    }
  }

  return { written }
}
