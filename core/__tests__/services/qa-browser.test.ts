import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  browserHome,
  browserStatus,
  closeBrowserSession,
  runBrowserPrimitive,
  runBrowserSteps,
  SESSION_SCRIPT_SOURCE,
  sendBrowserCommand,
  sessionSocketPath,
} from '../../services/qa-browser'
import { runProbe } from '../../services/qa-probes'

const fixture: { home: string; server: net.Server | null; log: string[] } = {
  home: '',
  server: null,
  log: [],
}

/** Pretend the driver + Chromium + session script are installed. */
async function fakeInstall(): Promise<void> {
  await fs.mkdir(path.join(fixture.home, 'node_modules', 'playwright-core'), { recursive: true })
  await fs.writeFile(
    path.join(fixture.home, 'node_modules', 'playwright-core', 'package.json'),
    JSON.stringify({ name: 'playwright-core', version: '1.99.0' })
  )
  await fs.mkdir(path.join(fixture.home, 'ms-playwright', 'chromium-1234'), { recursive: true })
  await fs.writeFile(path.join(fixture.home, 'session.mjs'), SESSION_SCRIPT_SOURCE)
}

/** A stand-in for the real session server: same wire protocol, scripted page. */
function fakeSession(sockPath: string): Promise<net.Server> {
  return new Promise((resolve) => {
    const page = { url: 'about:blank', text: 'Welcome home' }
    const server = net.createServer((socket) => {
      const pending = { buf: '' }
      socket.on('data', (data) => {
        pending.buf += data.toString('utf8')
        const lines = pending.buf.split('\n')
        pending.buf = lines.pop() ?? ''
        for (const line of lines.filter((l) => l.trim())) {
          const cmd = JSON.parse(line) as { do: string; [k: string]: unknown }
          fixture.log.push(cmd.do)
          const reply = ((): Record<string, unknown> => {
            switch (cmd.do) {
              case 'ping':
                return { ok: true, url: page.url }
              case 'reset':
                page.url = 'about:blank'
                return { ok: true }
              case 'goto':
                page.url = String(cmd.url)
                return { ok: true, url: page.url, title: 'Fake' }
              case 'expectText':
                return page.text.includes(String(cmd.text))
                  ? { ok: true }
                  : { ok: false, error: `text "${cmd.text}" not found`, sample: page.text }
              case 'expectUrl':
                return page.url.includes(String(cmd.includes))
                  ? { ok: true, url: page.url }
                  : { ok: false, error: `url ${page.url} does not include "${cmd.includes}"` }
              case 'text':
                return { ok: true, url: page.url, text: page.text }
              case 'screenshot':
                return { ok: true, file: `/tmp/${cmd.name ?? 'shot'}.png` }
              case 'close':
                setTimeout(() => server.close(), 10)
                return { ok: true }
              default:
                return { ok: true }
            }
          })()
          socket.write(`${JSON.stringify(reply)}\n`)
        }
      })
    })
    server.listen(sockPath, () => resolve(server))
  })
}

beforeEach(async () => {
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-qa-browser-'))
  process.env.PRJCT_QA_BROWSER_DIR = fixture.home
  fixture.log = []
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!fixture.server) return resolve()
    fixture.server.close(() => resolve())
    fixture.server = null
  })
  delete process.env.PRJCT_QA_BROWSER_DIR
  await fs.rm(fixture.home, { recursive: true, force: true }).catch(() => undefined)
})

describe('qa-browser — install state', () => {
  it('reports not installed until driver, chromium and session script exist', async () => {
    expect(browserHome()).toBe(fixture.home)
    expect(browserStatus().installed).toBe(false)
    await fakeInstall()
    const status = browserStatus()
    expect(status).toMatchObject({ installed: true, playwrightVersion: '1.99.0', chromium: true })
  })

  it('the generated session script is const-only and speaks the wire protocol', () => {
    expect(SESSION_SCRIPT_SOURCE).not.toMatch(/\b(let|var)\b/)
    expect(SESSION_SCRIPT_SOURCE).toContain("from 'playwright-core'")
    expect(SESSION_SCRIPT_SOURCE).toContain("case 'expectText'")
    expect(SESSION_SCRIPT_SOURCE).toContain('net.createServer')
  })

  it('browser probes and primitives are unavailable (never red) before install', async () => {
    const run = await runBrowserSteps('proj', [{ do: 'goto', url: '/' }], 'http://localhost:1')
    expect(run.unavailable).toBe(true)
    expect(run.detail).toContain('prjct qa browser install')
    const primitive = await runBrowserPrimitive('proj', ['goto', '/'], 'http://localhost:1')
    expect(primitive.ok).toBe(false)
    expect(primitive.text).toContain('prjct qa browser install')
    const usage = await runBrowserPrimitive('proj', ['frobnicate'], null)
    expect(usage.text).toContain('usage:')
  })
})

