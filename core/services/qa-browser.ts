/**
 * prjct's own headless browser — the universal fallback for browser flows.
 *
 * Installed ONCE per machine under the prjct cache dir (never inside the
 * client project): `playwright-core` via `npm install --prefix`, Chromium via
 * its own `install` command, plus a tiny session server prjct writes itself.
 * Works the same for npm and native-binary installs of prjct because the
 * runtime is fetched at install time, not bundled.
 *
 * Two consumers share one session per project (unix socket / named pipe,
 * idle timeout 10 min):
 *   - `browser` probes (`runBrowserSteps`) — machine-verified, receipt-bound
 *   - agent primitives `prjct qa browser goto|fill|click|text|screenshot|close`
 *     for rigs with no browser MCP, so the blind QA subagent can still drive
 *     the app as a user.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import pathManager from '../infrastructure/path-manager'
import type { QaBrowserStep } from '../schemas/qa'
import { matchProc, runProc } from '../utils/exec'
import { httpProbeTargetAllowed } from './qa-probes'

/** Major-pinned: Chromium and the driver must match, npm resolves the pair. */
const PLAYWRIGHT_CORE_SPEC = 'playwright-core@^1.50.0'
const SESSION_SCRIPT = 'session.mjs'
const SESSION_IDLE_MS = 10 * 60 * 1000
const COMMAND_TIMEOUT_MS = 45_000
const SESSION_BOOT_MS = 20_000
const NPM_TIMEOUT_MS = 10 * 60 * 1000
const CHROMIUM_TIMEOUT_MS = 20 * 60 * 1000

/** `PRJCT_QA_BROWSER_DIR` overrides the install dir (tests, air-gapped hosts). */
export function browserHome(): string {
  return (
    process.env.PRJCT_QA_BROWSER_DIR?.trim() || path.join(pathManager.getCachePath(), 'qa-browser')
  )
}

export function browsersPath(): string {
  return path.join(browserHome(), 'ms-playwright')
}

function playwrightPackageDir(): string {
  return path.join(browserHome(), 'node_modules', 'playwright-core')
}

export interface BrowserStatus {
  installed: boolean
  home: string
  playwrightVersion: string | null
  chromium: boolean
  sessionScript: boolean
}

export function browserStatus(): BrowserStatus {
  const home = browserHome()
  const version = (() => {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(playwrightPackageDir(), 'package.json'), 'utf8')
      ) as { version?: string }
      return typeof pkg.version === 'string' ? pkg.version : null
    } catch {
      return null
    }
  })()
  const chromium = (() => {
    try {
      return fs.readdirSync(browsersPath()).some((entry) => entry.startsWith('chromium'))
    } catch {
      return false
    }
  })()
  const sessionScript = fs.existsSync(path.join(home, SESSION_SCRIPT))
  return {
    installed: version !== null && chromium && sessionScript,
    home,
    playwrightVersion: version,
    chromium,
    sessionScript,
  }
}

/**
 * The session server, written next to the installed driver so its
 * `playwright-core` import resolves from that node_modules. Newline-delimited
 * JSON in, one JSON line out per command. Const-only on purpose: the repo's
 * no-let gate scans every tracked file, strings included.
 */
