/**
 * SubagentStart hook — compact digest invariants.
 *
 * Subagents receive `buildSubagentDigest`, not the full session context:
 * role + this worktree's active work cycle + top preventive traps, hard-capped
 * at 500 chars. Emitted via `systemMessage` (outside the cached prompt
 * prefix), so variable content is allowed here — unlike SessionStart.
 *
 * Locked invariants:
 *   1. No projectId in config → null (skip injection).
 *   2. No persona, no active work, no traps → null (nothing to say).
 *   3. Gotchas/anti-patterns surface as traps; other types do not.
 *   4. Output never exceeds the 500-char cap.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildSubagentDigest } from '../../hooks/session-start'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import prjctDb from '../../storage/database'

const fixture: {
  projectPath: string
  projectId: string
} = {
  projectPath: '',
  projectId: '',
}

async function freshProject(persona?: Record<string, unknown>): Promise<void> {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-subagent-start-test-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `test-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
    ...(persona ? { persona } : {}),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
}

function insertMemory(type: string, content: string): void {
  prjctDb.run(
    fixture.projectId,
    "INSERT INTO events (type, data, timestamp) VALUES (?, ?, datetime('now'))",
    `memory.remember.${type}`,
    JSON.stringify({ content, tags: {}, provenance: 'declared' })
  )
}

afterEach(async () => {
  if (fixture.projectPath) {
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
    fixture.projectPath = ''
  }
})

describe('SubagentStart hook — buildSubagentDigest', () => {
  test('returns null when config has no projectId', async () => {
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-subagent-no-id-'))
    await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.projectPath, '.prjct', 'prjct.config.json'),
      JSON.stringify({ dataPath: '' })
    )
    const ctx = await buildSubagentDigest(fixture.projectPath)
    expect(ctx).toBeNull()
  })

  test('returns null when there is nothing to say', async () => {
    await freshProject()
    const ctx = await buildSubagentDigest(fixture.projectPath)
    expect(ctx).toBeNull()
  })

  test('includes persona role when configured', async () => {
    await freshProject({ role: 'backend specialist' })
    const ctx = await buildSubagentDigest(fixture.projectPath)
    expect(ctx).toContain('backend specialist')
  })

  test('surfaces gotchas as traps', async () => {
    await freshProject()
    insertMemory('gotcha', 'The daemon caches stale hook code until restarted')
    const ctx = await buildSubagentDigest(fixture.projectPath)
    expect(ctx).toContain('Traps to avoid')
    expect(ctx).toContain('daemon caches stale hook code')
  })

  test('does not surface non-preventive memory types', async () => {
    await freshProject()
    insertMemory('decision', 'We chose SQLite over JSON files')
    const ctx = await buildSubagentDigest(fixture.projectPath)
    expect(ctx).toBeNull()
  })

  test('never exceeds the 500-char cap', async () => {
    await freshProject({ role: 'fullstack' })
    for (const i of Array.from({ length: 5 }, (_, index) => index)) {
      insertMemory('gotcha', `Very long trap description number ${i} — ${'x'.repeat(300)}`)
    }
    const ctx = await buildSubagentDigest(fixture.projectPath)
    expect(ctx).not.toBeNull()
    expect((ctx as string).length).toBeLessThanOrEqual(500)
  })
})
