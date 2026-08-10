/**
 * `prjct spec draft|new|create "<title>"` — friendly-alias routing test.
 *
 * The bug being prevented: there is no `draft` subverb, but agents/users
 * routinely type `prjct spec draft "rate limiting"` instead of the
 * canonical `prjct spec "rate limiting"`. Before the fix, the unknown
 * `draft` token fell through to the bare-title fallback and the spec was
 * silently created with the literal title "draft rate limiting" — a quiet
 * footgun that an agent recently hit while dogfooding.
 *
 * These tests pin the alias behavior at the daemon dispatch layer (the
 * path used by `p.` from Claude Code, and the same logic mirrors `routeSpec`
 * in core/index.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PrjctCommands } from '../../commands/commands'
// Side-effect import — registers every verb in the central commandRegistry.
// Without it, dispatch.ts treats `spec` as unknown and auto-routes to
// `capture`, masking the alias logic we're trying to test.
import '../../commands/register'
import { executeCommand } from '../../daemon/dispatch'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import prjctDb from '../../storage/database'

const fixture: {
  projectPath: string
  projectId: string
  originalProjectsDir: string | undefined
  originalCwd: string
  commands: PrjctCommands
} = {
  projectPath: '',
  projectId: '',
  originalProjectsDir: undefined as unknown as string | undefined,
  originalCwd: '',
  commands: undefined as unknown as PrjctCommands,
}

async function freshProject(): Promise<void> {
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-spec-aliases-pd-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir

  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-spec-aliases-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `aliases-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
}

beforeEach(async () => {
  prjctDb.close()
  await freshProject()
  fixture.originalCwd = process.cwd()
  process.chdir(fixture.projectPath)
  fixture.commands = new PrjctCommands()
})

afterEach(async () => {
  process.chdir(fixture.originalCwd)
  if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
  if (fixture.projectPath)
    await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  prjctDb.close()
})

describe('spec draft|new|create alias stripping', () => {
  test('`prjct spec "title"` (canonical) creates a spec titled "title"', async () => {
    const result = await executeCommand(fixture.commands, {
      id: 't',
      command: 'spec',
      args: ['rate limiting'],
      options: { md: true },
      cwd: fixture.projectPath,
    })
    expect(result.success).toBe(true)
    expect((result as { title?: string }).title).toBe('rate limiting')
  })

  test('`prjct spec draft "title"` strips `draft`, creates spec titled "title"', async () => {
    const result = await executeCommand(fixture.commands, {
      id: 't',
      command: 'spec',
      args: ['draft', 'rate limiting'],
      options: { md: true },
      cwd: fixture.projectPath,
    })
    expect(result.success).toBe(true)
    // The bug we are guarding: title MUST NOT be "draft rate limiting"
    expect((result as { title?: string }).title).toBe('rate limiting')
  })

  test('`prjct spec new "title"` strips `new`', async () => {
    const result = await executeCommand(fixture.commands, {
      id: 't',
      command: 'spec',
      args: ['new', 'auth refresh'],
      options: { md: true },
      cwd: fixture.projectPath,
    })
    expect(result.success).toBe(true)
    expect((result as { title?: string }).title).toBe('auth refresh')
  })

  test('`prjct spec create "title"` strips `create`', async () => {
    const result = await executeCommand(fixture.commands, {
      id: 't',
      command: 'spec',
      args: ['create', 'webhooks v2'],
      options: { md: true },
      cwd: fixture.projectPath,
    })
    expect(result.success).toBe(true)
    expect((result as { title?: string }).title).toBe('webhooks v2')
  })

  test('multi-word title after alias is preserved verbatim', async () => {
    const result = await executeCommand(fixture.commands, {
      id: 't',
      command: 'spec',
      args: ['draft', 'rate', 'limit', 'the', '/auth', 'endpoint'],
      options: { md: true },
      cwd: fixture.projectPath,
    })
    expect(result.success).toBe(true)
    expect((result as { title?: string }).title).toBe('rate limit the /auth endpoint')
  })

  test('alias-only (no title) fails the same as bare `prjct spec`', async () => {
    const result = await executeCommand(fixture.commands, {
      id: 't',
      command: 'spec',
      args: ['draft'],
      options: { md: true },
      cwd: fixture.projectPath,
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/title/i)
  })

  test('real subverbs still route (alias must NOT shadow `list`)', async () => {
    // First create a spec so list has something to render.
    await executeCommand(fixture.commands, {
      id: 't',
      command: 'spec',
      args: ['canary spec'],
      options: { md: true },
      cwd: fixture.projectPath,
    })
    const result = await executeCommand(fixture.commands, {
      id: 't',
      command: 'spec',
      args: ['list'],
      options: { md: true },
      cwd: fixture.projectPath,
    })
    expect(result.success).toBe(true)
  })

  test('`breakdown` routes as a subverb, NOT a draft title (regression: was missing from knownSubverbs)', async () => {
    // The bug: `breakdown` had a `case` in the switch but was absent from
    // `knownSubverbs` in BOTH routers, so `prjct spec breakdown <id>` fell
    // through to the bare-title path and silently created a spec titled
    // "breakdown <id>" instead of breaking the spec down. Guard: the result
    // must NOT be a draft whose title is the literal "breakdown ...".
    const result = await executeCommand(fixture.commands, {
      id: 't',
      command: 'spec',
      args: ['breakdown', 'spec_nonexistent'],
      options: { md: true },
      cwd: fixture.projectPath,
    })
    expect((result as { title?: string }).title).not.toBe('breakdown spec_nonexistent')
  })

  test('non-alias unknown first token still falls through to bare-title (back-compat)', async () => {
    // `prjct spec "fix the thing"` — first word "fix" isn't a subverb, so
    // the entire string remains the title. This guards the existing
    // behavior so the alias change doesn't accidentally tighten parsing.
    const result = await executeCommand(fixture.commands, {
      id: 't',
      command: 'spec',
      args: ['fix', 'the', 'login', 'flow'],
      options: { md: true },
      cwd: fixture.projectPath,
    })
    expect(result.success).toBe(true)
    expect((result as { title?: string }).title).toBe('fix the login flow')
  })
})
