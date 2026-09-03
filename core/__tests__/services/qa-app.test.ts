import { describe, expect, it } from 'bun:test'
import os from 'node:os'
import { startApp, waitReady, withApp } from '../../services/qa-app'

const freePort = (): number => 40_000 + Math.floor(Math.random() * 20_000)
const serverCmd = (port: number): string =>
  `node -e "require('http').createServer((q,s)=>s.end('up')).listen(${port})"`

const isUp = async (port: number): Promise<boolean> =>
  fetch(`http://127.0.0.1:${port}/`)
    .then(() => true)
    .catch(() => false)

describe('qa-app', () => {
  it('starts the registered command, waits until it answers, and tears the tree down', async () => {
    const port = freePort()
    const handle = startApp(os.tmpdir(), serverCmd(port))
    expect(handle.pid).not.toBe(null)
    const ready = await waitReady(`http://127.0.0.1:${port}`, '/', 15_000)
    expect(ready.ready).toBe(true)
    await handle.stop()
    // Give the kernel a beat to release the port after the tree kill.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await isUp(port)).toBe(false)
  })

  it('withApp runs the callback with the app up and reports readiness', async () => {
    const port = freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const run = await withApp(
      os.tmpdir(),
      { start: serverCmd(port), baseUrl, readyTimeoutMs: 15_000 },
      async (ready) => ({ ready, up: await isUp(port) })
    )
    expect(run.app.started).toBe(true)
    expect(run.app.error).toBeUndefined()
    expect(run.result.up).toBe(true)
    expect(typeof run.result.ready.readyMs).toBe('number')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await isUp(port)).toBe(false)
  })

  it('without a start command it runs against baseUrl as-is; a dead app is reported, not hidden', async () => {
    const plain = await withApp(
      os.tmpdir(),
      { baseUrl: 'http://127.0.0.1:1' },
      async (ready) => ready
    )
    expect(plain.app.started).toBe(false)
    expect(plain.result.baseUrl).toBe('http://127.0.0.1:1')
    const port = freePort()
    const dead = await withApp(
      os.tmpdir(),
      { start: 'true', baseUrl: `http://127.0.0.1:${port}`, readyTimeoutMs: 1_200 },
      async (ready) => ready
    )
    expect(dead.app.started).toBe(true)
    expect(dead.app.error).toContain('did not answer')
  })
})
