/**
 * Daemon control requests stay usable while a command owns output capture.
 * Exercises the real IPC server; only the long-running sync body is stubbed.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import { createServer, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getDaemonStatus, sendRequest } from '../../daemon/client'
import { DAEMON_PATHS } from '../../daemon/protocol'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup.length = 0
})

function home(): string {
  const previous = process.env.PRJCT_CLI_HOME
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-control-'))
  process.env.PRJCT_CLI_HOME = dir
  cleanup.push(() => {
    if (previous === undefined) delete process.env.PRJCT_CLI_HOME
    else process.env.PRJCT_CLI_HOME = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  fs.mkdirSync(DAEMON_PATHS.runDir(), { recursive: true })
  return dir
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  for (;;) {
    if (check()) return
    if (Date.now() > deadline) throw new Error('Fixture daemon did not become ready')
    await Bun.sleep(10)
  }
}

describe('daemon control availability', () => {
  it('answers ping, status and stop while sync is still running', async () => {
    const dir = home()
    const root = path.resolve(__dirname, '../../..')
    const started = path.join(dir, 'sync-started')
    const script = `
      import fs from 'node:fs';
      import { PrjctCommands } from ${JSON.stringify(path.join(root, 'core/commands/commands.ts'))};
      import { startDaemon } from ${JSON.stringify(path.join(root, 'core/daemon/daemon.ts'))};
      PrjctCommands.prototype.sync = async () => {
        fs.writeFileSync(${JSON.stringify(started)}, 'started');
        await new Promise(() => {});
        return { success: true };
      };
      await startDaemon({ foreground: true });
    `
    const child = Bun.spawn([process.execPath, '-e', script], {
      cwd: root,
      env: { ...process.env, PRJCT_CLI_HOME: dir, PRJCT_NO_SELF_SYNC: '1' },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    cleanup.push(async () => {
      child.kill('SIGKILL')
      await child.exited
    })
    await until(() => fs.existsSync(DAEMON_PATHS.pid()))
    void sendRequest(
      { id: 'blocked-sync', command: 'sync', args: [], options: {}, cwd: root },
      { timeoutMs: 4000 }
    ).catch(() => undefined)
    await until(() => fs.existsSync(started))
    for (const [command, args] of [
      ['__ping', []],
      ['daemon', ['status']],
      ['daemon', ['stop']],
    ] as const) {
      const response = await sendRequest(
        { id: `control-${command}-${args[0]}`, command, args: [...args], options: {}, cwd: root },
        { timeoutMs: 300 }
      )
      expect(response.success).toBe(true)
      if (args[0] === 'status') {
        expect(response.result).toMatchObject({ running: true, activeRequests: 1 })
      }
    }
  }, 15000)

  it('bounds status when an endpoint accepts connections without answering', async () => {
    home()
    const sockets: Socket[] = []
    const server = createServer((socket) => {
      sockets.push(socket)
    })
    await new Promise<void>((resolve) => server.listen(DAEMON_PATHS.socket(), resolve))
    cleanup.push(() => {
      for (const socket of sockets) socket.destroy()
      server.close()
    })
    const marker = Symbol('timeout')
    const timer = { value: undefined as ReturnType<typeof setTimeout> | undefined }
    const result = await Promise.race([
      getDaemonStatus(),
      new Promise<symbol>((resolve) => {
        timer.value = setTimeout(() => resolve(marker), 1500)
      }),
    ]).finally(() => clearTimeout(timer.value))
    expect(result).not.toBe(marker)
    expect(result).toMatchObject({ running: false })
    expect(fs.existsSync(DAEMON_PATHS.socket())).toBe(true)
  })
})
