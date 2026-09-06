import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  httpProbeTargetAllowed,
  runCliProbe,
  runFileProbe,
  runHttpProbe,
  runProbe,
} from '../../services/qa-probes'

const fixture: { server: ReturnType<typeof Bun.serve> | null; baseUrl: string; dir: string } = {
  server: null,
  baseUrl: '',
  dir: '',
}

beforeAll(async () => {
  fixture.server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/health') return Response.json({ ok: true, deep: { n: 2 } })
      if (url.pathname === '/boom') return new Response('server exploded', { status: 500 })
      return new Response('hello world')
    },
  })
  fixture.baseUrl = `http://127.0.0.1:${fixture.server.port}`
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-qa-probes-'))
  await fs.writeFile(path.join(fixture.dir, 'README.md'), '# hello\nprobe me\n')
})

afterAll(async () => {
  fixture.server?.stop(true)
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => undefined)
})

const http = (over: Record<string, unknown> = {}) => ({
  type: 'http' as const,
  method: 'GET',
  expect: { bodyIncludes: [] as string[] },
  ...over,
})

describe('http probe target allowlist (SEC-16)', () => {
  it('allows the app origin and loopback, blocks everything else', () => {
    const base = 'https://staging.example.com:8443'
    expect(httpProbeTargetAllowed(`${base}/health`, base)).toBe(true)
    expect(httpProbeTargetAllowed('http://127.0.0.1:3000/x', base)).toBe(true)
    expect(httpProbeTargetAllowed('http://localhost/x', null)).toBe(true)
    expect(httpProbeTargetAllowed('http://[::1]:80/x', null)).toBe(true)
    expect(httpProbeTargetAllowed('https://staging.example.com/x', base)).toBe(false) // port differs
    expect(httpProbeTargetAllowed('http://169.254.169.254/latest/meta-data', base)).toBe(false)
    expect(httpProbeTargetAllowed('https://evil.example/x', null)).toBe(false)
    expect(httpProbeTargetAllowed('file:///etc/passwd', base)).toBe(false)
    expect(httpProbeTargetAllowed('not a url', base)).toBe(false)
  })

  it('reports an explicit off-origin url as blocked without fetching it', async () => {
    const blocked = await runHttpProbe(
      http({ url: 'http://169.254.169.254/latest/meta-data' }),
      'https://app.example.com'
    )
    expect(blocked.ok).toBe(false)
    expect(blocked.outcome).toBe('blocked')
    expect(blocked.detail).toContain('outside the app under test')
    // Same-origin explicit url still runs.
    const same = await runHttpProbe(http({ url: `${fixture.baseUrl}/health` }), fixture.baseUrl)
    expect(same.ok).toBe(true)
  })
})

describe('http probe', () => {
  it('passes on 2xx + body match + jsonPath; reports mismatches with detail', async () => {
    const ok = await runHttpProbe(
      http({
        path: '/health',
        expect: { status: 200, bodyIncludes: ['ok'], jsonPath: { 'deep.n': 2 } },
      }),
      fixture.baseUrl
    )
    expect(ok.ok).toBe(true)
    const bad = await runHttpProbe(
      http({ path: '/health', expect: { bodyIncludes: ['nope'], jsonPath: { 'deep.n': 3 } } }),
      fixture.baseUrl
    )
    expect(bad.ok).toBe(false)
    expect(bad.outcome).toBe('mismatch')
    expect(bad.detail).toContain('body lacks "nope"')
    expect(bad.detail).toContain('deep.n=2')
    const five = await runHttpProbe(http({ path: '/boom' }), fixture.baseUrl)
    expect(five.outcome).toBe('mismatch')
    expect(five.detail).toContain('status 500')
  })

  it('is unavailable (never red) without a baseUrl or when the app is unreachable', async () => {
    const noBase = await runHttpProbe(http({ path: '/' }), null)
    expect(noBase.unavailable).toBe(true)
    expect(noBase.detail).toContain('app.baseUrl')
    const dead = await runHttpProbe(http({ path: '/' }), 'http://127.0.0.1:1')
    expect(dead.ok).toBe(false)
    expect(dead.unavailable).toBe(true)
    expect(dead.outcome).toBe('unreachable')
  })
})

describe('cli probe', () => {
  it('checks exit code, stdout regex and stderr; missing binary is unavailable', async () => {
    const ok = await runCliProbe(fixture.dir, {
      type: 'cli',
      command: 'echo ready',
      expect: { exitCode: 0, stdoutMatches: '^ready' },
    })
    expect(ok.ok).toBe(true)
    const red = await runCliProbe(fixture.dir, {
      type: 'cli',
      command: 'exit 3',
      expect: { exitCode: 0 },
    })
    expect(red.ok).toBe(false)
    expect(red.outcome).toBe('exit:3')
    const regex = await runCliProbe(fixture.dir, {
      type: 'cli',
      command: 'echo nope',
      expect: { exitCode: 0, stdoutMatches: 'ready' },
    })
    expect(regex.outcome).toBe('mismatch')
    const missing = await runCliProbe(fixture.dir, {
      type: 'cli',
      command: 'prjct-no-such-binary-xyz',
      expect: { exitCode: 0 },
    })
    expect(missing.unavailable).toBe(true)
  })
})

describe('file + browser probes, dispatcher', () => {
  it('file: exists + includes; browser: unavailable until phase 2', async () => {
    const good = await runFileProbe(fixture.dir, {
      type: 'file',
      path: 'README.md',
      expect: { exists: true, includes: ['probe me'] },
    })
    expect(good.ok).toBe(true)
    const missing = await runFileProbe(fixture.dir, {
      type: 'file',
      path: 'nope.md',
      expect: { exists: true, includes: [] },
    })
    expect(missing.ok).toBe(false)
    expect(missing.detail).toContain('missing')
    process.env.PRJCT_QA_BROWSER_DIR = fixture.dir
    const browser = await runProbe(
      { type: 'browser', steps: [{ do: 'goto', url: '/' }] },
      { projectPath: fixture.dir, baseUrl: fixture.baseUrl, projectId: 'proj' }
    )
    delete process.env.PRJCT_QA_BROWSER_DIR
    expect(browser.unavailable).toBe(true)
    expect(browser.detail).toContain('prjct qa browser install')
    const viaDispatcher = await runProbe(http({ path: '/' }), {
      projectPath: fixture.dir,
      baseUrl: fixture.baseUrl,
    })
    expect(viaDispatcher.ok).toBe(true)
  })
})
