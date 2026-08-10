/**
 * `prjct search "<query>"` — first-class memory search verb.
 *
 * Root-cause guard: before this verb existed, `prjct search "x"` was an
 * unknown verb and fell through `bin/prjct.ts`'s GTD auto-route, silently
 * CAPTURING "search x" to the inbox instead of searching. An agent's instinct
 * is `prjct search`, so that made memory unreachable. These tests pin that
 * (a) the verb is registered (→ never auto-captures) and (b) it runs the same
 * blended retrieval `context memory` uses.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ContextCommands } from '../../commands/context'
import { REGISTERED_VERBS_SET } from '../../commands/verb-names'
import configManager from '../../infrastructure/config-manager'
import { projectMemory } from '../../memory/project-memory'

async function freshProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-search-test-'))
  await fs.mkdir(path.join(dir, '.prjct'), { recursive: true })
  const projectId = `test-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(dir, { projectId, dataPath: path.join(dir, '.prjct-data') })
  return dir
}

describe('search verb', () => {
  test('is a registered verb (so it never auto-captures to the inbox)', () => {
    expect(REGISTERED_VERBS_SET.has('search')).toBe(true)
  })

  const fixture: {
    projectPath: string
    cmd: ContextCommands
  } = {
    projectPath: '',
    cmd: undefined as unknown as ContextCommands,
  }

  beforeEach(async () => {
    fixture.projectPath = await freshProject()
    fixture.cmd = new ContextCommands()
  })

  afterEach(async () => {
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('rejects an empty query', async () => {
    const result = await fixture.cmd.search('', fixture.projectPath, { md: true })
    expect(result.success).toBe(false)
  })

  test('finds a memory entry by its content (markdown output)', async () => {
    await projectMemory.remember(fixture.projectPath, {
      type: 'decision',
      content: 'we chose JWT with refresh-token rotation for the auth flow',
    })
    const result = await fixture.cmd.search('refresh-token rotation', fixture.projectPath, {
      md: true,
    })
    expect(result.success).toBe(true)
    expect(result.message).toContain('refresh-token rotation')
  })

  test('returns a JSON envelope when --md is not set (LLM-consumable)', async () => {
    await projectMemory.remember(fixture.projectPath, {
      type: 'gotcha',
      content: 'stale daemon caches old hook code; stop it before testing',
    })
    const result = await fixture.cmd.search('stale daemon', fixture.projectPath, {})
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.message ?? '')
    expect(parsed.tool).toBe('memory')
    expect(parsed.result.markdown).toContain('stale daemon')
  })

  test('fails cleanly outside a prjct project', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-search-noproj-'))
    try {
      const result = await fixture.cmd.search('anything', dir, { md: true })
      expect(result.success).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
