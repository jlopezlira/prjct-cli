#!/usr/bin/env bun
/**
 * Materialize the one template consumed directly from disk by the bin shim.
 *
 * SSOT for the skill body lives in core/services/skill-generator/. This
 * script runs at build time and emits the static template that bin/prjct
 * self-heals into ~/.claude/skills/prjct/ on every CLI invocation.
 *
 * Editor-specific surfaces stay virtual and are built on demand through
 * template-loader. The generated file is .gitignored — `npm run build`
 * produces it, and `prepublishOnly` ensures it ships in the npm tarball.
 */

import fs from 'node:fs'
import path from 'node:path'
import { EDITOR_SURFACE_PATHS } from '../core/services/skill-generator/editor-surfaces'
import { buildPrjctSkill } from '../core/services/skill-generator/prjct-skill-body'

const ROOT = path.resolve(__dirname, '..')
const RETIRED_TEMPLATE_PATHS = ['.DS_Store', 'global/WINDSURF.md', 'global/docs'] as const

function emit(relParts: string[], content: string): void {
  const out = path.join(ROOT, 'templates', ...relParts)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, content)
  console.log(`  → templates/${relParts.join('/')} (${Buffer.byteLength(content, 'utf-8')} bytes)`)
}

function removeStaleEditorSurfaces(): void {
  for (const relativePath of [...EDITOR_SURFACE_PATHS, ...RETIRED_TEMPLATE_PATHS]) {
    fs.rmSync(path.join(ROOT, 'templates', ...relativePath.split('/')), {
      force: true,
      recursive: true,
    })
  }
}

removeStaleEditorSurfaces()

// Canonical Claude skill — always portable L0 (no project stamp; multi-LLM safe).
emit(['skills', 'prjct', 'SKILL.md'], buildPrjctSkill())
