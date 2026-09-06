/**
 * SEC-03: daemon requests carry a per-daemon token issued into the
 * owner-only run dir. Without it (or with the wrong one) the daemon must
 * answer retry+unauthenticated — nothing executed — and clients run the
 * command directly. The liveness ping stays open.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  issueDaemonToken,
  readDaemonToken,
  removeDaemonToken,
  requestAuthorized,
  unauthenticatedResponse,
} from '../../daemon/auth'

const fixture = { dir: '', tokenPath: '' }

beforeEach(async () => {
  fixture.dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'prjct-daemon-auth-'))
  fixture.tokenPath = path.join(fixture.dir, 'run', 'daemon.token')
})

afterEach(async () => {
  await fsp.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

describe('issueDaemonToken / readDaemonToken', () => {
  it('publishes a 64-hex token owner-only, atomically, and reads it back', () => {
    const token = issueDaemonToken(fixture.tokenPath)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(readDaemonToken(fixture.tokenPath)).toBe(token)
    if (process.platform !== 'win32') {
      expect(fs.statSync(fixture.tokenPath).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(fixture.tokenPath)).mode & 0o077).toBe(0)
    }
    // No temp file left behind from the atomic publish.
    expect(fs.readdirSync(path.dirname(fixture.tokenPath))).toEqual(['daemon.token'])
  })

  it('rotates on re-issue and revokes on remove', () => {
    const first = issueDaemonToken(fixture.tokenPath)
    const second = issueDaemonToken(fixture.tokenPath)
    expect(second).not.toBe(first)
    expect(readDaemonToken(fixture.tokenPath)).toBe(second)
    removeDaemonToken(fixture.tokenPath)
    expect(readDaemonToken(fixture.tokenPath)).toBeNull()
    expect(() => removeDaemonToken(fixture.tokenPath)).not.toThrow()
  })

  it('treats a missing or malformed token file as no token', () => {
    expect(readDaemonToken(fixture.tokenPath)).toBeNull()
    fs.mkdirSync(path.dirname(fixture.tokenPath), { recursive: true })
    fs.writeFileSync(fixture.tokenPath, 'not-a-token\n')
    expect(readDaemonToken(fixture.tokenPath)).toBeNull()
    fs.writeFileSync(fixture.tokenPath, `${'a'.repeat(63)}\n`)
    expect(readDaemonToken(fixture.tokenPath)).toBeNull()
  })
})

describe('requestAuthorized', () => {
  const issued = 'f'.repeat(64)

  it('accepts only the exact issued token', () => {
    expect(requestAuthorized({ command: 'search', auth: issued }, issued)).toBe(true)
    expect(requestAuthorized({ command: 'search', auth: `${'f'.repeat(63)}e` }, issued)).toBe(false)
    expect(requestAuthorized({ command: 'search', auth: issued.slice(0, 63) }, issued)).toBe(false)
    expect(requestAuthorized({ command: 'search' }, issued)).toBe(false)
    expect(requestAuthorized({ command: 'search', auth: 42 }, issued)).toBe(false)
  })

  it('refuses everything while no token is issued, except the liveness ping', () => {
    expect(requestAuthorized({ command: 'search', auth: issued }, null)).toBe(false)
    expect(requestAuthorized({ command: 'hook', auth: issued }, null)).toBe(false)
    expect(requestAuthorized({ command: '__ping' }, null)).toBe(true)
    expect(requestAuthorized({ command: '__ping' }, issued)).toBe(true)
  })

  it('answers with the retry shape every client already falls through on', () => {
    const response = unauthenticatedResponse('op-1')
    expect(response).toMatchObject({
      id: 'op-1',
      success: false,
      exitCode: 1,
      retry: true,
      unauthenticated: true,
    })
    expect(response.stderr).toMatch(/no valid token/)
  })
})
