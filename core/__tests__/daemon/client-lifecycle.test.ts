import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { forceKillDaemon, shouldUnlinkDaemonSocket } from '../../daemon/client'
import { DAEMON_PATHS } from '../../daemon/protocol'

describe('daemon client lifecycle safety', () => {
  let cliHome: string
  let previousCliHome: string | undefined

  beforeEach(() => {
    previousCliHome = process.env.PRJCT_CLI_HOME
    cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-daemon-client-'))
    process.env.PRJCT_CLI_HOME = cliHome
    fs.mkdirSync(DAEMON_PATHS.runDir(), { recursive: true })
  })

  afterEach(() => {
    if (previousCliHome === undefined) delete process.env.PRJCT_CLI_HOME
    else process.env.PRJCT_CLI_HOME = previousCliHome
    fs.rmSync(cliHome, { recursive: true, force: true })
  })

  it('unlinks only sockets that are definitely stale', () => {
    expect(shouldUnlinkDaemonSocket(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe(
      true
    )
    expect(
      shouldUnlinkDaemonSocket(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
    ).toBe(true)
    expect(shouldUnlinkDaemonSocket(Object.assign(new Error('sandbox'), { code: 'EPERM' }))).toBe(
      false
    )
    expect(
      shouldUnlinkDaemonSocket(Object.assign(new Error('permissions'), { code: 'EACCES' }))
    ).toBe(false)
    expect(shouldUnlinkDaemonSocket(new Error('Daemon request timed out'))).toBe(false)
  })

  it('preserves pid and socket ownership when the process cannot be killed', () => {
    fs.writeFileSync(DAEMON_PATHS.pid(), '4242')
    fs.writeFileSync(DAEMON_PATHS.socket(), 'live endpoint placeholder')
    const kill = spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })

    expect(forceKillDaemon()).toBe(false)
    expect(fs.existsSync(DAEMON_PATHS.pid())).toBe(true)
    expect(fs.existsSync(DAEMON_PATHS.socket())).toBe(true)

    kill.mockRestore()
  })

  it('removes stale ownership files when the recorded process is gone', () => {
    fs.writeFileSync(DAEMON_PATHS.pid(), '4242')
    fs.writeFileSync(DAEMON_PATHS.socket(), 'stale endpoint placeholder')
    const kill = spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })

    expect(forceKillDaemon()).toBe(false)
    expect(fs.existsSync(DAEMON_PATHS.pid())).toBe(false)
    expect(fs.existsSync(DAEMON_PATHS.socket())).toBe(false)

    kill.mockRestore()
  })
})
