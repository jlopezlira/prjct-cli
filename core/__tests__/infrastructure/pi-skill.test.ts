/**
 * Pi skill installer — ~/.pi/agent/skills/prjct/SKILL.md
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildPiSkillContent,
  getPiSkillInstallPath,
  installPiSkill,
} from '../../infrastructure/pi-skill'

const PREV_HOME = process.env.HOME
const PREV_TEST = process.env.PRJCT_TEST_MODE

const fixture: {
  home: string
} = {
  home: '',
}

beforeEach(async () => {
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-pi-skill-test-'))
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

describe('installPiSkill', () => {
  it('creates SKILL.md under the Pi skills path', async () => {
    const r = await installPiSkill()
    expect(r.success).toBe(true)
    expect(r.action).toBe('created')
    const skillPath = getPiSkillInstallPath()
    expect(r.path).toBe(skillPath)
    const body = await fs.readFile(skillPath, 'utf-8')
    expect(body).toContain('name: prjct')
    expect(body).toContain('prjct work')
    expect(body).toContain('prjct-pi-skill')
  })

  it('is idempotent when content matches', async () => {
    await installPiSkill()
    const r = await installPiSkill()
    expect(r.success).toBe(true)
    expect(r.action).toBe('unchanged')
  })

  it('buildPiSkillContent stamps metadata hash', () => {
    const built = buildPiSkillContent('# prjct\n\nRun verbs.\n')
    expect(built.templateHash).toHaveLength(12)
    expect(built.content).toContain('prjct-pi-skill')
  })
})
