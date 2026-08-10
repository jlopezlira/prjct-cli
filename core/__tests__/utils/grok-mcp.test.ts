/**
 * Grok MCP wiring — `[mcp_servers.prjct]` in ~/.grok/config.toml.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureGrokMcpServer, grokHasPrjctMcpServer } from '../../utils/grok-mcp'

const fixture: {
  dir: string
  configPath: string
} = {
  dir: '',
  configPath: '',
}

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-grok-mcp-test-'))
  fixture.configPath = path.join(fixture.dir, 'config.toml')
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

describe('ensureGrokMcpServer', () => {
  it('creates config.toml with the prjct server when missing', async () => {
    const r = await ensureGrokMcpServer(fixture.configPath)
    expect(r.changed).toBe(true)
    const body = await fs.readFile(fixture.configPath, 'utf-8')
    expect(body).toContain('[mcp_servers.prjct]')
    expect(body).toContain('# prjct:mcp:start')
    expect(body).toContain('# prjct:mcp:end')
    expect(body).toMatch(/command = "/)
  })

  it('appends to an existing config without touching user content', async () => {
    const user = '[models]\ndefault = "grok-build"\n'
    await fs.writeFile(fixture.configPath, user, 'utf-8')

    const r = await ensureGrokMcpServer(fixture.configPath)
    expect(r.changed).toBe(true)
    const body = await fs.readFile(fixture.configPath, 'utf-8')
    expect(body).toContain('default = "grok-build"')
    expect(body.indexOf('[models]')).toBeLessThan(body.indexOf('[mcp_servers.prjct]'))
  })

  it('replaces a stale managed block in place', async () => {
    await ensureGrokMcpServer(fixture.configPath)
    const before = await fs.readFile(fixture.configPath, 'utf-8')
    const stale = before.replace(/command = "[^"]*"/, 'command = "old-binary"')
    await fs.writeFile(fixture.configPath, stale, 'utf-8')

    const r = await ensureGrokMcpServer(fixture.configPath)
    expect(r.changed).toBe(true)
    const after = await fs.readFile(fixture.configPath, 'utf-8')
    expect(after).not.toContain('old-binary')
    expect(after.split('[mcp_servers.prjct]').length - 1).toBe(1)
  })

  it('is idempotent — second run reports unchanged', async () => {
    await ensureGrokMcpServer(fixture.configPath)
    const first = await fs.readFile(fixture.configPath, 'utf-8')
    const r = await ensureGrokMcpServer(fixture.configPath)
    expect(r.changed).toBe(false)
    expect(await fs.readFile(fixture.configPath, 'utf-8')).toBe(first)
  })

  it('preserves a user-managed [mcp_servers.prjct] entry', async () => {
    const user = '[mcp_servers.prjct]\ncommand = "my-custom-wrapper"\nargs = []\n'
    await fs.writeFile(fixture.configPath, user, 'utf-8')

    const r = await ensureGrokMcpServer(fixture.configPath)
    expect(r.changed).toBe(false)
    expect(r.skipped).toBe('user-managed')
    const body = await fs.readFile(fixture.configPath, 'utf-8')
    expect(body).toContain('command = "my-custom-wrapper"')
    expect(body).not.toContain('# prjct:mcp:start')
  })

  it('grokHasPrjctMcpServer detects managed block', async () => {
    expect(await grokHasPrjctMcpServer(fixture.configPath)).toBe(false)
    await ensureGrokMcpServer(fixture.configPath)
    expect(await grokHasPrjctMcpServer(fixture.configPath)).toBe(true)
  })
})
