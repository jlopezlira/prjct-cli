/**
 * `prjct capture` — GTD inbox verb.
 *
 * Focus on behavior, not wiring: the verb persists memory with
 * type=inbox, accepts tags, refuses secrets unless forced, and
 * declines empty input. Project init + storage are exercised via
 * real tmp projects — we test the full path, not a mock.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CaptureCommands } from '../../commands/capture'
import configManager from '../../infrastructure/config-manager'
import { projectMemory } from '../../memory/project-memory'

async function freshProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-capture-test-'))
  await fs.mkdir(path.join(dir, '.prjct'), { recursive: true })
  const projectId = `test-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(dir, { projectId, dataPath: path.join(dir, '.prjct-data') })
  return dir
}

describe('capture verb', () => {
  const fixture: {
    projectPath: string
    cmd: CaptureCommands
  } = {
    projectPath: '',
    cmd: undefined as unknown as CaptureCommands,
  }

  beforeEach(async () => {
    fixture.projectPath = await freshProject()
    fixture.cmd = new CaptureCommands()
  })

  afterEach(async () => {
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('writes memory with type=inbox', async () => {
    const result = await fixture.cmd.capture('call Ana re pricing', fixture.projectPath, {
      md: true,
    })
    expect(result.success).toBe(true)

    const config = await configManager.readConfig(fixture.projectPath)
    const entries = projectMemory.recall(config!.projectId, { limit: 10 })
    const inbox = entries.filter((e) => e.type === 'inbox')
    expect(inbox.length).toBe(1)
    expect(inbox[0].content).toBe('call Ana re pricing')
  })

  test('parses --tags k:v,k:v into memory tags', async () => {
    await fixture.cmd.capture('review board deck', fixture.projectPath, {
      md: true,
      tags: 'audience:board,priority:high',
    })

    const config = await configManager.readConfig(fixture.projectPath)
    const entries = projectMemory.recall(config!.projectId, { limit: 10 })
    expect(entries[0].tags).toEqual({ audience: 'board', priority: 'high' })
  })

  test('refuses empty content', async () => {
    const result = await fixture.cmd.capture('   ', fixture.projectPath, { md: true })
    expect(result.success).toBe(false)
  })

  test('refuses secret-like content unless --force', async () => {
    // Realistic id, assembled at runtime: the documented AKIAIOSFODNN7EXAMPLE value
    // is a doc placeholder and is deliberately no longer treated as a secret.
    const secret = `note: aws key ${'AKIA'}3QP7ZK2WLMN4RTBD rotate`
    const blocked = await fixture.cmd.capture(secret, fixture.projectPath, { md: true })
    expect(blocked.success).toBe(false)

    const forced = await fixture.cmd.capture(secret, fixture.projectPath, { md: true, force: true })
    expect(forced.success).toBe(true)
  })

  test('persists without an active task', async () => {
    // No stateStorage.setCurrentTask — capture must still work.
    const result = await fixture.cmd.capture('random thought', fixture.projectPath, { md: true })
    expect(result.success).toBe(true)

    const config = await configManager.readConfig(fixture.projectPath)
    const entries = projectMemory.recall(config!.projectId, { limit: 10 })
    expect(entries.length).toBeGreaterThan(0)
  })
})
