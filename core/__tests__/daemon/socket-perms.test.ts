/**
 * SEC-03: the daemon socket must be owner-only before the daemon serves.
 * `ensureOwnerOnlySocket` is the gate `startDaemon` refuses on: it forces
 * 0600, reports any mode that does not stick, and treats an unverifiable
 * endpoint as the worst case rather than as private.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureOwnerOnlySocket } from '../../daemon/daemon'

const fixture = { dir: '' }

beforeEach(async () => {
  fixture.dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'prjct-socket-perms-'))
})

afterEach(async () => {
  await fsp.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

describe('ensureOwnerOnlySocket', () => {
  it('forces a world-readable endpoint down to 0600 and reports null', () => {
    if (process.platform === 'win32') return
    const endpoint = path.join(fixture.dir, 'daemon.sock')
    fs.writeFileSync(endpoint, '')
    fs.chmodSync(endpoint, 0o644)
    expect(ensureOwnerOnlySocket(endpoint)).toBeNull()
    expect(fs.statSync(endpoint).mode & 0o777).toBe(0o600)
  })

  it('is a no-op when the peer already unlinked the endpoint', () => {
    expect(ensureOwnerOnlySocket(path.join(fixture.dir, 'gone.sock'))).toBeNull()
  })

  it('refuses a planted symlink at the endpoint, dangling or not', () => {
    if (process.platform === 'win32') return
    // `listen` never creates a symlink; one here was planted by someone
    // else, so the daemon must refuse rather than chmod through it.
    const dangling = path.join(fixture.dir, 'dangling.sock')
    fs.symlinkSync(path.join(fixture.dir, 'missing-target'), dangling)
    expect(ensureOwnerOnlySocket(dangling)).toBe(0o777)

    const target = path.join(fixture.dir, 'real.sock')
    fs.writeFileSync(target, '')
    const planted = path.join(fixture.dir, 'planted.sock')
    fs.symlinkSync(target, planted)
    expect(ensureOwnerOnlySocket(planted)).toBe(0o777)
  })
})
