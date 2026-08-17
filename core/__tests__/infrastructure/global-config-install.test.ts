/**
 * installGlobalConfig (command-installer/global-config) tests.
 *
 * Covers the sync-time optimizations:
 *  - a caller-resolved provider is threaded down, skipping detectProvider's
 *    `<cli> --version` spawn entirely (the fake provider below points at a
 *    temp configDir, so any real detection would also be observable as a
 *    write outside the temp dir — none happens).
 *  - compare-before-write: re-installing identical content reports
 *    'unchanged' and leaves the file (and its mtime) untouched, following
 *    the writeSkillIfChanged idiom.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { installGlobalConfig } from '../../infrastructure/command-installer/global-config'
import type { AIProviderConfig } from '../../types/provider'

const fixture: { tempDir: string } = { tempDir: '' }

beforeEach(async () => {
  fixture.tempDir = path.join(
    os.tmpdir(),
    `prjct-global-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await fs.mkdir(fixture.tempDir, { recursive: true })
})

function fakeProvider(name: 'claude' | 'gemini', configDir: string | null): AIProviderConfig {
  return {
    name,
    displayName: name === 'claude' ? 'Claude Code' : 'Gemini CLI',
    cliCommand: name,
    configDir,
    contextFile: name === 'claude' ? 'CLAUDE.md' : 'GEMINI.md',
  } as AIProviderConfig
}

describe('installGlobalConfig with a resolved provider', () => {
  test('creates the global context file in the resolved provider configDir', async () => {
    const result = await installGlobalConfig(fakeProvider('claude', fixture.tempDir))

    expect(result.success).toBe(true)
    expect(result.action).toBe('created')
    expect(result.path).toBe(path.join(fixture.tempDir, 'CLAUDE.md'))

    const written = await fs.readFile(result.path!, 'utf-8')
    expect(written).toContain('<!-- prjct:start - DO NOT REMOVE THIS MARKER -->')
  })

  test('reports unchanged and does not rewrite identical content', async () => {
    const provider = fakeProvider('claude', fixture.tempDir)
    const first = await installGlobalConfig(provider)
    expect(first.action).toBe('created')

    const statBefore = await fs.stat(first.path!)
    // Ensure an mtime bump would be observable even on coarse filesystems.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const second = await installGlobalConfig(provider)
    expect(second.success).toBe(true)
    expect(second.action).toBe('unchanged')

    const statAfter = await fs.stat(first.path!)
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs)
  })

  test('preserves user content outside the markers and still detects unchanged', async () => {
    const provider = fakeProvider('claude', fixture.tempDir)
    const first = await installGlobalConfig(provider)
    const withNotes = `# My own notes\n\n${await fs.readFile(first.path!, 'utf-8')}`
    await fs.writeFile(first.path!, withNotes, 'utf-8')

    // mergeWithMarkers is idempotent here: user notes live outside the
    // markers, so the merged output is byte-identical to what's on disk and
    // compare-before-write must report 'unchanged' (no rewrite).
    const updated = await installGlobalConfig(provider)
    expect(updated.action).toBe('unchanged')
    const merged = await fs.readFile(first.path!, 'utf-8')
    expect(merged).toContain('# My own notes')
    expect(merged).toBe(withNotes)
  })

  test('skips providers without a config dir', async () => {
    const result = await installGlobalConfig(fakeProvider('claude', null))
    expect(result.success).toBe(false)
    expect(result.action).toBe('skipped')
  })
})

describe('CommandInstaller.syncCommands with a resolved provider', () => {
  test('initializes from the resolved provider and cleans legacy router files', async () => {
    const { CommandInstaller } = await import('../../infrastructure/command-installer')
    const installer = new CommandInstaller()
    const provider = fakeProvider('claude', fixture.tempDir)

    const commandsDir = path.join(fixture.tempDir, 'commands')
    await fs.mkdir(commandsDir, { recursive: true })
    await fs.writeFile(path.join(commandsDir, 'p.md'), 'legacy router', 'utf-8')

    const result = await installer.syncCommands(provider)
    expect(result.success).toBe(true)
    expect(result.removed).toBe(1)
    expect(installer.commandsPath).toBe(commandsDir)

    // Second sync: nothing left to remove.
    const again = await installer.syncCommands(provider)
    expect(again.success).toBe(true)
    expect(again.removed).toBe(0)
  })
})