export const SESSION_SCRIPT_SOURCE: string = [
  "import fs from 'node:fs'",
  "import net from 'node:net'",
  "import path from 'node:path'",
  "import { chromium } from 'playwright-core'",
  '',
  'const [sockPath, screenshotDir, idleArg] = process.argv.slice(2)',
  'const IDLE_MS = Number(idleArg) || 600000',
  'const state = { browser: null, context: null, page: null, timer: null, server: null }',
  '',
  'const shutdown = async () => {',
  '  try { if (state.browser) await state.browser.close() } catch {}',
  '  try { if (state.server) state.server.close() } catch {}',
  '  try { fs.unlinkSync(sockPath) } catch {}',
  '  process.exit(0)',
  '}',
  'const touch = () => { clearTimeout(state.timer); state.timer = setTimeout(shutdown, IDLE_MS) }',
  'const ensurePage = async () => {',
  '  if (!state.browser) state.browser = await chromium.launch({ headless: true })',
  '  if (!state.page) {',
  '    state.context = await state.browser.newContext()',
  '    state.page = await state.context.newPage()',
  '  }',
  '  return state.page',
  '}',
  'const reset = async () => {',
  '  if (state.context) await state.context.close().catch(() => {})',
  '  state.context = null',
  '  state.page = null',
  '  return ensurePage()',
  '}',
  'const locatorFor = (page, selector) => (selector ? page.locator(selector).first() : page.locator("body"))',
  'const run = async (cmd) => {',
  '  switch (cmd.do) {',
  "    case 'ping': return { ok: true, url: state.page ? state.page.url() : null }",
  "    case 'reset': { await reset(); return { ok: true } }",
  "    case 'goto': {",
  '      const page = await ensurePage()',
  "      await page.goto(cmd.url, { waitUntil: 'load', timeout: cmd.timeoutMs || 30000 })",
  '      return { ok: true, url: page.url(), title: await page.title() }',
  '    }',
  "    case 'fill': {",
  '      const page = await ensurePage()',
  '      await page.fill(cmd.selector, cmd.text, { timeout: 10000 })',
  '      return { ok: true }',
  '    }',
  "    case 'click': {",
  '      const page = await ensurePage()',
  '      await page.click(cmd.selector, { timeout: 10000 })',
  "      await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {})",
  '      return { ok: true, url: page.url() }',
  '    }',
  "    case 'text': {",
  '      const page = await ensurePage()',
  '      const text = await locatorFor(page, cmd.selector).innerText({ timeout: 10000 })',
  '      return { ok: true, url: page.url(), text: text.slice(0, cmd.max || 4000) }',
  '    }',
  "    case 'expectText': {",
  '      const page = await ensurePage()',
  '      const text = await locatorFor(page, cmd.selector).innerText({ timeout: 10000 })',
  '      if (text.includes(cmd.text)) return { ok: true }',
  "      return { ok: false, error: 'text \"' + cmd.text + '\" not found' + (cmd.selector ? ' in ' + cmd.selector : ''), sample: text.slice(0, 300) }",
  '    }',
  "    case 'expectUrl': {",
  '      const page = await ensurePage()',
  '      const url = page.url()',
  '      if (url.includes(cmd.includes)) return { ok: true, url }',
  "      return { ok: false, error: 'url ' + url + ' does not include \"' + cmd.includes + '\"' }",
  '    }',
  "    case 'screenshot': {",
  '      const page = await ensurePage()',
  '      fs.mkdirSync(screenshotDir, { recursive: true })',
  "      const name = String(cmd.name || 'shot').replace(/[^\\w.-]+/g, '_')",
  "      const file = path.join(screenshotDir, name + '-' + Date.now() + '.png')",
  '      await page.screenshot({ path: file, fullPage: true })',
  '      return { ok: true, file }',
  '    }',
  "    case 'close': { setTimeout(shutdown, 20); return { ok: true } }",
  "    default: return { ok: false, error: 'unknown command ' + String(cmd.do) }",
  '  }',
  '}',
  '',
  'try { fs.unlinkSync(sockPath) } catch {}',
  'fs.mkdirSync(path.dirname(sockPath), { recursive: true })',
  'state.server = net.createServer((socket) => {',
  "  const pending = { buf: '' }",
  "  socket.on('data', async (data) => {",
  "    pending.buf += data.toString('utf8')",
  "    const lines = pending.buf.split('\\n')",
  "    pending.buf = lines.pop() || ''",
  '    for (const line of lines) {',
  '      if (!line.trim()) continue',
  '      touch()',
  '      const cmd = (() => { try { return JSON.parse(line) } catch { return null } })()',
  '      const result = cmd',
  '        ? await run(cmd).catch((error) => ({ ok: false, error: (error && error.message) || String(error) }))',
  "        : { ok: false, error: 'invalid JSON' }",
  "      socket.write(JSON.stringify(result) + '\\n')",
  '    }',
  '  })',
  "  socket.on('error', () => {})",
  '})',
  'state.server.listen(sockPath, () => touch())',
  "process.on('SIGTERM', shutdown)",
  "process.on('SIGINT', shutdown)",
  '',
].join('\n')

export interface InstallResult {
  ok: boolean
  error?: string
  status: BrowserStatus
}

/**
 * One-time, per machine: driver + Chromium under the cache dir. Every step
 * reports through `log`; a failure names the step so the agent can retry it.
 */
