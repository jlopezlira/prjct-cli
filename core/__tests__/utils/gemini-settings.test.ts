/**
 * Gemini settings installer — MCP + hooks in ~/.gemini/settings.json
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ensureGeminiMcpServer,
  geminiHookMaps,
  installGeminiHooks,
  installGeminiSettings,
  uninstallGeminiSettings,
} from '../../utils/gemini-settings'

const fixture: {
  dir: string
  settingsPath: string
} = {
  dir: '',
  settingsPath: '',
}

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-gemini-settings-'))
  fixture.settingsPath = path.join(fixture.dir, 'settings.json')
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

describe('geminiHookMaps', () => {
  it('maps Claude events to Gemini BeforeTool/BeforeAgent/AfterAgent', () => {
    const maps = geminiHookMaps()
    const events = new Set(maps.map((m) => m.geminiEvent))
    expect(events.has('SessionStart')).toBe(true)
    expect(events.has('BeforeAgent')).toBe(true)
    expect(events.has('BeforeTool')).toBe(true)
    expect(events.has('AfterTool')).toBe(true)
    expect(events.has('AfterAgent')).toBe(true)
    expect(events.has('PreToolUse')).toBe(false)
    expect(maps.some((m) => m.matcher === 'run_shell_command')).toBe(true)
    expect(maps.some((m) => m.matcher === 'write_file|replace')).toBe(true)
  })
})

describe('ensureGeminiMcpServer', () => {
  it('writes mcpServers.prjct', async () => {
    const r = await ensureGeminiMcpServer(fixture.settingsPath)
    expect(r.changed).toBe(true)
    const body = JSON.parse(await fs.readFile(fixture.settingsPath, 'utf-8')) as {
      mcpServers: Record<string, { command?: string; args?: string[] }>
    }
    expect(body.mcpServers.prjct).toBeDefined()
    expect(body.mcpServers.prjct.args).toContain('mcp-server')
  })

  it('preserves other MCP servers', async () => {
    await fs.writeFile(
      fixture.settingsPath,
      JSON.stringify({
        mcpServers: {
          other: { command: 'echo', args: ['hi'] },
        },
      }),
      'utf-8'
    )
    await ensureGeminiMcpServer(fixture.settingsPath)
    const body = JSON.parse(await fs.readFile(fixture.settingsPath, 'utf-8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(body.mcpServers.other).toBeDefined()
    expect(body.mcpServers.prjct).toBeDefined()
  })
})

describe('installGeminiHooks', () => {
  it('installs managed hooks with PRJCT_HOOK_HOST=gemini', async () => {
    const r = await installGeminiHooks(fixture.settingsPath)
    expect(r.hooksWritten).toBeGreaterThan(0)
    const body = JSON.parse(await fs.readFile(fixture.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>
    }
    expect(body.hooks.SessionStart).toBeDefined()
    expect(body.hooks.BeforeAgent).toBeDefined()
    expect(body.hooks.BeforeTool).toBeDefined()
    const session = body.hooks.SessionStart.flatMap((b) => b.hooks)
    expect(session[0]?.command).toContain('PRJCT_HOOK_HOST=gemini')
    expect(session[0]?.command).toContain('prjct hook session-start')
    expect(session[0]?.timeout).toBe(30_000)
    expect(session[0]?._prjctManaged).toBe(true)
  })

  it('is idempotent', async () => {
    await installGeminiHooks(fixture.settingsPath)
    const r2 = await installGeminiHooks(fixture.settingsPath)
    expect(r2.hooksWritten).toBe(0)
    expect(r2.alreadyPresent).toBe(geminiHookMaps().length)
  })
})

describe('installGeminiSettings + uninstall', () => {
  it('installs both MCP and hooks; uninstall removes only prjct', async () => {
    await fs.writeFile(
      fixture.settingsPath,
      JSON.stringify({
        mcpServers: { keep: { command: 'true' } },
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo foreign', name: 'foreign' }] },
          ],
        },
      }),
      'utf-8'
    )
    const inst = await installGeminiSettings(fixture.settingsPath)
    expect(inst.mcpChanged).toBe(true)
    expect(inst.hooksWritten).toBeGreaterThan(0)

    const un = await uninstallGeminiSettings(fixture.settingsPath)
    expect(un.hooksRemoved).toBeGreaterThan(0)
    expect(un.mcpRemoved).toBe(true)

    const body = JSON.parse(await fs.readFile(fixture.settingsPath, 'utf-8')) as {
      mcpServers?: Record<string, unknown>
      hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(body.mcpServers?.keep).toBeDefined()
    expect(body.mcpServers?.prjct).toBeUndefined()
    const cmds = Object.values(body.hooks ?? {}).flatMap((blocks) =>
      blocks.flatMap((b) => b.hooks.map((h) => h.command))
    )
    expect(cmds.some((c) => c.includes('foreign'))).toBe(true)
    expect(cmds.every((c) => !c.includes('prjct hook'))).toBe(true)
  })
})