describe('qa-browser — session protocol', () => {
  beforeEach(async () => {
    await fakeInstall()
    const sockPath = sessionSocketPath('proj')
    await fs.mkdir(path.dirname(sockPath), { recursive: true })
    fixture.server = await fakeSession(sockPath)
  })

  it('runs declarative steps in a fresh context and stops at the first failing step', async () => {
    const ok = await runBrowserSteps(
      'proj',
      [
        { do: 'goto', url: '/dashboard' },
        { do: 'expectUrl', includes: '/dashboard' },
        { do: 'expectText', text: 'Welcome' },
        { do: 'screenshot', name: 'dash' },
      ],
      'http://localhost:3000'
    )
    expect(ok).toMatchObject({ ok: true, outcome: 'ok', stepsRun: 4 })
    expect(ok.screenshots).toEqual(['/tmp/dash.png'])
    expect(fixture.log.slice(0, 3)).toEqual(['ping', 'reset', 'goto'])

    const failed = await runBrowserSteps(
      'proj',
      [
        { do: 'goto', url: 'http://localhost:3000/login' },
        { do: 'expectText', text: 'Goodbye' },
      ],
      null
    )
    expect(failed.ok).toBe(false)
    expect(failed.outcome).toBe('step-failed')
    expect(failed.detail).toContain('step 2/2 expectText')
    expect(failed.detail).toContain('Welcome home')

    const noBase = await runBrowserSteps('proj', [{ do: 'goto', url: '/x' }], null)
    expect(noBase.unavailable).toBe(true)
    expect(noBase.detail).toContain('app.baseUrl')
  })

  // SEC-11: an absolute goto URL is navigated only on the app under test.
  // A metadata/off-origin URL is refused before it reaches the session, so
  // the app's cookies never ride to an attacker-chosen host.
  it('refuses an off-origin absolute goto without navigating', async () => {
    const steps = await runBrowserSteps(
      'proj',
      [{ do: 'goto', url: 'http://169.254.169.254/latest/meta-data' }],
      'http://localhost:3000'
    )
    expect(steps.ok).toBe(false)
    expect(steps.detail).toMatch(/outside the app under test/)

    const primitive = await runBrowserPrimitive(
      'proj',
      ['goto', 'http://evil.example/steal'],
      'http://localhost:3000'
    )
    expect(primitive.ok).toBe(false)
    expect(primitive.text).toMatch(/outside the app under test/)

    // Same-origin absolute and relative gotos still work.
    const ok = await runBrowserPrimitive('proj', ['goto', 'http://localhost:3000/ok'], null)
    expect(ok.ok).toBe(true)
  })

  it('a browser probe rides the same session through runProbe', async () => {
    const result = await runProbe(
      {
        type: 'browser',
        steps: [
          { do: 'goto', url: '/' },
          { do: 'expectText', text: 'home' },
        ],
      },
      { projectPath: fixture.home, baseUrl: 'http://localhost:3000', projectId: 'proj' }
    )
    expect(result.ok).toBe(true)
    expect(result.type).toBe('browser')
    const noProject = await runProbe(
      { type: 'browser', steps: [{ do: 'goto', url: '/' }] },
      { projectPath: fixture.home, baseUrl: null }
    )
    expect(noProject.unavailable).toBe(true)
  })

  it('primitives resolve relative paths, return page text, and close the session', async () => {
    const goto = await runBrowserPrimitive('proj', ['goto', '/login'], 'http://localhost:3000')
    expect(goto.ok).toBe(true)
    expect(goto.text).toContain('url: http://localhost:3000/login')
    const text = await runBrowserPrimitive('proj', ['text'], null)
    expect(text.text).toContain('Welcome home')
    const bad = await runBrowserPrimitive('proj', ['fill', '#only-selector'], null)
    expect(bad.ok).toBe(false)
    expect(bad.text).toContain('usage')
    const raw = await sendBrowserCommand(sessionSocketPath('proj'), { do: 'ping' })
    expect(raw.ok).toBe(true)
    const closed = await closeBrowserSession('proj')
    expect(closed.ok).toBe(true)
    fixture.server = null
    await new Promise((resolve) => setTimeout(resolve, 50))
    const gone = await sendBrowserCommand(sessionSocketPath('proj'), { do: 'ping' }, 500)
    expect(gone.ok).toBe(false)
  })
})
