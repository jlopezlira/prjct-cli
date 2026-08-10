/**
 * Codex MCP wiring — `[mcp_servers.prjct]` in ~/.codex/config.toml.
 *
 * Pins the contract:
 *   1. No config.toml → created with managed MCP + status_line.
 *   2. Existing user config without our entry → block appended, user
 *      content byte-preserved.
 *   3. Existing managed block → replaced in place (upgrade path),
 *      idempotent when nothing changed.
 *   4. User-managed `[mcp_servers.prjct]` (no markers) → preserved;
 *      status_line is still added when absent.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildCodexStatusLineToml,
  buildContext7McpTomlBlock,
  buildPrjctMcpTomlBlock,
  codexHasContext7Server,
  ensureCodexContext7Server,
  ensureCodexMcpServer,
} from '../../utils/codex-mcp'

const fixture: {
  dir: string
  configPath: string
} = {
  dir: '',
  configPath: '',
}

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-codex-mcp-test-'))
  fixture.configPath = path.join(fixture.dir, 'config.toml')
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

describe('ensureCodexMcpServer', () => {
  it('creates config.toml with the prjct server when missing', async () => {
    const r = await ensureCodexMcpServer(fixture.configPath)
    expect(r.changed).toBe(true)
    const body = await fs.readFile(fixture.configPath, 'utf-8')
    expect(body).toContain('[mcp_servers.prjct]')
    expect(body).toContain('# prjct:mcp:start')
    expect(body).toContain('# prjct:mcp:end')
    expect(body).toContain('[tui]')
    expect(body).toContain(
      'status_line = ["model-with-reasoning", "current-dir", "git-branch", "context-remaining", "five-hour-limit", "weekly-limit", "task-progress"]'
    )
    expect(body).toMatch(/command = "/)
  })

  it('appends to an existing config without touching user content', async () => {
    const user = '[projects."/Users/x/app"]\ntrust_level = "trusted"\n'
    await fs.writeFile(fixture.configPath, user, 'utf-8')

    const r = await ensureCodexMcpServer(fixture.configPath)
    expect(r.changed).toBe(true)
    const body = await fs.readFile(fixture.configPath, 'utf-8')
    expect(body).toContain('trust_level = "trusted"')
    expect(body.indexOf('[projects.')).toBeLessThan(body.indexOf('[mcp_servers.prjct]'))
    expect(body.indexOf('[mcp_servers.prjct]')).toBeLessThan(body.indexOf('[tui]'))
  })

  it('replaces a stale managed block in place', async () => {
    await ensureCodexMcpServer(fixture.configPath)
    const before = await fs.readFile(fixture.configPath, 'utf-8')
    const stale = before.replace(/command = "[^"]*"/, 'command = "old-binary"')
    await fs.writeFile(fixture.configPath, stale, 'utf-8')

    const r = await ensureCodexMcpServer(fixture.configPath)
    expect(r.changed).toBe(true)
    const after = await fs.readFile(fixture.configPath, 'utf-8')
    expect(after).not.toContain('old-binary')
    // Exactly one managed block — replacement, not accumulation.
    expect(after.split('[mcp_servers.prjct]').length - 1).toBe(1)
  })

  it('is idempotent — second run reports unchanged', async () => {
    await ensureCodexMcpServer(fixture.configPath)
    const first = await fs.readFile(fixture.configPath, 'utf-8')
    const r = await ensureCodexMcpServer(fixture.configPath)
    expect(r.changed).toBe(false)
    expect(await fs.readFile(fixture.configPath, 'utf-8')).toBe(first)
  })

  it('preserves a user-managed [mcp_servers.prjct] entry while adding status_line', async () => {
    const user = '[mcp_servers.prjct]\ncommand = "my-custom-wrapper"\nargs = []\n'
    await fs.writeFile(fixture.configPath, user, 'utf-8')

    const r = await ensureCodexMcpServer(fixture.configPath)
    expect(r.changed).toBe(true)
    expect(r.skipped).toBe('user-managed')
    expect(r.statusLineChanged).toBe(true)
    const body = await fs.readFile(fixture.configPath, 'utf-8')
    expect(body).toContain('command = "my-custom-wrapper"')
    expect(body).toContain(
      'status_line = ["model-with-reasoning", "current-dir", "git-branch", "context-remaining", "five-hour-limit", "weekly-limit", "task-progress"]'
    )
  })

  it('does not override an existing Codex status_line', async () => {
    const user = '[tui]\nstatus_line = ["model"]\n'
    await fs.writeFile(fixture.configPath, user, 'utf-8')

    const r = await ensureCodexMcpServer(fixture.configPath)
    expect(r.changed).toBe(true)
    expect(r.statusLineChanged).toBe(false)
    const body = await fs.readFile(fixture.configPath, 'utf-8')
    expect(body).toContain('status_line = ["model"]')
    expect(body).not.toContain('five-hour-limit')
    expect(body).toContain('[mcp_servers.prjct]')
  })

  it('inserts status_line into an existing [tui] table', async () => {
    await fs.writeFile(fixture.configPath, '[tui]\nraw_output_mode = true\n', 'utf-8')

    const r = await ensureCodexMcpServer(fixture.configPath)
    expect(r.statusLineChanged).toBe(true)
    const body = await fs.readFile(fixture.configPath, 'utf-8')
    expect(body).toContain(
      '[tui]\nstatus_line = ["model-with-reasoning", "current-dir", "git-branch", "context-remaining", "five-hour-limit", "weekly-limit", "task-progress"]\nraw_output_mode = true'
    )
  })
})

describe('ensureCodexContext7Server', () => {
  it('creates config.toml with the context7 server when missing', async () => {
    const r = await ensureCodexContext7Server(fixture.configPath)
    expect(r.changed).toBe(true)
    const body = await fs.readFile(fixture.configPath, 'utf-8')
    expect(body).toContain('[mcp_servers.context7]')
    expect(body).toContain('# prjct:mcp:context7:start')
    expect(body).toContain('# prjct:mcp:context7:end')
    expect(await codexHasContext7Server(fixture.configPath)).toBe(true)
  })

  it('co-exists with the prjct MCP block (both managed independently)', async () => {
    await ensureCodexMcpServer(fixture.configPath)
    await ensureCodexContext7Server(fixture.configPath)
    const body = await fs.readFile(fixture.configPath, 'utf-8')
    expect(body).toContain('[mcp_servers.prjct]')
    expect(body).toContain('[mcp_servers.context7]')
    // Exactly one of each — no accumulation.
    expect(body.split('[mcp_servers.prjct]').length - 1).toBe(1)
    expect(body.split('[mcp_servers.context7]').length - 1).toBe(1)
  })

  it('is idempotent — second run reports unchanged', async () => {
    await ensureCodexContext7Server(fixture.configPath)
    const first = await fs.readFile(fixture.configPath, 'utf-8')
    const r = await ensureCodexContext7Server(fixture.configPath)
    expect(r.changed).toBe(false)
    expect(await fs.readFile(fixture.configPath, 'utf-8')).toBe(first)
  })

  it('preserves a user-managed [mcp_servers.context7] entry', async () => {
    const user = '[mcp_servers.context7]\ncommand = "my-context7"\nargs = []\n'
    await fs.writeFile(fixture.configPath, user, 'utf-8')
    const r = await ensureCodexContext7Server(fixture.configPath)
    expect(r.skipped).toBe('user-managed')
    const body = await fs.readFile(fixture.configPath, 'utf-8')
    expect(body).toContain('command = "my-context7"')
  })

  it('codexHasContext7Server is false for a missing file', async () => {
    expect(await codexHasContext7Server(path.join(fixture.dir, 'nope.toml'))).toBe(false)
  })
})

describe('buildContext7McpTomlBlock', () => {
  it('emits a context7 table with its own markers', () => {
    const block = buildContext7McpTomlBlock()
    expect(block).toContain('[mcp_servers.context7]')
    expect(block).toContain('# prjct:mcp:context7:start')
    expect(block).not.toContain('description')
  })
})

describe('buildCodexStatusLineToml', () => {
  it('builds the Codex TUI status_line table', () => {
    expect(buildCodexStatusLineToml()).toBe(
      '[tui]\nstatus_line = ["model-with-reasoning", "current-dir", "git-branch", "context-remaining", "five-hour-limit", "weekly-limit", "task-progress"]\n'
    )
  })
})

describe('buildPrjctMcpTomlBlock', () => {
  it('escapes TOML string values', () => {
    const block = buildPrjctMcpTomlBlock({
      command: 'C:\\node "x"',
      args: ['a"b'],
      description: 'ignored',
    })
    expect(block).toContain('command = "C:\\\\node \\"x\\""')
    expect(block).toContain('args = ["a\\"b"]')
    // description is a Claude mcp.json concept — Codex TOML must not get it.
    expect(block).not.toContain('description')
  })
})
