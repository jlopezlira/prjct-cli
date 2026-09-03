/**
 * App lifecycle for probes — start the project's app the way the agent
 * registered it (`qa.app.start`), wait until `baseUrl` answers, run, and kill
 * the whole process tree. No framework, no inference: nothing starts unless
 * the config names a command.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'

export interface QaAppConfig {
  start?: string
  baseUrl?: string
  readyPath?: string
  readyTimeoutMs?: number
}

export interface QaAppHandle {
  pid: number | null
  stop: () => Promise<void>
}

export interface QaAppReady {
  started: boolean
  baseUrl?: string
  readyMs?: number
  error?: string
}

const DEFAULT_READY_TIMEOUT_MS = 60_000
const POLL_MS = 500
const STOP_GRACE_MS = 2_000

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') {
      if (child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref()
      }
    } else if (child.pid !== undefined) {
      process.kill(-child.pid, signal)
    }
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

export function startApp(projectPath: string, start: string): QaAppHandle {
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', start] : ['-c', start]
  const localBin = path.join(projectPath, 'node_modules', '.bin')
  const child = spawn(shell, shellArgs, {
    cwd: projectPath,
    env: { ...process.env, PATH: `${localBin}:${process.env.PATH ?? ''}` },
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  })
  child.on('error', () => undefined)
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return {
    pid: child.pid ?? null,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      killTree(child, 'SIGTERM')
      const grace = new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS))
      await Promise.race([exited, grace])
      if (child.exitCode === null && child.signalCode === null) killTree(child, 'SIGKILL')
    },
  }
}

/** Any HTTP answer means the server is up — a 404 on `/` is still "ready". */
export async function waitReady(
  baseUrl: string,
  readyPath: string = '/',
  timeoutMs: number = DEFAULT_READY_TIMEOUT_MS
): Promise<{ ready: boolean; ms: number }> {
  const startedAt = Date.now()
  const target = (() => {
    try {
      return new URL(readyPath, baseUrl).toString()
    } catch {
      return null
    }
  })()
  if (!target) return { ready: false, ms: 0 }
  while (Date.now() - startedAt < timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(POLL_MS * 4, timeoutMs))
    const up = await fetch(target, { signal: controller.signal, redirect: 'manual' })
      .then(() => true)
      .catch(() => false)
      .finally(() => clearTimeout(timer))
    if (up) return { ready: true, ms: Date.now() - startedAt }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return { ready: false, ms: Date.now() - startedAt }
}

/**
 * Run `fn` with the app up when the config says how to start it; otherwise
 * run against `baseUrl` as-is (the agent may already have it running). The
 * tree is always torn down, even when `fn` throws.
 */
export async function withApp<T>(
  projectPath: string,
  app: QaAppConfig | undefined,
  fn: (ready: QaAppReady) => Promise<T>
): Promise<{ result: T; app: QaAppReady }> {
  const baseUrl = app?.baseUrl
  if (!app?.start) {
    const ready: QaAppReady = { started: false, baseUrl }
    return { result: await fn(ready), app: ready }
  }
  const handle = startApp(projectPath, app.start)
  try {
    const wait = baseUrl
      ? await waitReady(
          baseUrl,
          app.readyPath ?? '/',
          app.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
        )
      : { ready: true, ms: 0 }
    const ready: QaAppReady = wait.ready
      ? { started: true, baseUrl, readyMs: wait.ms }
      : {
          started: true,
          baseUrl,
          readyMs: wait.ms,
          error: `app did not answer at ${baseUrl}${app.readyPath ?? '/'} within ${wait.ms}ms`,
        }
    return { result: await fn(ready), app: ready }
  } finally {
    await handle.stop()
  }
}