export async function installBrowser(log: (line: string) => void): Promise<InstallResult> {
  const home = browserHome()
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(browsersPath(), { recursive: true })
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath() }

  log(`Installing ${PLAYWRIGHT_CORE_SPEC} into ${home} …`)
  const npmResult = await runProc(
    'npm',
    ['install', '--prefix', home, '--no-audit', '--no-fund', '--silent', PLAYWRIGHT_CORE_SPEC],
    { cwd: home, env, timeoutMs: NPM_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
  )
  const npmError = matchProc<string | null>(npmResult, {
    ok: () => null,
    exit: (r) =>
      `npm install exited ${r.code ?? 'signal'}: ${`${r.stdout}\n${r.stderr}`.trim().slice(-400)}`,
    timeout: () => 'npm install timed out',
    spawn: (r) => `npm could not start: ${r.cause.message} (is Node/npm on PATH?)`,
    overflow: () => 'npm install output overflowed',
  })
  if (npmError) return { ok: false, error: npmError, status: browserStatus() }

  log('Downloading Chromium (one-time, a few hundred MB) …')
  const cli = path.join(playwrightPackageDir(), 'cli.js')
  const chromiumResult = await runProc('node', [cli, 'install', 'chromium'], {
    cwd: home,
    env,
    timeoutMs: CHROMIUM_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  })
  const chromiumError = matchProc<string | null>(chromiumResult, {
    ok: () => null,
    exit: (r) =>
      `chromium install exited ${r.code ?? 'signal'}: ${`${r.stdout}\n${r.stderr}`.trim().slice(-400)}`,
    timeout: () => 'chromium download timed out',
    spawn: (r) => `node could not start: ${r.cause.message}`,
    overflow: () => 'chromium install output overflowed',
  })
  if (chromiumError) return { ok: false, error: chromiumError, status: browserStatus() }

  fs.writeFileSync(path.join(home, SESSION_SCRIPT), SESSION_SCRIPT_SOURCE)
  log('Session server written.')
  const status = browserStatus()
  return status.installed
    ? { ok: true, status }
    : {
        ok: false,
        error: 'install finished but the browser is not usable — see `prjct qa browser status`',
        status,
      }
}

export function sessionSocketPath(projectId: string): string {
  const id = projectId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'default'
  if (process.platform === 'win32') return `\\\\.\\pipe\\prjct-qa-${id}`
  return path.join(browserHome(), 'sessions', `${id}.sock`)
}

export function screenshotDir(projectId: string): string {
  return path.join(pathManager.getGlobalProjectPath(projectId), 'qa', 'screenshots')
}

export interface BrowserCommand {
  do: string
  [key: string]: unknown
}

export interface BrowserResult {
  ok: boolean
  error?: string
  url?: string
  title?: string
  text?: string
  file?: string
  sample?: string
  [key: string]: unknown
}

/** One command, one reply — the session keeps the page between calls. */
export function sendBrowserCommand(
  sockPath: string,
  command: BrowserCommand,
  timeoutMs: number = COMMAND_TIMEOUT_MS
): Promise<BrowserResult> {
  return new Promise((resolve) => {
    const socket = net.connect(sockPath)
    const pending = { buf: '', done: false }
    const finish = (result: BrowserResult) => {
      if (pending.done) return
      pending.done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: `browser command ${command.do} timed out after ${timeoutMs}ms`,
        }),
      timeoutMs
    )
    socket.on('connect', () => socket.write(`${JSON.stringify(command)}\n`))
    socket.on('data', (data) => {
      pending.buf += data.toString('utf8')
      const newline = pending.buf.indexOf('\n')
      if (newline === -1) return
      const line = pending.buf.slice(0, newline)
      try {
        finish(JSON.parse(line) as BrowserResult)
      } catch {
        finish({
          ok: false,
          error: `unreadable reply from the browser session: ${line.slice(0, 120)}`,
        })
      }
    })
    socket.on('error', (error) =>
      finish({ ok: false, error: `session unreachable: ${error.message}` })
    )
    socket.on('close', () => finish({ ok: false, error: 'session closed before replying' }))
  })
}

async function ping(sockPath: string): Promise<boolean> {
  const reply = await sendBrowserCommand(sockPath, { do: 'ping' }, 3_000)
  return reply.ok
}

export interface SessionHandle {
  ok: boolean
  sockPath: string
  error?: string
}

