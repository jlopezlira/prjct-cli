import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(__dirname, '../../..')
const TOKEN = '0123456789abcdef01234567'
const cleanup: Array<() => void> = []

const { generateDaemonShim } = require(join(ROOT, 'scripts/build.js')) as {
  generateDaemonShim: () => string
}

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.()
})

async function captureRequest(
  cliHome: string,
  launch: (socketPath: string) => ReturnType<typeof spawn>
): Promise<Record<string, unknown>> {
  const socketPath = join(cliHome, 'run', 'daemon.sock')
  mkdirSync(join(cliHome, 'run'), { recursive: true })
  const request = new Promise<Record<string, unknown>>((resolve, reject) => {
    const server = createServer((connection) => {
      const chunks: string[] = []
      connection.setEncoding('utf8')
      connection.on('data', (chunk) => {
        chunks.push(String(chunk))
        const payload = chunks.join('')
        const newline = payload.indexOf('\n')
        if (newline < 0) return
        resolve(JSON.parse(payload.slice(0, newline)) as Record<string, unknown>)
        connection.end(`${JSON.stringify({ success: true, output: '' })}\n`)
      })
      connection.on('error', reject)
    })
    server.on('error', reject)
    server.listen(socketPath, () => launch(socketPath))
    cleanup.push(() => server.close())
  })

  return request
}

describe('source inspection option routing', () => {
  test('native launcher refuses mutating verbs before opening a daemon connection', async () => {
    if (process.platform === 'win32') return
    const cliHome = mkdtempSync(join(tmpdir(), 'prjct-native-mutations-'))
    cleanup.push(() => rmSync(cliHome, { recursive: true, force: true }))
    const binaryPath = join(cliHome, 'prjct-native')
    const compile = Bun.spawnSync(['cc', '-O2', '-o', binaryPath, join(ROOT, 'native/hook-fast.c')])
    if (compile.exitCode !== 0 || !existsSync(binaryPath)) return
    mkdirSync(join(cliHome, 'run'))
    const connections: boolean[] = []
    const server = createServer((connection) => {
      connections.push(true)
      connection.on('error', () => {})
      connection.destroy()
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(join(cliHome, 'run/daemon.sock'), resolve))
    for (const [verb, argument] of [
      ['work', 'intent'],
      ['status', 'done'],
    ]) {
      const child = spawn(binaryPath, ['verb', verb!, argument!], {
        cwd: ROOT,
        env: { ...process.env, PRJCT_CLI_HOME: cliHome, PRJCT_NO_DAEMON: '0' },
        stdio: 'ignore',
      })
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })
      expect(code).toBe(89)
    }
    expect(connections).toEqual([])
  })

  test('generated daemon shim forwards the token without environment state', async () => {
    const cliHome = mkdtempSync(join(tmpdir(), 'prjct-shim-routing-'))
    cleanup.push(() => rmSync(cliHome, { recursive: true, force: true }))
    const shimPath = join(cliHome, 'prjct')
    writeFileSync(shimPath, generateDaemonShim(), { mode: 0o755 })

    const request = await captureRequest(cliHome, () =>
      spawn(
        process.execPath,
        [shimPath, 'guard', 'core/state.ts', `--source-inspection-token=${TOKEN}`, '--md'],
        {
          cwd: ROOT,
          env: { ...process.env, PRJCT_CLI_HOME: cliHome, PRJCT_NO_DAEMON: '0' },
          stdio: 'ignore',
        }
      )
    )

    expect(request.command).toBe('guard')
    expect(request.options).toEqual({ 'source-inspection-token': TOKEN, md: true })
  })

  test('native launcher forwards the token without environment state', async () => {
    if (process.platform === 'win32') return

    const cliHome = mkdtempSync(join(tmpdir(), 'prjct-native-routing-'))
    cleanup.push(() => rmSync(cliHome, { recursive: true, force: true }))
    const binaryPath = join(cliHome, 'prjct-native')
    const compile = Bun.spawnSync(['cc', '-O2', '-o', binaryPath, join(ROOT, 'native/hook-fast.c')])
    if (compile.exitCode !== 0 || !existsSync(binaryPath)) return

    const request = await captureRequest(cliHome, () =>
      spawn(
        binaryPath,
        ['verb', 'guard', 'core/state.ts', `--source-inspection-token=${TOKEN}`, '--md'],
        {
          cwd: ROOT,
          env: { ...process.env, PRJCT_CLI_HOME: cliHome, PRJCT_NO_DAEMON: '0' },
          stdio: 'ignore',
        }
      )
    )

    expect(request.command).toBe('guard')
    expect(request.options).toEqual({ 'source-inspection-token': TOKEN, md: true })
  })
})
