/**
 * Kimi Code CLI MCP wiring — `mcpServers` JSON in ~/.kimi-code/mcp.json
 * (legacy ~/.kimi/mcp.json as fallback).
 *
 * Pins the contract:
 *   1. No mcp.json → created with prjct + context7 servers.
 *   2. Existing user servers → preserved; prjct/context7 upserted alongside.
 *   3. Re-run with no change → reports changed: false (idempotent).
 *   4. Path resolution prefers ~/.kimi-code, falls back to legacy ~/.kimi
 *      only when it is the sole Kimi home present.
 *   5. Uninstall strips prjct-managed servers from both locations without
 *      touching user-defined servers (including a user-owned context7).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ensureKimiMcpServer,
  getKimiMcpConfigPath,
  uninstallKimiMcpServer,
} from '../../utils/kimi-mcp'
import { MCP_SERVER_PRESETS } from '../../utils/mcp-config'

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

describe('getKimiMcpConfigPath', () => {
  const env: { home?: string; testMode?: string } = {}

  beforeEach(() => {
    env.home = process.env.HOME
    env.testMode = process.env.PRJCT_TEST_MODE
    process.env.HOME = fixture.dir
    delete process.env.PRJCT_TEST_MODE
  })

  afterEach(() => {
    if (env.home === undefined) delete process.env.HOME
    else process.env.HOME = env.home
    if (env.testMode === undefined) delete process.env.PRJCT_TEST_MODE
    else process.env.PRJCT_TEST_MODE = env.testMode
  })

  it('prefers ~/.kimi-code when it exists alongside legacy ~/.kimi', async () => {
    await fs.mkdir(path.join(fixture.dir, '.kimi-code'), { recursive: true })
    await fs.mkdir(path.join(fixture.dir, '.kimi'), { recursive: true })

    expect(getKimiMcpConfigPath()).toBe(path.join(fixture.dir, '.kimi-code', 'mcp.json'))
  })

  it('defaults to ~/.kimi-code when neither home exists (fresh install)', () => {
    expect(getKimiMcpConfigPath()).toBe(path.join(fixture.dir, '.kimi-code', 'mcp.json'))
  })

  it('falls back to legacy ~/.kimi when it is the only Kimi home', async () => {
    await fs.mkdir(path.join(fixture.dir, '.kimi'), { recursive: true })

    expect(getKimiMcpConfigPath()).toBe(path.join(fixture.dir, '.kimi', 'mcp.json'))
  })
})

describe('uninstallKimiMcpServer', () => {
  const env: { home?: string; testMode?: string } = {}

  beforeEach(() => {
    env.home = process.env.HOME
    env.testMode = process.env.PRJCT_TEST_MODE
    process.env.HOME = fixture.dir
    delete process.env.PRJCT_TEST_MODE
  })

  afterEach(() => {
    if (env.home === undefined) delete process.env.HOME
    else process.env.HOME = env.home
    if (env.testMode === undefined) delete process.env.PRJCT_TEST_MODE
    else process.env.PRJCT_TEST_MODE = env.testMode
  })

  it('strips prjct-managed servers from both homes, preserving user servers', async () => {
    const kimiCodePath = path.join(fixture.dir, '.kimi-code', 'mcp.json')
    const legacyPath = path.join(fixture.dir, '.kimi', 'mcp.json')
    await ensureKimiMcpServer(kimiCodePath)
    await ensureKimiMcpServer(legacyPath)

    // User entries that must survive: a custom server in .kimi-code and a
    // user-owned context7 (different command) in legacy .kimi.
    const withUserEntries = async (configPath: string, userServers: KimiMcpJson['mcpServers']) => {
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8')) as KimiMcpJson
      config.mcpServers = { ...config.mcpServers, ...userServers }
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
    }
    await withUserEntries(kimiCodePath, { mine: { command: 'foo', args: ['bar'] } })
    await withUserEntries(legacyPath, { context7: { command: 'custom-context7', args: [] } })

    const r = await uninstallKimiMcpServer()
    // prjct + preset context7 from .kimi-code, prjct from legacy .kimi.
    expect(r.serversRemoved).toBe(3)
    expect(r.paths).toContain(kimiCodePath)
    expect(r.paths).toContain(legacyPath)

    const kimiCode = JSON.parse(await fs.readFile(kimiCodePath, 'utf-8')) as KimiMcpJson
    expect(kimiCode.mcpServers?.prjct).toBeUndefined()
    expect(kimiCode.mcpServers?.context7).toBeUndefined()
    expect(kimiCode.mcpServers?.mine?.command).toBe('foo')

    const legacy = JSON.parse(await fs.readFile(legacyPath, 'utf-8')) as KimiMcpJson
    expect(legacy.mcpServers?.prjct).toBeUndefined()
    expect(legacy.mcpServers?.context7?.command).toBe('custom-context7')
  })

  it('is a no-op when nothing is installed', async () => {
    const r = await uninstallKimiMcpServer()
    expect(r.serversRemoved).toBe(0)
    expect(r.paths).toEqual([])
  })

  it('matches the context7 preset exactly before removing it', async () => {
    const configPath = path.join(fixture.dir, '.kimi-code', 'mcp.json')
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ mcpServers: { context7: MCP_SERVER_PRESETS.context7 } }, null, 2)}\n`,
      'utf-8'
    )

    const r = await uninstallKimiMcpServer()
    expect(r.serversRemoved).toBe(1)
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8')) as KimiMcpJson
    expect(config.mcpServers?.context7).toBeUndefined()
  })
})
