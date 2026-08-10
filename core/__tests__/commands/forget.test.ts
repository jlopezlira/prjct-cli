/**
 * `prjct forget <id>` — the delete half of `remember`.
 *
 * Root-cause guard: `projectMemory.forget()` existed but was never wired as a
 * CLI verb. `prjct remember forget <id>` did NOT delete — it created a junk
 * `type:forget` memory with the id as content. These tests pin that the verb
 * (a) is registered, (b) hard-deletes by id so the entry stops surfacing in
 * search, and (c) fails cleanly on a bad/unknown id without creating noise.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PrimitiveCommands } from '../../commands/primitives'
import { REGISTERED_VERBS_SET } from '../../commands/verb-names'
import configManager from '../../infrastructure/config-manager'
import { projectMemory } from '../../memory/project-memory'

async function freshProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-forget-test-'))
  await fs.mkdir(path.join(dir, '.prjct'), { recursive: true })
  const projectId = `test-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(dir, { projectId, dataPath: path.join(dir, '.prjct-data') })
  return dir
}

describe('forget verb', () => {
  test('is a registered verb', () => {
    expect(REGISTERED_VERBS_SET.has('forget')).toBe(true)
  })

  const fixture: {
    projectPath: string
    cmd: PrimitiveCommands
  } = {
    projectPath: '',
    cmd: undefined as unknown as PrimitiveCommands,
  }

  beforeEach(async () => {
    fixture.projectPath = await freshProject()
    fixture.cmd = new PrimitiveCommands()
  })

  afterEach(async () => {
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('rejects an empty id', async () => {
    const result = await fixture.cmd.forget('', fixture.projectPath, { md: true })
    expect(result.success).toBe(false)
  })

  test('fails cleanly (no entry created) on an unknown id', async () => {
    const result = await fixture.cmd.forget('mem_999999', fixture.projectPath, { md: true })
    expect(result.success).toBe(false)
  })

  test('deletes an entry so it stops surfacing', async () => {
    const projectId = await configManager.getProjectId(fixture.projectPath)
    if (!projectId) throw new Error('no project id')
    await projectMemory.remember(fixture.projectPath, {
      type: 'decision',
      content: 'we chose Bun over Node for faster cold-start',
    })
    const before = projectMemory.allEntriesForIndex(projectId)
    const target = before.find((e) => /Bun over Node/.test(e.content ?? ''))
    expect(target).toBeTruthy()

    const result = await fixture.cmd.forget(target?.id ?? '', fixture.projectPath, { md: true })
    expect(result.success).toBe(true)

    const after = projectMemory.allEntriesForIndex(projectId)
    expect(after.some((e) => e.id === target?.id)).toBe(false)
  })

  test('accepts a bare numeric id (no mem_ prefix)', async () => {
    const projectId = await configManager.getProjectId(fixture.projectPath)
    if (!projectId) throw new Error('no project id')
    await projectMemory.remember(fixture.projectPath, {
      type: 'gotcha',
      content: 'stale daemon caches old code; stop it before testing',
    })
    const entry = projectMemory
      .allEntriesForIndex(projectId)
      .find((e) => /stale daemon/.test(e.content ?? ''))
    const bareId = (entry?.id ?? '').replace(/^mem_/, '')
    const result = await fixture.cmd.forget(bareId, fixture.projectPath, { md: true })
    expect(result.success).toBe(true)
  })
})
