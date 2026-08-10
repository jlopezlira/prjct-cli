/**
 * Update-checker unit tests.
 *
 * Covers the daemon-owned "is a newer prjct published?" logic:
 *   - writes the global flag with updateAvailable computed from installed vs latest
 *   - reuses the cached `latest` within the throttle window (no refetch)
 *   - recomputes updateAvailable against the CURRENT installed version, so the
 *     flag clears the instant the CLI is upgraded — even on a cached `latest`
 *   - tolerates an offline registry (no flag flip, no throw)
 *
 * The npm fetch is stubbed via global.fetch; the CLI home is redirected to a
 * temp dir through PRJCT_CLI_HOME so nothing touches the real state file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readUpdateStatus, refreshUpdateStatus } from '../../services/update-checker'

const fixture: {
  tmpHome: string
  prevHome: string | undefined
} = {
  tmpHome: '',
  prevHome: undefined as unknown as string | undefined,
}

const realFetch = globalThis.fetch

function stubFetch(version: string | null): void {
  globalThis.fetch = (async () => {
    if (version === null) throw new Error('offline')
    return new Response(JSON.stringify({ version }), { status: 200 })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  fixture.tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-update-'))
  fixture.prevHome = process.env.PRJCT_CLI_HOME
  process.env.PRJCT_CLI_HOME = fixture.tmpHome
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (fixture.prevHome === undefined) delete process.env.PRJCT_CLI_HOME
  else process.env.PRJCT_CLI_HOME = fixture.prevHome
  fs.rmSync(fixture.tmpHome, { recursive: true, force: true })
})

describe('update-checker — refreshUpdateStatus', () => {
  test('flags an upgrade when latest is newer than installed', async () => {
    stubFetch('3.13.0')
    const status = await refreshUpdateStatus('3.12.0')
    expect(status?.updateAvailable).toBe(true)
    expect(status?.latest).toBe('3.13.0')
    expect(readUpdateStatus()?.updateAvailable).toBe(true)
  })

  test('no upgrade when already on the latest', async () => {
    stubFetch('3.12.0')
    const status = await refreshUpdateStatus('3.12.0')
    expect(status?.updateAvailable).toBe(false)
  })

  test('clears the flag after upgrade using cached latest (no refetch)', async () => {
    stubFetch('3.13.0')
    await refreshUpdateStatus('3.12.0') // upgrade available

    // Simulate the CLI having been upgraded; registry is now unreachable so any
    // refetch would fail. The cached `latest` (3.13.0) must be reused and the
    // flag recomputed against the new installed version → no longer available.
    stubFetch(null)
    const status = await refreshUpdateStatus('3.13.0')
    expect(status?.latest).toBe('3.13.0')
    expect(status?.updateAvailable).toBe(false)
  })

  test('offline first run produces no false upgrade signal', async () => {
    stubFetch(null)
    const status = await refreshUpdateStatus('3.12.0')
    expect(status?.latest).toBeNull()
    expect(status?.updateAvailable).toBe(false)
  })

  test('empty installed version is a no-op', async () => {
    stubFetch('3.13.0')
    const status = await refreshUpdateStatus('')
    expect(status).toBeNull()
    expect(readUpdateStatus()).toBeNull()
  })
})
