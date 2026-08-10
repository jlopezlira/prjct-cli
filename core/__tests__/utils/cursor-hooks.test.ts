/**
 * Cursor hooks installer — camelCase events, flat handlers, version: 1
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  cursorHookMaps,
  cursorHooksStatus,
  installCursorHooks,
  uninstallCursorHooks,
} from '../../utils/cursor-hooks'

const fixture: {
  dir: string
  hooksPath: string
} = {
  dir: '',
  hooksPath: '',
}

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-cursor-hooks-'))
  fixture.hooksPath = path.join(fixture.dir, 'hooks.json')
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

describe('cursorHookMaps', () => {
  it('uses camelCase Cursor event names', () => {
    const events = new Set(cursorHookMaps().map((m) => m.cursorEvent))
    expect(events.has('sessionStart')).toBe(true)
    expect(events.has('preToolUse')).toBe(true)
    expect(events.has('postToolUse')).toBe(true)
    expect(events.has('stop')).toBe(true)
    expect(events.has('beforeSubmitPrompt')).toBe(true)
    expect(events.has('SessionStart')).toBe(false)
    expect(events.has('PreToolUse')).toBe(false)
  })

  it('maps edit tools to Write|StrReplace|Edit', () => {
    expect(cursorHookMaps().some((m) => m.matcher === 'Write|StrReplace|Edit')).toBe(true)
    expect(cursorHookMaps().some((m) => m.matcher === 'Shell|Bash')).toBe(true)
  })
})

describe('installCursorHooks', () => {
  it('writes version 1 flat handlers with PRJCT_HOOK_HOST=cursor', async () => {
    const r = await installCursorHooks(fixture.hooksPath)
    expect(r.hooksWritten).toBeGreaterThan(0)
    const body = JSON.parse(await fs.readFile(fixture.hooksPath, 'utf-8')) as {
      version: number
      hooks: Record<string, Array<Record<string, unknown>>>
    }
    expect(body.version).toBe(1)
    expect(body.hooks.sessionStart).toBeDefined()
    expect(body.hooks.preToolUse).toBeDefined()
    // Flat list — not Claude nested { matcher, hooks: [] }
    expect(Array.isArray(body.hooks.sessionStart)).toBe(true)
    expect(body.hooks.sessionStart[0]?.command).toContain('PRJCT_HOOK_HOST=cursor')
    expect(body.hooks.sessionStart[0]?.command).toContain('prjct hook session-start')
    expect(body.hooks.sessionStart[0]?._prjctManaged).toBe(true)
    expect(body.hooks.sessionStart[0]?.timeout).toBe(30)
  })

  it('is idempotent', async () => {
    await installCursorHooks(fixture.hooksPath)
    const r2 = await installCursorHooks(fixture.hooksPath)
    expect(r2.hooksWritten).toBe(0)
    expect(r2.alreadyPresent).toBe(cursorHookMaps().length)
  })

  it('preserves foreign handlers', async () => {
    await fs.writeFile(
      fixture.hooksPath,
      JSON.stringify({
        version: 1,
        hooks: {
          stop: [{ command: 'echo foreign-stop' }],
        },
      }),
      'utf-8'
    )
    await installCursorHooks(fixture.hooksPath)
    const body = JSON.parse(await fs.readFile(fixture.hooksPath, 'utf-8')) as {
      hooks: Record<string, Array<{ command: string }>>
    }
    const cmds = body.hooks.stop.map((h) => h.command)
    expect(cmds.some((c) => c.includes('foreign-stop'))).toBe(true)
    expect(cmds.some((c) => c.includes('prjct hook stop'))).toBe(true)
  })
})

describe('uninstallCursorHooks', () => {
  it('removes only prjct handlers', async () => {
    await installCursorHooks(fixture.hooksPath)
    const body = JSON.parse(await fs.readFile(fixture.hooksPath, 'utf-8')) as {
      hooks: Record<string, Array<Record<string, unknown>>>
    }
    body.hooks.stop.push({ command: 'echo keep' })
    await fs.writeFile(fixture.hooksPath, JSON.stringify(body, null, 2), 'utf-8')

    const r = await uninstallCursorHooks(fixture.hooksPath)
    expect(r.hooksRemoved).toBeGreaterThan(0)
    const after = JSON.parse(await fs.readFile(fixture.hooksPath, 'utf-8')) as {
      hooks: Record<string, Array<{ command: string }>>
    }
    const all = Object.values(after.hooks ?? {}).flatMap((list) => list.map((h) => h.command))
    expect(all.some((c) => c.includes('keep'))).toBe(true)
    expect(all.every((c) => !c.includes('prjct hook'))).toBe(true)
  })
})

describe('cursorHooksStatus', () => {
  it('counts managed handlers', async () => {
    expect((await cursorHooksStatus(fixture.hooksPath)).installed).toBe(0)
    await installCursorHooks(fixture.hooksPath)
    const st = await cursorHooksStatus(fixture.hooksPath)
    expect(st.installed).toBe(st.expected)
  })
})
