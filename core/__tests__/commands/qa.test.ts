import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { COMMANDS } from '../../commands/command-data'
import { _internal, QaCommands } from '../../commands/qa'
import { REGISTERED_VERBS_SET } from '../../commands/verb-names'
import prjctDb from '../../storage/database'
import type { LocalConfig } from '../../types/config'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: { tmpRoot: string; projectDir: string; projectId: string } = {
  tmpRoot: '',
  projectDir: '',
  projectId: '',
}

async function readConfig(): Promise<LocalConfig> {
  return JSON.parse(
    await fs.readFile(path.join(fixture.projectDir, '.prjct', 'prjct.config.json'), 'utf8')
  ) as LocalConfig
}

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-qa-cmd-'))
  fixture.projectDir = path.join(fixture.tmpRoot, 'proj')
  await fs.mkdir(path.join(fixture.projectDir, '.prjct'), { recursive: true })
  fixture.projectId = `qa-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await fs.writeFile(
    path.join(fixture.projectDir, '.prjct', 'prjct.config.json'),
    JSON.stringify({ projectId: fixture.projectId, dataPath: fixture.tmpRoot })
  )
  patchPathManager(fixture.tmpRoot)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

function silenced<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log
  console.log = () => undefined
  return fn().finally(() => {
    console.log = original
  })
}

describe('qa — registration', () => {
  it('is a registered verb (so it never auto-captures to the inbox) and stays cold-only', () => {
    expect(REGISTERED_VERBS_SET.has('qa')).toBe(true)
    const meta = COMMANDS.find((c) => c.name === 'qa')
    expect(meta?.routing).toEqual({ group: 'qa', method: 'qa' })
    expect(meta?.routingMode).toBe('cold-only')
    expect(meta?.optionSchema?.strings).toContain('json')
    expect(_internal.QA_MODES).toEqual(['off', 'advisory', 'strict'])
    const ship = COMMANDS.find((c) => c.name === 'ship')
    expect(ship?.optionSchema?.booleans).toContain('noQaGate')
  })
})

describe('qa — command surface', () => {
  const cmd = new QaCommands()

  it('sets the mode and app values into the project config', async () => {
    const mode = await silenced(() => cmd.qa('strict', fixture.projectDir, { md: true }))
    expect(mode.success).toBe(true)
    expect((await readConfig()).qa?.mode).toBe('strict')
    const set = await silenced(() =>
      cmd.qa('set app.baseUrl http://localhost:4000', fixture.projectDir, { md: true })
    )
    expect(set.success).toBe(true)
    expect((await readConfig()).qa?.app?.baseUrl).toBe('http://localhost:4000')
    const bad = await silenced(() => cmd.qa('set nope x', fixture.projectDir, { md: true }))
    expect(bad.success).toBe(false)
  })

  it('status works without a cycle; plan/next/report demand one', async () => {
    const status = await silenced(() => cmd.qa(null, fixture.projectDir, { md: true }))
    expect(status.success).toBe(true)
    expect(status.plan).toBe(null)
    const plan = await silenced(() =>
      cmd.qa('plan', fixture.projectDir, { md: true, json: '{"criteria":["x — curl 200"]}' })
    )
    expect(plan.success).toBe(false)
    expect(String(plan.error)).toContain('No active work cycle')
    const next = await silenced(() => cmd.qa('next', fixture.projectDir, { md: true }))
    expect(next.success).toBe(false)
    const unknown = await silenced(() => cmd.qa('frobnicate', fixture.projectDir, { md: true }))
    expect(unknown.success).toBe(false)
    expect(String(unknown.error)).toContain('Unknown qa subcommand')
  })

  it('run without a cycle still produces a receipt (vacuous, said loudly)', async () => {
    const run = await silenced(() => cmd.qa('run', fixture.projectDir, { md: true }))
    expect(run.success).toBe(true)
    expect(run.vacuous).toBe(true)
    const receipt = await silenced(() => cmd.qa('receipt', fixture.projectDir, { md: true }))
    expect(receipt.success).toBe(true)
    expect(receipt.receipt).not.toBe(null)
  })
})
