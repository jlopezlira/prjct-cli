import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  decideListenFailure,
  releaseSpawnLock,
  spawnLockPath,
  tryAcquireSpawnLock,
} from '../../daemon/startup-lock'

describe('decideListenFailure', () => {
  test('lost race with healthy peer exits 0', () => {
    expect(
      decideListenFailure({
        errorCode: 'EADDRINUSE',
        errorMessage: 'listen EADDRINUSE',
        peerHealthy: true,
      })
    ).toEqual({ exitCode: 0, reason: 'lost-spawn-race-peer-healthy' })
  })

  test('listen fail without peer is fatal', () => {
    const d = decideListenFailure({
      errorCode: 'EADDRINUSE',
      errorMessage: 'Failed to listen at /tmp/daemon.sock',
      peerHealthy: false,
    })
    expect(d.exitCode).toBe(1)
    expect(d.reason).toBe('listen-failed-no-peer')
  })

  test('other errors are fatal', () => {
    expect(
      decideListenFailure({
        errorMessage: 'permission denied',
        peerHealthy: true,
      }).exitCode
    ).toBe(1)
  })
})

describe('tryAcquireSpawnLock', () => {
  const fixture: {
    tmp: string
  } = {
    tmp: '',
  }

  afterEach(() => {
    if (fixture.tmp && fs.existsSync(fixture.tmp)) {
      try {
        fs.rmSync(fixture.tmp, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  test('first acquirer wins; second yields while holder is live', () => {
    fixture.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-spawn-lock-'))
    const a = tryAcquireSpawnLock(fixture.tmp, process.pid)
    expect(a).not.toBeNull()
    expect(fs.existsSync(spawnLockPath(fixture.tmp))).toBe(true)

    const b = tryAcquireSpawnLock(fixture.tmp, process.pid + 99999)
    expect(b).toBeNull()

    releaseSpawnLock(a)
    const c = tryAcquireSpawnLock(fixture.tmp, process.pid)
    expect(c).not.toBeNull()
    releaseSpawnLock(c)
  })

  test('stale lock from dead pid is reclaimed', () => {
    fixture.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-spawn-lock-'))
    const lockPath = spawnLockPath(fixture.tmp)
    fs.mkdirSync(fixture.tmp, { recursive: true })
    // PID 1 on macOS is launchd and is always "running" — use an absurd pid.
    const deadPid = 2_147_483_646
    fs.writeFileSync(lockPath, `${deadPid}\n`)

    const handle = tryAcquireSpawnLock(fixture.tmp, process.pid)
    expect(handle).not.toBeNull()
    releaseSpawnLock(handle)
  })
})
