/**
 * global-config tests — read/write to ~/.prjct-cli/config/global.json.
 *
 * Tests redirect to a temp dir via `PRJCT_CLI_HOME` so the user's real config
 * is never touched. This MUST use the env override, not a patched `process.env
 * .HOME`: Bun's `os.homedir()` ignores a mutated HOME, so the old HOME-patch
 * strategy silently read/wrote the real `~/.prjct-cli/config/global.json` — the
 * "malformed JSON" case below would otherwise corrupt it to `{invalid json`.
 * The path is resolved per call in the module, so a static import is fine.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as m from '../../services/global-config'

const fixture: {
  tempHome: string
  originalCliHome: string | undefined
} = {
  tempHome: '',
  originalCliHome: undefined as unknown as string | undefined,
}

beforeEach(async () => {
  fixture.tempHome = path.join(
    os.tmpdir(),
    `prjct-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await fs.mkdir(fixture.tempHome, { recursive: true })
  fixture.originalCliHome = process.env.PRJCT_CLI_HOME
  process.env.PRJCT_CLI_HOME = fixture.tempHome
})

afterEach(async () => {
  if (fixture.originalCliHome === undefined) delete process.env.PRJCT_CLI_HOME
  else process.env.PRJCT_CLI_HOME = fixture.originalCliHome
  if (fixture.tempHome) {
    await fs.rm(fixture.tempHome, { recursive: true, force: true }).catch(() => undefined)
    fixture.tempHome = ''
  }
})

async function freshImport(): Promise<typeof import('../../services/global-config')> {
  // The module resolves its path lazily from PRJCT_CLI_HOME on every call, so
  // no cache-busting is needed — return the statically imported module.
  return m
}

describe('global-config', () => {
  test('returns undefined for unset keys', async () => {
    const m = await freshImport()
    expect(m.getConfig('auto-update')).toBeUndefined()
  })

  test('setConfig + getConfig round-trip', async () => {
    const m = await freshImport()
    m.setConfig('auto-update', 'on')
    expect(m.getConfig('auto-update')).toBe('on')
  })

  test('persists across module re-imports (writes to disk)', async () => {
    const m1 = await freshImport()
    m1.setConfig('suggestions', 'off')

    const m2 = await freshImport()
    expect(m2.getConfig('suggestions')).toBe('off')
  })

  test('getAll returns the full bag', async () => {
    const m = await freshImport()
    m.setConfig('auto-update', 'on')
    m.setConfig('suggestions', 'off')

    const all = m.getAll()
    expect(all['auto-update']).toBe('on')
    expect(all.suggestions).toBe('off')
  })

  test('unsetConfig removes a key', async () => {
    const m = await freshImport()
    m.setConfig('auto-update', 'on')
    m.unsetConfig('auto-update')
    expect(m.getConfig('auto-update')).toBeUndefined()
  })

  test('stores vault-root preference for setup-owned vault location', async () => {
    const m = await freshImport()
    m.setConfig('vault-root', '/tmp/prjct-readable-vault')
    expect(m.getConfig('vault-root')).toBe('/tmp/prjct-readable-vault')
  })

  test('preserves unknown keys on round-trip (forward compat)', async () => {
    const m = await freshImport()
    // Write an unknown key directly so we can verify reads preserve it
    // even when we don't touch it
    m.setConfig('future-feature' as never, 'enabled' as never)
    m.setConfig('auto-update', 'on')

    const all = m.getAll()
    expect(all['future-feature']).toBe('enabled')
    expect(all['auto-update']).toBe('on')
  })

  test('handles missing config dir (creates on first write)', async () => {
    const m = await freshImport()
    // Config dir does not exist yet — setConfig must create it
    m.setConfig('auto-update', 'on')
    const cfgPath = m.configPath()
    const stat = await fs.stat(cfgPath)
    expect(stat.isFile()).toBe(true)
  })

  test('returns empty bag on malformed JSON', async () => {
    const m = await freshImport()
    // Corrupt the file
    await fs.mkdir(path.dirname(m.configPath()), { recursive: true })
    await fs.writeFile(m.configPath(), '{invalid json', 'utf-8')

    const all = m.getAll()
    expect(Object.keys(all).length).toBe(0)
  })
})
