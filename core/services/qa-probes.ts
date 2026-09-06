/**
 * Universal probes — verification prjct executes itself with nothing installed
 * in the client project: `http` (fetch), `cli` (a shell), `file` (fs).
 * `browser` runs on prjct's own headless browser (`qa-browser.ts`, installed
 * once under the prjct cache); until that is installed it reports
 * `unavailable` so the flow falls to the blind QA subagent.
 *
 * `unavailable` = could not run HERE (no app reachable, no tool). It never
 * fails a gate and never counts as verified — a receipt that hides what it
 * skipped is a fake green.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  QaBrowserProbe,
  QaCliProbe,
  QaFileProbe,
  QaHttpProbe,
  QaProbe,
  QaProbeResult,
} from '../schemas/qa'
import { matchProc, runProc } from '../utils/exec'

export type ProbeResult = Omit<QaProbeResult, 'flowId'>

const HTTP_TIMEOUT_MS = 15_000
const CLI_TIMEOUT_MS = 120_000
const CLI_MAX_BUFFER = 4 * 1024 * 1024
const DETAIL_TAIL = 300
const EXIT_COMMAND_NOT_FOUND = 127

export interface ProbeContext {
  projectPath: string
  baseUrl: string | null
  /** Needed by `browser` probes (one session per project). */
  projectId?: string
}

function jsonPathValue(root: unknown, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, root)
}

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i

/**
 * An explicit probe `url` may only point at the app under test: same origin
 * as `qa.app.baseUrl`, or loopback when no baseUrl is registered. Probes are
 * agent-registered data, so an arbitrary host here is an SSRF from the QA
 * runner — cloud metadata endpoints included.
 */
export function httpProbeTargetAllowed(target: string, baseUrl: string | null): boolean {
  const url = (() => {
    try {
      return new URL(target)
    } catch {
      return null
    }
  })()
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false
  if (baseUrl) {
    try {
      if (new URL(baseUrl).origin === url.origin) return true
    } catch {
      // unparsable baseUrl: fall through to the loopback rule
    }
  }
  return LOOPBACK_HOST.test(url.hostname)
}

