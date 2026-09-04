/**
 * `prjct guard <file>` — anticipation primitive (pillar 3), provider-agnostic.
 *
 * This is the CLI surface that lets Codex (and any agent without Claude
 * Code's hook system) reach the same preventive memory the pre-edit hook
 * injects proactively. Contract mirrors the hook: only gotchas /
 * anti-patterns / recurring-bugs surface; plain decisions never do; a file
 * with nothing preventive returns success + "clear to edit".
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GuardCommands } from '../../commands/guard'
import configManager from '../../infrastructure/config-manager'
import { projectMemory } from '../../memory/project-memory'
import { sourceInspectionToken, wasSourceInspected } from '../../services/source-first-gate'

async function freshProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-guard-test-'))
  await fs.mkdir(path.join(dir, '.prjct'), { recursive: true })
  const projectId = `test-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(dir, { projectId, dataPath: path.join(dir, '.prjct-data') })
  return dir
}

describe('guard verb', () => {
  const fixture: {
    projectPath: string
    cmd: GuardCommands
  } = {
    projectPath: '',
    cmd: undefined as unknown as GuardCommands,
  }

  beforeEach(async () => {
    fixture.projectPath = await freshProject()
    fixture.cmd = new GuardCommands()
  })

  afterEach(async () => {
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('fails when no file argument is given', async () => {
    const result = await fixture.cmd.guard('', fixture.projectPath, { md: true })
    expect(result.success).toBe(false)
  })

  test('surfaces a gotcha recorded against the file', async () => {
    await projectMemory.remember(fixture.projectPath, {
      type: 'gotcha',
      content: 'stale daemon caches old hook code; stop it before testing',
      tags: { file: 'core/daemon/daemon.ts' },
    })
    const result = await fixture.cmd.guard('core/daemon/daemon.ts', fixture.projectPath, {
      md: true,
    })
    expect(result.success).toBe(true)
    expect(result.hits).toBe(1)
  })

  test('returns clear-to-edit (success, 0 hits) when nothing preventive matches', async () => {
    await projectMemory.remember(fixture.projectPath, {
      type: 'decision',
      content: 'we use bun runtime',
      tags: { file: 'core/x.ts' },
    })
    const result = await fixture.cmd.guard('core/x.ts', fixture.projectPath, { md: true })
    expect(result.success).toBe(true)
    expect(result.hits).toBe(0)
  })

  test('the shell handshake shows bounded declarations from the actual source file', async () => {
    await fs.mkdir(path.join(fixture.projectPath, 'core'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.projectPath, 'core', 'existing.ts'),
      [
        "import { shared } from './shared'",
        'export function existingAbstraction() {',
        '  return shared()',
        '}',
      ].join('\n')
    )
    const logs: string[] = []
    const log = spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))
    try {
      const result = await fixture.cmd.guard('core/existing.ts', fixture.projectPath, { md: true })
      expect(result.success).toBe(true)
    } finally {
      log.mockRestore()
    }
    const output = logs.join('\n')
    expect(output).toContain('Source inspection')
    expect(output).toContain("import { shared } from './shared'")
    expect(output).toContain('export function existingAbstraction()')
    expect(output.length).toBeLessThan(3000)
  })

  test('matches an absolute path against a repo-relative file tag', async () => {
    await projectMemory.remember(fixture.projectPath, {
      type: 'gotcha',
      content: 'params metadata must use [..] not <..>',
      tags: { file: 'core/commands/embeddings.ts' },
    })
    const result = await fixture.cmd.guard(
      '/Users/dev/repo/core/commands/embeddings.ts',
      fixture.projectPath,
      {
        md: true,
      }
    )
    expect(result.success).toBe(true)
    expect(result.hits).toBe(1)
  })

  test('respects an explicit limit', async () => {
    for (const i of Array.from({ length: 4 }, (_, index) => index)) {
      await projectMemory.remember(fixture.projectPath, {
        type: 'gotcha',
        content: `trap ${i} on the hot file number ${i}`,
        tags: { file: 'core/hot.ts' },
      })
    }
    const result = await fixture.cmd.guard('core/hot.ts', fixture.projectPath, {
      md: true,
      limit: 2,
    })
    expect(result.success).toBe(true)
    expect(result.hits).toBe(2)
  })

  test('stamps the typed source-inspection token without process-global state', async () => {
    const file = 'core/tokenized.ts'
    const config = await configManager.readConfig(fixture.projectPath)
    const token = sourceInspectionToken({
      projectId: config!.projectId,
      projectPath: fixture.projectPath,
      sessionId: 'token-session',
      filePath: file,
    })
    expect(token).not.toBeNull()

    const result = await fixture.cmd.guard(file, fixture.projectPath, {
      md: true,
      sourceInspectionToken: token!,
    })

    expect(result.success).toBe(true)
    expect(
      await wasSourceInspected({
        projectId: config!.projectId,
        projectPath: fixture.projectPath,
        sessionId: 'token-session',
        filePath: file,
      })
    ).toBe(true)
  })
})
