import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import {
  COMMAND_REQUEST_TIMEOUT_MS,
  commandRequestTimeoutMs,
  getDaemonRunDir,
  getDaemonSocketPath,
  HOOK_REQUEST_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  isDaemonNamedPipe,
  LONG_COMMAND_TIMEOUT_MS,
  LONG_RUNNING_COMMANDS,
} from '../../daemon/protocol'

describe('daemon IPC platform paths', () => {
  test('uses Unix socket paths on POSIX platforms', () => {
    const cliHome = path.join('/tmp', 'prjct-home')
    expect(getDaemonRunDir(cliHome)).toBe(path.join(cliHome, 'run'))
    expect(getDaemonSocketPath('linux', cliHome)).toBe(path.join(cliHome, 'run', 'daemon.sock'))
    expect(getDaemonSocketPath('darwin', cliHome)).toBe(path.join(cliHome, 'run', 'daemon.sock'))
    expect(isDaemonNamedPipe(getDaemonSocketPath('linux', cliHome))).toBe(false)
  })

  test('uses a stable named pipe on Windows', () => {
    const cliHome = 'C:\\Users\\Jane\\.prjct-cli'
    const socketPath = getDaemonSocketPath('win32', cliHome)
    expect(socketPath).toStartWith('\\\\.\\pipe\\prjct-')
    expect(socketPath).toEndWith('-daemon')
    expect(socketPath).not.toContain('daemon.sock')
    expect(isDaemonNamedPipe(socketPath)).toBe(true)
    expect(getDaemonSocketPath('win32', cliHome)).toBe(socketPath)
  })
})

describe('commandRequestTimeoutMs', () => {
  test('hooks stay fail-soft at 800ms', () => {
    expect(commandRequestTimeoutMs('hook')).toBe(HOOK_REQUEST_TIMEOUT_MS)
    expect(HOOK_REQUEST_TIMEOUT_MS).toBe(800)
  })

  test('ship/sync and other long verbs get the 10min budget', () => {
    for (const cmd of LONG_RUNNING_COMMANDS) {
      expect(commandRequestTimeoutMs(cmd)).toBe(LONG_COMMAND_TIMEOUT_MS)
    }
    expect(LONG_COMMAND_TIMEOUT_MS).toBe(10 * 60 * 1000)
    // Ship alone can exceed 65s (version+changelog+commit+push) before gates.
    expect(commandRequestTimeoutMs('ship')).toBeGreaterThan(65_000)
  })

  test('snappy verbs stay at 30s so a hung daemon cannot pin the shell', () => {
    expect(commandRequestTimeoutMs('search')).toBe(COMMAND_REQUEST_TIMEOUT_MS)
    expect(commandRequestTimeoutMs('remember')).toBe(COMMAND_REQUEST_TIMEOUT_MS)
    expect(COMMAND_REQUEST_TIMEOUT_MS).toBe(30_000)
  })
})

describe('IDLE_TIMEOUT_MS', () => {
  test('is 8h so the daemon outlives a full working session', () => {
    // 30min let the daemon die mid-Claude-session, silently degrading every
    // later hook to the cold path. Every request (hooks included) resets the
    // timer, so 8h only shuts down after a full stretch of inactivity.
    expect(IDLE_TIMEOUT_MS).toBe(8 * 60 * 60 * 1000)
  })
})