export async function runHttpProbe(
  probe: QaHttpProbe,
  baseUrl: string | null,
  opts: { timeoutMs?: number } = {}
): Promise<ProbeResult> {
  const startedAt = Date.now()
  const target = (() => {
    if (probe.url) return probe.url
    if (!baseUrl) return null
    try {
      return new URL(probe.path ?? '/', baseUrl).toString()
    } catch {
      return null
    }
  })()
  if (target && probe.url && !httpProbeTargetAllowed(target, baseUrl)) {
    return {
      type: 'http',
      ok: false,
      outcome: 'blocked',
      unavailable: false,
      durationMs: 0,
      detail: `probe url ${target} is outside the app under test (${baseUrl ?? 'no baseUrl'}); only qa.app.baseUrl or loopback origins are probed`,
    }
  }
  if (!target) {
    return {
      type: 'http',
      ok: false,
      outcome: 'unavailable',
      unavailable: true,
      durationMs: 0,
      detail: 'no baseUrl — register it: prjct qa set app.baseUrl <url>',
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? HTTP_TIMEOUT_MS)
  try {
    const response = await fetch(target, {
      method: probe.method,
      headers: probe.headers,
      body: probe.body,
      signal: controller.signal,
      redirect: 'manual',
    })
    const body = await response.text()
    const mismatches: string[] = []
    const expectedStatus = probe.expect.status
    const statusOk =
      expectedStatus !== undefined ? response.status === expectedStatus : response.status < 300
    if (!statusOk) {
      mismatches.push(`status ${response.status} (expected ${expectedStatus ?? '2xx'})`)
    }
    for (const needle of probe.expect.bodyIncludes) {
      if (!body.includes(needle)) mismatches.push(`body lacks "${needle}"`)
    }
    if (probe.expect.jsonPath) {
      const parsed = (() => {
        try {
          return JSON.parse(body) as unknown
        } catch {
          return undefined
        }
      })()
      if (parsed === undefined) mismatches.push('body is not JSON')
      else {
        for (const [dotPath, expected] of Object.entries(probe.expect.jsonPath)) {
          const actual = jsonPathValue(parsed, dotPath)
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            mismatches.push(
              `${dotPath}=${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`
            )
          }
        }
      }
    }
    const durationMs = Date.now() - startedAt
    if (mismatches.length === 0) return { type: 'http', ok: true, outcome: 'ok', durationMs }
    return {
      type: 'http',
      ok: false,
      outcome: 'mismatch',
      durationMs,
      detail:
        `${probe.method} ${target}: ${mismatches.join('; ')}\n${body.slice(-DETAIL_TAIL)}`.trim(),
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) {
      return {
        type: 'http',
        ok: false,
        outcome: 'timeout',
        durationMs,
        detail: `${target} timed out`,
      }
    }
    // Connection refused / DNS / reset: the app is not reachable here.
    return {
      type: 'http',
      ok: false,
      outcome: 'unreachable',
      unavailable: true,
      durationMs,
      detail: `${target}: ${message} — is the app running? (prjct qa set app.start "<cmd>")`,
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function runCliProbe(
  projectPath: string,
  probe: QaCliProbe,
  opts: { timeoutMs?: number } = {}
): Promise<ProbeResult> {
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  const shellArgs =
    process.platform === 'win32' ? ['/d', '/s', '/c', probe.command] : ['-c', probe.command]
  const localBin = path.join(projectPath, 'node_modules', '.bin')
  const result = await runProc(shell, shellArgs, {
    cwd: projectPath,
    env: { ...process.env, PATH: `${localBin}:${process.env.PATH ?? ''}` },
    timeoutMs: opts.timeoutMs ?? CLI_TIMEOUT_MS,
    maxBuffer: CLI_MAX_BUFFER,
  })
  const evaluate = (
    code: number | null,
    stdout: string,
    stderr: string,
    durationMs: number
  ): ProbeResult => {
    const mismatches: string[] = []
    if (code !== probe.expect.exitCode) {
      mismatches.push(`exit ${code ?? 'signal'} (expected ${probe.expect.exitCode})`)
    }
    if (probe.expect.stdoutMatches !== undefined) {
      const re = (() => {
        try {
          return new RegExp(probe.expect.stdoutMatches ?? '')
        } catch {
          return null
        }
      })()
      if (!re) mismatches.push('invalid stdoutMatches regex')
      else if (!re.test(stdout)) mismatches.push(`stdout !~ /${probe.expect.stdoutMatches}/`)
    }
    if (probe.expect.stderrEmpty && stderr.trim().length > 0) mismatches.push('stderr not empty')
    if (mismatches.length === 0) return { type: 'cli', ok: true, outcome: 'ok', durationMs }
    const tail = `${stdout}\n${stderr}`.trim().slice(-DETAIL_TAIL)
    return {
      type: 'cli',
      ok: false,
      outcome: code !== probe.expect.exitCode ? `exit:${code ?? 'signal'}` : 'mismatch',
      durationMs,
      detail: `${probe.command}: ${mismatches.join('; ')}\n${tail}`.trim(),
    }
  }
  return matchProc<ProbeResult>(result, {
    ok: (r) => evaluate(0, r.stdout, r.stderr, r.durationMs),
    exit: (r) =>
      r.code === EXIT_COMMAND_NOT_FOUND
        ? {
            type: 'cli',
            ok: false,
            outcome: 'unavailable',
            unavailable: true,
            durationMs: r.durationMs,
            detail: `${probe.command}: command not found`,
          }
        : evaluate(r.code, r.stdout, r.stderr, r.durationMs),
    timeout: (r) => ({
      type: 'cli',
      ok: false,
      outcome: 'timeout',
      durationMs: r.durationMs,
      detail: `${probe.command}: timed out after ${r.budgetMs}ms`,
    }),
    spawn: (r) => ({
      type: 'cli',
      ok: false,
      outcome: 'unavailable',
      unavailable: true,
      durationMs: r.durationMs,
      detail: r.cause.message,
    }),
    overflow: (r) => ({
      type: 'cli',
      ok: false,
      outcome: 'overflow',
      durationMs: r.durationMs,
      detail: `output exceeded ${r.maxBuffer} bytes`,
    }),
  })
}

export async function runFileProbe(projectPath: string, probe: QaFileProbe): Promise<ProbeResult> {
  const startedAt = Date.now()
  const target = path.resolve(projectPath, probe.path)
  const content = await fs.readFile(target, 'utf8').catch(() => null)
  const exists = content !== null
  const mismatches: string[] = []
  if (exists !== probe.expect.exists) {
    mismatches.push(exists ? 'exists (expected absent)' : 'missing (expected present)')
  }
  if (exists && content !== null) {
    for (const needle of probe.expect.includes) {
      if (!content.includes(needle)) mismatches.push(`lacks "${needle}"`)
    }
  }
  const durationMs = Date.now() - startedAt
  if (mismatches.length === 0) return { type: 'file', ok: true, outcome: 'ok', durationMs }
  return {
    type: 'file',
    ok: false,
    outcome: 'mismatch',
    durationMs,
    detail: `${probe.path}: ${mismatches.join('; ')}`,
  }
}

/** Declarative steps on prjct's own headless browser; `unavailable` until installed. */
export async function runBrowserProbe(
  probe: QaBrowserProbe,
  ctx: { projectId?: string; baseUrl: string | null }
): Promise<ProbeResult> {
  const startedAt = Date.now()
  if (!ctx.projectId) {
    return {
      type: 'browser',
      ok: false,
      outcome: 'unavailable',
      unavailable: true,
      durationMs: 0,
      detail: 'browser probes need a project (no projectId in this run)',
    }
  }
  const { runBrowserSteps } = await import('./qa-browser')
  const run = await runBrowserSteps(ctx.projectId, probe.steps, ctx.baseUrl)
  const shots = run.screenshots.length ? `\nscreenshots: ${run.screenshots.join(', ')}` : ''
  return {
    type: 'browser',
    ok: run.ok,
    outcome: run.outcome,
    unavailable: run.unavailable,
    durationMs: Date.now() - startedAt,
    detail: run.ok ? (shots ? shots.trim() : undefined) : `${run.detail ?? 'failed'}${shots}`,
  }
}

export async function runProbe(probe: QaProbe, ctx: ProbeContext): Promise<ProbeResult> {
  switch (probe.type) {
    case 'http':
      return runHttpProbe(probe, ctx.baseUrl)
    case 'cli':
      return runCliProbe(ctx.projectPath, probe)
    case 'file':
      return runFileProbe(ctx.projectPath, probe)
    case 'browser':
      return runBrowserProbe(probe, { projectId: ctx.projectId, baseUrl: ctx.baseUrl })
  }
}
