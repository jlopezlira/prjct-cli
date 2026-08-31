/**
 * Kimi TUI wiring — `[status_line].command` in ~/.kimi-code/tui.toml.
 *
 * Pins the contract:
 *   1. No tui.toml → created with our `[status_line]` block pointing at the
 *      shared prjct statusline script.
 *   2. Existing user config without an active section → block appended, user
 *      content byte-preserved (Kimi's commented `# [status_line]` template
 *      does not count as active).
 *   3. Active `[status_line]` — the user's or ours — → preserved untouched,
 *      idempotent re-runs report unchanged.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildKimiStatusLineToml, ensureKimiStatusLine } from '../../utils/kimi-tui'

const fixture: {
  dir: string
  configPath: string
} = {
  dir: '',
  configPath: '',
}

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-kimi-tui-test-'))
  fixture.configPath = path.join(fixture.dir, 'tui.toml')
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

describe('ensureKimiStatusLine', () => {
  it('creates tui.toml with the prjct statusline command when missing', async () => {
    const r = await ensureKimiStatusLine(fixture.configPath)
    expect(r.changed).toBe(true)
    const body = await fs.readFile(fixture.configPath, 'utf-8')
    expect(body).toContain('[status_line]')
    expect(body).toMatch(/command = ".*statusline\/statusline\.sh"/)
  })

  it('appends to an existing config without touching user content', async () => {
    const user = 'theme = "auto"\n\n[notifications]\nenabled = true\n'
    await fs.writeFile(fixture.configPath, user, 'utf-8')

    const r = await ensureKimiStatusLine(fixture.configPath)
    expect(r.changed).toBe(true)
    const body = await fs.readFile(fixture.configPath, 'utf-8')
    expect(body).toContain('theme = "auto"')
    expect(body.indexOf('[notifications]')).toBeLessThan(body.indexOf('[status_line]'))
  })

  it("treats Kimi's commented-out template as absent", async () => {
    const user = [
      'theme = "auto"',
      '',
      '# [status_line]',
      '# items = ["mode","goal","model"]',
      '# command = "~/.kimi-code/statusline.sh"',
      '',
    ].join('\n')
    await fs.writeFile(fixture.configPath, user, 'utf-8')

    const r = await ensureKimiStatusLine(fixture.configPath)
    expect(r.changed).toBe(true)
    const body = await fs.readFile(fixture.configPath, 'utf-8')
    expect(body).toContain('# [status_line]')
    expect(body).toMatch(/^\[status_line\]$/m)
  })

  it('preserves an active user [status_line] section', async () => {
    const user = '[status_line]\nitems = ["mode", "model"]\n'
    await fs.writeFile(fixture.configPath, user, 'utf-8')

    const r = await ensureKimiStatusLine(fixture.configPath)
    expect(r.changed).toBe(false)
    expect(await fs.readFile(fixture.configPath, 'utf-8')).toBe(user)
  })

  it('is idempotent — second run reports unchanged', async () => {
    await ensureKimiStatusLine(fixture.configPath)
    const first = await fs.readFile(fixture.configPath, 'utf-8')
    const r = await ensureKimiStatusLine(fixture.configPath)
    expect(r.changed).toBe(false)
    expect(await fs.readFile(fixture.configPath, 'utf-8')).toBe(first)
  })

  it('escapes backslashes and quotes in the command path', () => {
    const toml = buildKimiStatusLineToml('C:\\Users\\x\\st"line.sh')
    expect(toml).toContain('command = "C:\\\\Users\\\\x\\\\st\\"line.sh"')
  })
})
