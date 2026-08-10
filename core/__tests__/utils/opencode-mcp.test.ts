/**
 * OpenCode MCP wiring — mcp.prjct local entry in opencode.json / JSONC.
 *
 * Pins:
 *   1. Missing config → creates with $schema + mcp.prjct
 *   2. Existing user mcp servers preserved
 *   3. JSONC comments preserved on modify
 *   4. Idempotent re-run
 *   5. Shape: type local + command array including mcp-server
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ensureOpenCodeMcpServer,
  hasOpenCodePrjctMcp,
  toOpenCodeLocalMcp,
} from '../../utils/opencode-mcp'

const fixture: {
  dir: string
  configPath: string
} = {
  dir: '',
  configPath: '',
}

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-opencode-mcp-test-'))
  fixture.configPath = path.join(fixture.dir, 'opencode.json')
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

describe('toOpenCodeLocalMcp', () => {
  it('maps command+args into a local command array', () => {
    const entry = toOpenCodeLocalMcp({
      command: 'npx',
      args: ['-y', 'prjct-cli@latest', 'mcp-server'],
      env: { PATH: '/usr/bin' },
    })
    expect(entry.type).toBe('local')
    expect(entry.enabled).toBe(true)
    expect(entry.command).toEqual(['npx', '-y', 'prjct-cli@latest', 'mcp-server'])
    expect(entry.environment?.PATH).toBe('/usr/bin')
  })
})

describe('ensureOpenCodeMcpServer', () => {
  it('creates opencode.json with mcp.prjct when missing', async () => {
    const r = await ensureOpenCodeMcpServer(fixture.configPath)
    expect(r.changed).toBe(true)
    expect(r.path).toBe(fixture.configPath)

    const raw = await fs.readFile(fixture.configPath, 'utf-8')
    expect(hasOpenCodePrjctMcp(raw)).toBe(true)
    const config = JSON.parse(raw) as {
      $schema?: string
      mcp?: { prjct?: { type?: string; command?: string[]; enabled?: boolean } }
    }
    expect(config.$schema).toContain('opencode.ai')
    expect(config.mcp?.prjct?.type).toBe('local')
    expect(config.mcp?.prjct?.enabled).toBe(true)
    expect(
      config.mcp?.prjct?.command?.some((c) => c.includes('mcp-server') || c.includes('prjct'))
    ).toBe(true)
  })

  it('preserves user-defined MCP servers while upserting prjct', async () => {
    await fs.writeFile(
      fixture.configPath,
      `${JSON.stringify(
        {
          mcp: {
            mine: { type: 'local', command: ['echo', 'hi'], enabled: true },
          },
        },
        null,
        2
      )}\n`,
      'utf-8'
    )

    const r = await ensureOpenCodeMcpServer(fixture.configPath)
    expect(r.changed).toBe(true)

    const config = JSON.parse(await fs.readFile(fixture.configPath, 'utf-8')) as {
      mcp: Record<string, { command?: string[] }>
    }
    expect(config.mcp.mine?.command).toEqual(['echo', 'hi'])
    expect(config.mcp.prjct?.command).toBeTruthy()
  })

  it('preserves JSONC comments when modifying', async () => {
    const jsoncPath = path.join(fixture.dir, 'opencode.jsonc')
    await fs.writeFile(
      jsoncPath,
      `{
  // user theme note
  "theme": "opencode",
  "mcp": {
    "other": { "type": "local", "command": ["true"], "enabled": true }
  }
}
`,
      'utf-8'
    )

    const r = await ensureOpenCodeMcpServer(jsoncPath)
    expect(r.changed).toBe(true)
    const raw = await fs.readFile(jsoncPath, 'utf-8')
    expect(raw).toContain('// user theme note')
    expect(hasOpenCodePrjctMcp(raw)).toBe(true)
    expect(raw).toContain('"other"')
  })

  it('is idempotent on re-run', async () => {
    await ensureOpenCodeMcpServer(fixture.configPath)
    const second = await ensureOpenCodeMcpServer(fixture.configPath)
    expect(second.changed).toBe(false)
  })
})
