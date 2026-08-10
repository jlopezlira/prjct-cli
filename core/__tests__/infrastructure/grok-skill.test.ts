/**
 * Grok skill installer — ~/.grok/skills/prjct/SKILL.md
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildGrokSkillContent,
  getGrokSkillInstallPath,
  getGrokSkillTemplate,
  installGrokSkill,
} from '../../infrastructure/grok-skill'
import { buildCodexSkill } from '../../services/skill-generator/editor-surfaces'

const PREV_HOME = process.env.HOME
const PREV_TEST = process.env.PRJCT_TEST_MODE

const fixture: {
  home: string
} = {
  home: '',
}

beforeEach(async () => {
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-grok-skill-test-'))
  process.env.HOME = fixture.home
  process.env.PRJCT_TEST_MODE = '1'
})

afterEach(async () => {
  if (PREV_HOME === undefined) delete process.env.HOME
  else process.env.HOME = PREV_HOME
  if (PREV_TEST === undefined) delete process.env.PRJCT_TEST_MODE
  else process.env.PRJCT_TEST_MODE = PREV_TEST
  await fs.rm(fixture.home, { recursive: true, force: true }).catch(() => {})
})

describe('installGrokSkill', () => {
  it('reuses the canonical compact skill instead of carrying a Grok copy', () => {
    expect(getGrokSkillTemplate()).toBe(buildCodexSkill())
  })

  it('creates SKILL.md under the Grok skills path', async () => {
    const r = await installGrokSkill()
    expect(r.success).toBe(true)
    expect(r.action).toBe('created')
    const skillPath = getGrokSkillInstallPath()
    expect(r.path).toBe(skillPath)
    const body = await fs.readFile(skillPath, 'utf-8')
    expect(body).toContain('name: prjct')
    expect(body).toContain('prjct work')
    expect(body).toContain('prjct-grok-skill')
  })

  it('is idempotent when content matches', async () => {
    await installGrokSkill()
    const r = await installGrokSkill()
    expect(r.success).toBe(true)
    expect(r.action).toBe('unchanged')
  })

  it('buildGrokSkillContent stamps metadata hash', () => {
    const built = buildGrokSkillContent('# prjct\n\nRun verbs.\n')
    expect(built.templateHash).toHaveLength(12)
    expect(built.content).toContain('prjct-grok-skill')
  })
})
