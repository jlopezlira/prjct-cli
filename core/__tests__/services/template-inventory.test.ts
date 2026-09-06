/**
 * Template inventory guard.
 *
 * These paths were retired because they duplicated a runtime generator or had
 * no consumer. Keeping the absence explicit prevents a later cleanup/build
 * from silently restoring a second source of truth.
 */

import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { getTemplateContent } from '../../agentic/template-loader'
import { EDITOR_SURFACE_BUILDERS } from '../../services/skill-generator/editor-surfaces'

const REPO_ROOT = path.resolve(__dirname, '../../..')
const TEMPLATES_ROOT = path.join(REPO_ROOT, 'templates')
const REQUIRED_PHYSICAL_TEMPLATES = [
  'templates/crew/CHECKPOINTS.md',
  'templates/crew/leader-mode.md',
  'templates/crew/roles/implementer.md',
  'templates/crew/roles/leader.md',
  'templates/crew/roles/reviewer.md',
  // Pi bridge (transport only), installed by core/infrastructure/pi-bridge.ts.
  'templates/pi/bridge.mjs',
  'templates/pi/index.ts',
  'templates/skills/prjct/SKILL.md',
] as const

const RETIRED_TEMPLATE_PATHS = [
  'templates/cursor/router.mdc',
  'templates/windsurf/router.md',
  'templates/global/WINDSURF.md',
  'templates/global/docs',
  'templates/.DS_Store',
  'templates/grok/SKILL.md',
  'templates/mcp-config.json',
  'templates/crew/registry.json',
  ...Object.keys(EDITOR_SURFACE_BUILDERS).map((key) => `templates/${key}`),
] as const

function collectTemplateFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name)
    return entry.isDirectory() ? collectTemplateFiles(absolutePath) : [absolutePath]
  })
}

describe('template inventory', () => {
  it('contains exactly the templates with a physical runtime consumer', () => {
    const actual = collectTemplateFiles(TEMPLATES_ROOT)
      .map((file) => path.relative(REPO_ROOT, file))
      .sort()

    expect(actual).toEqual([...REQUIRED_PHYSICAL_TEMPLATES].sort())
  })

  for (const relativePath of RETIRED_TEMPLATE_PATHS) {
    it(`does not restore redundant ${relativePath}`, () => {
      expect(fs.existsSync(path.join(REPO_ROOT, relativePath))).toBe(false)
    })
  }

  for (const [templateKey, build] of Object.entries(EDITOR_SURFACE_BUILDERS)) {
    it(`builds virtual ${templateKey} from its canonical builder`, () => {
      expect(getTemplateContent(templateKey)).toBe(build())
    })
  }

  it('contains no repeated non-structural source lines', () => {
    const firstLocation = new Map<string, string>()
    const duplicates: string[] = []

    for (const file of collectTemplateFiles(TEMPLATES_ROOT)) {
      const relativePath = path.relative(REPO_ROOT, file)
      for (const [index, rawLine] of fs.readFileSync(file, 'utf-8').split('\n').entries()) {
        const line = rawLine.trim()
        if (line.length < 20 || line.startsWith('<!--') || line.startsWith('```')) continue

        const location = `${relativePath}:${index + 1}`
        const first = firstLocation.get(line)
        if (first) duplicates.push(`${first} = ${location}: ${line}`)
        else firstLocation.set(line, location)
      }
    }

    expect(duplicates).toEqual([])
  })
})
