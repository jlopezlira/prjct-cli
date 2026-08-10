/**
 * Kimi MCP wiring — `mcpServers` JSON in ~/.kimi/mcp.json.
 *
 * Pins the contract:
 *   1. No mcp.json → created with prjct + context7 servers.
 *   2. Existing user servers → preserved; prjct/context7 upserted alongside.
 *   3. Re-run with no change → reports changed: false (idempotent).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureKimiMcpServer } from '../../utils/kimi-mcp'

interface KimiMcpJson {
  mcpServers?: Record<string, { command?: string; args?: string[] }>
}

const fixture: {
  dir: string
  configPath: string
} = {
  dir: '',
  configPath: '',
}

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-kimi-mcp-test-'))
  fixture.configPath = path.join(fixture.dir, 'mcp.json')
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

describe('ensureKimiMcpServer', () => {
  it('creates mcp.json with prjct and context7 servers when missing', async () => {
    const r = await ensureKimiMcpServer(fixture.configPath)
    expect(r.changed).toBe(true)

    const config = JSON.parse(await fs.readFile(fixture.configPath, 'utf-8')) as KimiMcpJson
    expect(config.mcpServers?.prjct?.command).toBeTruthy()
    expect(config.mcpServers?.prjct?.args).toContain('mcp-server')
    expect(config.mcpServers?.context7?.command).toBe('npx')
    expect(config.mcpServers?.context7?.args).toContain('@upstash/context7-mcp@latest')
  })

  it('preserves user-defined servers while upserting prjct', async () => {
    await fs.writeFile(
      fixture.configPath,
      `${JSON.stringify({ mcpServers: { mine: { command: 'foo', args: ['bar'] } } }, null, 2)}\n`,
      'utf-8'
    )

    const r = await ensureKimiMcpServer(fixture.configPath)
    expect(r.changed).toBe(true)

    const config = JSON.parse(await fs.readFile(fixture.configPath, 'utf-8')) as KimiMcpJson
    expect(config.mcpServers?.mine?.command).toBe('foo')
    expect(config.mcpServers?.prjct?.command).toBeTruthy()
  })

  it('is idempotent on re-run', async () => {
    await ensureKimiMcpServer(fixture.configPath)
    const second = await ensureKimiMcpServer(fixture.configPath)
    expect(second.changed).toBe(false)
  })
})