/** Reuse the live session or spawn one (detached, idle-exits on its own). */
export async function ensureBrowserSession(projectId: string): Promise<SessionHandle> {
  const status = browserStatus()
  const sockPath = sessionSocketPath(projectId)
  if (!status.installed) {
    return {
      ok: false,
      sockPath,
      error:
        'prjct browser not installed — one-time: `prjct qa browser install` (a few hundred MB under the prjct cache, never in the project)',
    }
  }
  if (await ping(sockPath)) return { ok: true, sockPath }
  try {
    fs.mkdirSync(path.dirname(sockPath), { recursive: true })
    const child = spawn(
      'node',
      [
        path.join(status.home, SESSION_SCRIPT),
        sockPath,
        screenshotDir(projectId),
        String(SESSION_IDLE_MS),
      ],
      {
        cwd: status.home,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath() },
        detached: true,
        stdio: 'ignore',
      }
    )
    child.on('error', () => undefined)
    child.unref()
  } catch (error) {
    return {
      ok: false,
      sockPath,
      error: `could not start the browser session: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const deadline = Date.now() + SESSION_BOOT_MS
  while (Date.now() < deadline) {
    if (await ping(sockPath)) return { ok: true, sockPath }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { ok: false, sockPath, error: 'browser session did not come up in time' }
}

export async function closeBrowserSession(projectId: string): Promise<BrowserResult> {
  const sockPath = sessionSocketPath(projectId)
  if (!(await ping(sockPath))) return { ok: true, error: 'no live session' }
  return sendBrowserCommand(sockPath, { do: 'close' }, 5_000)
}

/**
 * Absolute URLs are navigated only when they stay on the app under test
 * (same origin as `qa.app.baseUrl`, or loopback) — the browser session
 * carries the app's cookies, and a step is agent-written data.
 */
function resolveUrl(url: string, baseUrl: string | null): string | null {
  if (/^https?:\/\//i.test(url)) return httpProbeTargetAllowed(url, baseUrl) ? url : null
  if (!baseUrl) return null
  try {
    return new URL(url, baseUrl).toString()
  } catch {
    return null
  }
}

function gotoRefusal(url: string, baseUrl: string | null): string {
  if (/^https?:\/\//i.test(url)) {
    return `goto ${url}: outside the app under test (${baseUrl ?? 'no baseUrl'}); only qa.app.baseUrl or loopback origins are navigated`
  }
  return `goto ${url}: no baseUrl (prjct qa set app.baseUrl <url>)`
}

type MappedCommand = { ok: true; command: BrowserCommand } | { ok: false; error: string }

function stepToCommand(step: QaBrowserStep, baseUrl: string | null): MappedCommand {
  switch (step.do) {
    case 'goto': {
      const url = resolveUrl(step.url, baseUrl)
      return url
        ? { ok: true, command: { do: 'goto', url } }
        : { ok: false, error: gotoRefusal(step.url, baseUrl) }
    }
    case 'fill':
      return { ok: true, command: { do: 'fill', selector: step.selector, text: step.text } }
    case 'click':
      return { ok: true, command: { do: 'click', selector: step.selector } }
    case 'expectText':
      return { ok: true, command: { do: 'expectText', text: step.text, selector: step.selector } }
    case 'expectUrl':
      return { ok: true, command: { do: 'expectUrl', includes: step.includes } }
    case 'screenshot':
      return { ok: true, command: { do: 'screenshot', name: step.name } }
  }
}

export interface BrowserRun {
  ok: boolean
  /** 'ok' | 'step-failed' | 'unavailable' */
  outcome: string
  detail?: string
  unavailable?: boolean
  stepsRun: number
  screenshots: string[]
}

/** Machine-run a declarative flow in a fresh context; stops at the first failing step. */
export async function runBrowserSteps(
  projectId: string,
  steps: QaBrowserStep[],
  baseUrl: string | null
): Promise<BrowserRun> {
  const session = await ensureBrowserSession(projectId)
  if (!session.ok) {
    return {
      ok: false,
      outcome: 'unavailable',
      unavailable: true,
      detail: session.error,
      stepsRun: 0,
      screenshots: [],
    }
  }
  const reset = await sendBrowserCommand(session.sockPath, { do: 'reset' })
  if (!reset.ok) {
    return {
      ok: false,
      outcome: 'unavailable',
      unavailable: true,
      detail: reset.error,
      stepsRun: 0,
      screenshots: [],
    }
  }
  const screenshots: string[] = []
  for (const [index, step] of steps.entries()) {
    const mapped = stepToCommand(step, baseUrl)
    if (!mapped.ok) {
      return {
        ok: false,
        outcome: 'unavailable',
        unavailable: true,
        detail: mapped.error,
        stepsRun: index,
        screenshots,
      }
    }
    const reply = await sendBrowserCommand(session.sockPath, mapped.command)
    if (typeof reply.file === 'string') screenshots.push(reply.file)
    if (reply.ok) continue
    const sample = reply.sample ? `\n${reply.sample}` : ''
    return {
      ok: false,
      outcome: 'step-failed',
      detail: `step ${index + 1}/${steps.length} ${step.do}: ${reply.error ?? 'failed'}${sample}`,
      stepsRun: index + 1,
      screenshots,
    }
  }
  return { ok: true, outcome: 'ok', stepsRun: steps.length, screenshots }
}

export const BROWSER_PRIMITIVES = ['goto', 'fill', 'click', 'text', 'screenshot', 'close'] as const

/**
 * Agent primitives (`prjct qa browser <verb> …`) — shared by the CLI and the
 * MCP tool so both speak the same session. Returns text, never prints.
 */
export async function runBrowserPrimitive(
  projectId: string,
  args: string[],
  baseUrl: string | null
): Promise<{ ok: boolean; text: string }> {
  const [verb, ...rest] = args
  if (verb === 'close') {
    const closed = await closeBrowserSession(projectId)
    return {
      ok: closed.ok,
      text: closed.error ? `Browser: ${closed.error}` : 'Browser session closed.',
    }
  }
  const mapped = ((): MappedCommand => {
    switch (verb) {
      case 'goto': {
        const url = rest[0] ? resolveUrl(rest[0], baseUrl) : null
        return url
          ? { ok: true, command: { do: 'goto', url } }
          : {
              ok: false,
              error: rest[0]
                ? gotoRefusal(rest[0], baseUrl)
                : 'usage: prjct qa browser goto <url|/path> (relative paths need qa.app.baseUrl)',
            }
      }
      case 'fill':
        return rest.length >= 2
          ? { ok: true, command: { do: 'fill', selector: rest[0], text: rest.slice(1).join(' ') } }
          : { ok: false, error: 'usage: prjct qa browser fill <selector> <text…>' }
      case 'click':
        return rest[0]
          ? { ok: true, command: { do: 'click', selector: rest[0] } }
          : { ok: false, error: 'usage: prjct qa browser click <selector>' }
      case 'text':
        return { ok: true, command: { do: 'text', selector: rest[0] } }
      case 'screenshot':
        return { ok: true, command: { do: 'screenshot', name: rest[0] } }
      default:
        return {
          ok: false,
          error: `usage: prjct qa browser <${BROWSER_PRIMITIVES.join('|')}|install|status> …`,
        }
    }
  })()
  if (!mapped.ok) return { ok: false, text: mapped.error }
  const session = await ensureBrowserSession(projectId)
  if (!session.ok) return { ok: false, text: `Browser unavailable: ${session.error}` }
  const reply = await sendBrowserCommand(session.sockPath, mapped.command)
  if (!reply.ok)
    return {
      ok: false,
      text: `✗ ${verb}: ${reply.error ?? 'failed'}${reply.sample ? `\n${reply.sample}` : ''}`,
    }
  const lines = [`✓ ${verb}`]
  if (reply.url) lines.push(`url: ${reply.url}`)
  if (reply.title) lines.push(`title: ${reply.title}`)
  if (reply.file) lines.push(`screenshot: ${reply.file}`)
  if (reply.text !== undefined) lines.push('', reply.text)
  return { ok: true, text: lines.join('\n') }
}

export function renderBrowserStatus(status: BrowserStatus): string {
  return [
    `- prjct browser: ${status.installed ? '✓ installed' : '✗ not installed'} (${status.home})`,
    `- playwright-core: ${status.playwrightVersion ?? 'missing'} · chromium: ${status.chromium ? '✓' : 'missing'} · session server: ${status.sessionScript ? '✓' : 'missing'}`,
    status.installed
      ? '- drive it: `prjct qa browser goto <url> | fill <sel> <text> | click <sel> | text [sel] | screenshot [name] | close`'
      : '- one-time: `prjct qa browser install` (a few hundred MB under the prjct cache, never in the project)',
  ].join('\n')
}
