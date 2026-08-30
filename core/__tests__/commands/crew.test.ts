/**
 * `prjct crew` install/uninstall/status.
 *
 * Behavior-focused: each test runs the command against a real tmp project
 * and asserts on the resulting SQLite + filesystem state. Crew state lives
 * in the project kv_store; no agent-facing files are written to the repo.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CrewCommands } from '../../commands/crew'
import configManager from '../../infrastructure/config-manager'
import crewStateStorage from '../../storage/crew-state-storage'
import { prjctDb } from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

async function freshProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'prjct-crew-test-'))
}

describe('prjct crew', () => {
  const fixture: {
    projectPath: string
    projectId: string
    cmd: CrewCommands
  } = {
    projectPath: '',
    projectId: '',
    cmd: undefined as unknown as CrewCommands,
  }

  beforeEach(async () => {
    fixture.projectPath = await freshProject()
    fixture.projectId = `crew-${Math.random().toString(36).slice(2, 10)}`
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
    })
    patchPathManager(fixture.projectPath)
    // Touch the DB so the file is created under the mocked path.
    prjctDb.get(fixture.projectId, 'SELECT 1')
    fixture.cmd = new CrewCommands()
  })

  afterEach(async () => {
    prjctDb.close(fixture.projectId)
    restorePathManager()
    if (fixture.projectPath)
      await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  })

  test('install does not write agent-facing files to the repository', async () => {
    const result = await fixture.cmd.install(null, fixture.projectPath, { md: true })
    expect(result.success).toBe(true)

    for (const f of [
      '.claude/agents/leader.md',
      '.claude/agents/implementer.md',
      '.claude/agents/reviewer.md',
      'CLAUDE.md',
      'CREW.md',
      '.prjct/CHECKPOINTS.md',
    ]) {
      const exists = await fs
        .access(path.join(fixture.projectPath, f))
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(false)
    }
  })

  test('install persists crew state in the project kv_store', async () => {
    const result = await fixture.cmd.install(null, fixture.projectPath, { md: true })
    expect(result.success).toBe(true)

    const state = crewStateStorage.get(fixture.projectId)
    expect(state).not.toBeNull()
    expect(state?.enabled).toBe(true)
    expect(state?.mechanism === 'native' || state?.mechanism === 'emulated').toBe(true)
    expect(typeof state?.installedAt).toBe('string')

    if (state?.mechanism === 'emulated') {
      expect(state.emulatedProtocol).toBeDefined()
      expect(state.emulatedProtocol!.length).toBeGreaterThan(0)
    } else {
      expect(state?.agents).toBeDefined()
      expect(state?.agents?.leader.length).toBeGreaterThan(0)
      expect(state?.agents?.implementer.length).toBeGreaterThan(0)
      expect(state?.agents?.reviewer.length).toBeGreaterThan(0)
    }
  })

  test('install is idempotent and updates the state row', async () => {
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    const first = crewStateStorage.get(fixture.projectId)!

    await new Promise((resolve) => setTimeout(resolve, 10))
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    const second = crewStateStorage.get(fixture.projectId)!

    expect(second.enabled).toBe(true)
    expect(second.installedAt).not.toBe(first.installedAt)
  })

  test('uninstall removes the crew state row and resets checkpoints', async () => {
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    await fixture.cmd.checkpoints('set', fixture.projectPath, {
      content: '# custom checkpoints\n- [ ] gate\n',
    })
    expect(crewStateStorage.get(fixture.projectId)).not.toBeNull()

    const result = await fixture.cmd.uninstall(null, fixture.projectPath, { md: true })
    expect(result.success).toBe(true)

    expect(crewStateStorage.get(fixture.projectId)).toBeNull()
    const row = await fixture.cmd.checkpoints('show', fixture.projectPath)
    expect(row.success).toBe(true)
    expect(row.source).toBe('default')
  })

  test('status reports complete=false on a fresh project', async () => {
    const result = await fixture.cmd.status(null, fixture.projectPath, { md: true })
    expect(result.success).toBe(true)
    expect(result.complete).toBe(false)
  })

  test('status reports complete=true after install', async () => {
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    const result = await fixture.cmd.status(null, fixture.projectPath, { md: true })
    expect(result.success).toBe(true)
    expect(result.complete).toBe(true)
  })

  test('status reports complete=false after uninstall', async () => {
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    await fixture.cmd.uninstall(null, fixture.projectPath, { md: true })
    const result = await fixture.cmd.status(null, fixture.projectPath, { md: true })
    expect(result.success).toBe(true)
    expect(result.complete).toBe(false)
  })

  test('checkpoints set/show/reset work through kv_store', async () => {
    await fixture.cmd.install(null, fixture.projectPath, { md: true })

    const setResult = await fixture.cmd.checkpoints('set', fixture.projectPath, {
      content: '# custom\n- [ ] gate\n',
    })
    expect(setResult.success).toBe(true)
    expect(setResult.source).toBe('user')

    const showResult = await fixture.cmd.checkpoints('show', fixture.projectPath)
    expect(showResult.success).toBe(true)

    const resetResult = await fixture.cmd.checkpoints('reset', fixture.projectPath)
    expect(resetResult.success).toBe(true)
    expect(resetResult.reset).toBe(true)
  })

  test('record-run persists a crew run row', async () => {
    await fixture.cmd.install(null, fixture.projectPath, { md: true })

    const result = await fixture.cmd.recordRun(fixture.projectPath, {
      'implementer-summary': 'Implemented feature X',
      'reviewer-verdict': 'APPROVED',
      'reviewer-notes': 'looks good',
      files: 'src/a.ts,src/a.test.ts',
    })

    expect(result.success).toBe(true)
    expect(typeof result.runId).toBe('string')
  })

  test('record-run rejects missing or invalid verdict', async () => {
    await fixture.cmd.install(null, fixture.projectPath, { md: true })

    const missing = await fixture.cmd.recordRun(fixture.projectPath, {
      'implementer-summary': 'Implemented feature X',
    })
    expect(missing.success).toBe(false)

    const invalid = await fixture.cmd.recordRun(fixture.projectPath, {
      'implementer-summary': 'Implemented feature X',
      'reviewer-verdict': 'MAYBE',
    } as unknown as Parameters<CrewCommands['recordRun']>[1])
    expect(invalid.success).toBe(false)
  })
})
