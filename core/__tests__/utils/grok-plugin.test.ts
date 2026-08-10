/**
 * Grok host-plugin materializer — ~/.grok/plugins/prjct
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getGrokPluginRoot, grokPluginInstalled, installGrokPlugin } from '../../utils/grok-plugin'

const PREV_HOME = process.env.HOME
const PREV_TEST = process.env.PRJCT_TEST_MODE

const fixture: {
  home: string
} = {
  home: '',
}

beforeEach(async () => {
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-grok-plugin-test-'))
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

describe('installGrokPlugin', () => {
  it('materializes plugin.json, skill, and plan command', async () => {
    const r = await installGrokPlugin()
    expect(r.success).toBe(true)
    expect(r.changed).toBe(true)
    expect(r.path).toBe(getGrokPluginRoot())

    const pluginJson = await fs.readFile(path.join(r.path, 'plugin.json'), 'utf-8')
    expect(JSON.parse(pluginJson).name).toBe('prjct')

    const skill = await fs.readFile(path.join(r.path, 'skills', 'prjct', 'SKILL.md'), 'utf-8')
    expect(skill).toContain('prjct work')

    const planCmd = await fs.readFile(path.join(r.path, 'commands', 'plan.md'), 'utf-8')
    expect(planCmd).toContain('prjct plan')
    expect(await grokPluginInstalled()).toBe(true)
  })

  it('is idempotent', async () => {
    await installGrokPlugin()
    const r = await installGrokPlugin()
    expect(r.success).toBe(true)
    expect(r.changed).toBe(false)
  })
})
