import {
  type ChildProcess,
  exec as execCallback,
  execFile as execFileCallback,
  spawn,
} from 'node:child_process'
import { promisify } from 'node:util'
export const execAsync = promisify(execCallback)
export const execFileAsync = promisify(execFileCallback)

/**
 * Typed process chokepoint — preferred path for subprocesses, required for
 * any call site where a failure must NOT be reclassified as a domain negative
 * (clean tree / not a repo / no matches / stamp unverified).
 *
 * Contract:
 *   - `runProc` never rejects. Outcomes are a `ProcResult` union.
 *   - Precedence: abort/deadline → spawn → overflow → exit.
 *   - Only `exitCodeMeans(result, code≥0)` may treat failure as domain negative.
 *   - Infra (timeout|spawn|overflow) → `GitInfraError` via `gitStdout` / `throwProc`.
 *   - Tree-kill on timeout/overflow (process group / taskkill /T).
 */
export type ProcInfraKind = 'timeout' | 'spawn' | 'overflow'
export type ProcBudgetSource = 'timeout' | 'abort'

export type ProcResult =
  | { ok: true; stdout: string; stderr: string; durationMs: number }
  | {
      ok: false
      kind: 'timeout'
      budgetMs: number
      budgetSource: ProcBudgetSource
      args: string[]
      stdout: string
      stderr: string
      durationMs: number
    }
  | {
      ok: false
      kind: 'spawn'
      cause: Error
      /** OS errno / Node error code when present (ENOENT, EACCES, …). */
      code?: string
      args: string[]
      durationMs: number
    }
  | {
      ok: false
      kind: 'overflow'
      maxBuffer: number
      args: string[]
      stdout: string
      stderr: string
      durationMs: number
    }
  | {
      ok: false
      kind: 'exit'
      code: number
      /** Set when the process died from a signal rather than exit(n). */
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
      args: string[]
      durationMs: number
    }

export interface RunProcOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Per-command whole-run budget. Default 10s. */
  timeoutMs?: number
  /**
   * Caller cancellation. Already-aborted → no spawn. Later abort → timeout
   * with budgetSource:'abort' (checked with the same precedence as deadline).
   */
  signal?: AbortSignal
  /** Combined stdout+stderr cap. Default 1 MiB. Overflow is INFRA, not exit. */
  maxBuffer?: number
  /** Test seam — defaults to node:child_process spawn. */
  spawnFn?: typeof spawn
}

const DEFAULT_BUDGET_MS = 10_000
const DEFAULT_MAX_BUFFER = 1024 * 1024
/** Cap on messages that may leave the process (logs, memory, ship notes). */
export const PROC_ENVELOPE_MAX = 240

/**
 * Kill the whole process tree. `detached: true` (unix) made the child a
 * process-group leader, so a group kill reaches grandchildren that a plain
 * `child.kill()` would orphan.
 */
function killProcessTree(child: ChildProcess): void {
  try {
    if (process.platform === 'win32') {
      if (child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref()
      }
    } else if (child.pid !== undefined) {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    // Group kill failed — direct kill fallback below.
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* already reaped */
  }
}

function joinChunks(chunks: Buffer[], maxLen: number): string {
  if (chunks.length === 0) return ''
  const total = Buffer.concat(chunks)
  const slice = total.length > maxLen ? total.subarray(0, maxLen) : total
  return slice.toString('utf8')
}

function nodeErrorCode(err: Error): string | undefined {
  const code = (err as NodeJS.ErrnoException).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Spawn `cmd` and classify the outcome. Never rejects.
 * Precedence: caller abort / deadline > spawn failure > overflow > exit code.
 */
export function runProc(
  cmd: string,
  args: string[],
  opts: RunProcOptions = {}
): Promise<ProcResult> {
  const budgetMs = opts.timeoutMs ?? DEFAULT_BUDGET_MS
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
  const retainCap = maxBuffer
  const spawnImpl = opts.spawnFn ?? spawn
  const argv = [cmd, ...args]
  const started = Date.now()
  const duration = (): number => Date.now() - started

  // Caller budget already expired — never spawn.
  if (opts.signal?.aborted) {
    return Promise.resolve({
      ok: false,
      kind: 'timeout',
      budgetMs: 0,
      budgetSource: 'abort',
      args: argv,
      stdout: '',
      stderr: '',
      durationMs: 0,
    })
  }

  return new Promise<ProcResult>((resolve) => {
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    const processState = { settled: false, overflow: false, outBytes: 0, errBytes: 0 }

    const child = spawnImpl(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const finish = (result: ProcResult): void => {
      if (processState.settled) return
      processState.settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }

    const partials = (): { stdout: string; stderr: string } => ({
      stdout: joinChunks(outChunks, retainCap),
      stderr: joinChunks(errChunks, retainCap),
    })

    const finishTimeout = (budgetSource: ProcBudgetSource, ms: number): void => {
      killProcessTree(child)
      const { stdout, stderr } = partials()
      finish({
        ok: false,
        kind: 'timeout',
        budgetMs: ms,
        budgetSource,
        args: argv,
        stdout,
        stderr,
        durationMs: duration(),
      })
    }

    const finishOverflow = (): void => {
      killProcessTree(child)
      const { stdout, stderr } = partials()
      // Finish NOW — do not wait for `close`. A process that ignores kill
      // would otherwise hang the Promise until the separate timeout fires.
      finish({
        ok: false,
        kind: 'overflow',
        maxBuffer,
        args: argv,
        stdout,
        stderr: stderr || `maxBuffer exceeded (${maxBuffer} bytes)`,
        durationMs: duration(),
      })
    }

    const timer = setTimeout(() => finishTimeout('timeout', budgetMs), budgetMs)

    const onAbort = (): void => finishTimeout('abort', budgetMs)
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const onChunk = (chunk: Buffer, isErr: boolean): void => {
      if (processState.settled) return
      if (isErr) {
        errChunks.push(chunk)
        processState.errBytes += chunk.length
      } else {
        outChunks.push(chunk)
        processState.outBytes += chunk.length
      }
      if (!processState.overflow && processState.outBytes + processState.errBytes > maxBuffer) {
        processState.overflow = true
        finishOverflow()
      }
    }
    child.stdout?.on('data', (c: Buffer) => onChunk(c, false))
    child.stderr?.on('data', (c: Buffer) => onChunk(c, true))

    child.on('error', (cause: Error) => {
      finish({
        ok: false,
        kind: 'spawn',
        cause,
        code: nodeErrorCode(cause),
        args: argv,
        durationMs: duration(),
      })
    })

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      // Overflow/timeout already settled — ignore the late close.
      if (processState.settled) return
      const { stdout, stderr } = partials()
      if (code === 0) {
        finish({ ok: true, stdout, stderr, durationMs: duration() })
      } else {
        finish({
          ok: false,
          kind: 'exit',
          code: code ?? -1,
          signal,
          stdout,
          stderr: stderr.trim(),
          args: argv,
          durationMs: duration(),
        })
      }
    })
  })
}

/** `git` through the typed chokepoint. `args` are everything after `git`. */
export function runGit(args: string[], opts: RunProcOptions = {}): Promise<ProcResult> {
  return runProc('git', args, opts)
}

/** True when the failure is infrastructure (never a domain negative). */
export function isProcInfra(
  result: ProcResult
): result is Extract<ProcResult, { ok: false; kind: ProcInfraKind }> {
  return (
    !result.ok &&
    (result.kind === 'timeout' || result.kind === 'spawn' || result.kind === 'overflow')
  )
}

/**
 * The ONLY sanctioned way to read an exit code as a domain negative
 * (e.g. `git grep` exit 1 = "no matches"). Requires a real OS exit code ≥ 0.
 */
export function exitCodeMeans(result: ProcResult, code: number): boolean {
  if (!Number.isInteger(code) || code < 0) return false
  return !result.ok && result.kind === 'exit' && result.code === code
}

/** Cap length + collapse whitespace for anything that may leave the process. */
export function sanitizeProcEnvelope(text: string, max = PROC_ENVELOPE_MAX): string {
  const oneLine = text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Soft path scrub: common absolute roots (not a full secret redactor).
  const scrubbed = oneLine
    .replace(/(?:[A-Za-z]:)?(?:\/|\\)(?:Users|home|tmp|var|private|Users)(?:\/|\\)[^\s]*/gi, '…')
    .replace(/\/(?:Users|home|tmp|var|private)\/[^\s]*/gi, '…')
  if (scrubbed.length <= max) return scrubbed
  return `${scrubbed.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Infrastructure failure (timeout / spawn / overflow). Thrown so write/ship
 * paths fail loudly instead of fabricating "clean / not a repo / unverified".
 *
 * `.message` is envelope-capped; `.detail` keeps full text in-process only.
 */
export class GitInfraError extends Error {
  readonly kind: ProcInfraKind
  readonly args: string[]
  readonly detail: string
  readonly budgetSource?: ProcBudgetSource

  constructor(
    kind: ProcInfraKind,
    args: string[],
    detail: string,
    extras?: { budgetSource?: ProcBudgetSource }
  ) {
    super(sanitizeProcEnvelope(`git ${kind} failure (${args.join(' ')}): ${detail}`))
    this.name = 'GitInfraError'
    this.kind = kind
    this.args = args
    this.detail = detail
    this.budgetSource = extras?.budgetSource
  }
}

/** Build a GitInfraError unless `result` is ok or a typed exit (then null). */
export function gitInfraErrorOf(result: ProcResult): GitInfraError | null {
  if (result.ok || result.kind === 'exit') return null
  if (result.kind === 'timeout') {
    return new GitInfraError(
      'timeout',
      result.args,
      result.budgetSource === 'abort'
        ? 'aborted by caller signal'
        : `exceeded ${result.budgetMs}ms`,
      { budgetSource: result.budgetSource }
    )
  }
  if (result.kind === 'overflow') {
    return new GitInfraError('overflow', result.args, `maxBuffer ${result.maxBuffer} bytes`)
  }
  return new GitInfraError('spawn', result.args, result.cause.message)
}

/**
 * Error for any failed ProcResult (exit included). Null only when `result.ok`.
 * Prefer `throwProc` at call sites — it never throws null.
 */
export function procErrorOf(result: ProcResult): Error | null {
  if (result.ok) return null
  if (result.kind === 'exit') {
    const detail = result.stderr ? ` — ${sanitizeProcEnvelope(result.stderr, 120)}` : ''
    const signal = result.signal ? ` signal=${result.signal}` : ''
    return new Error(
      sanitizeProcEnvelope(
        `command failed (exit ${result.code}${signal}): ${result.args.join(' ')}${detail}`
      )
    )
  }
  return gitInfraErrorOf(result)
}

/**
 * Throw a non-null Error for a failed ProcResult. Use after handling the
 * domain exit codes you care about via `exitCodeMeans`. Never throws null.
 */
export function throwProc(result: ProcResult): never {
  if (result.ok) {
    throw new Error('throwProc called on ok result')
  }
  throw procErrorOf(result) ?? new Error(`process failed (${result.kind})`)
}

/**
 * Exhaustive consumer dispatch — forces every kind to be handled so infra
 * cannot silently fall through into a domain branch.
 */
export function matchProc<T>(
  result: ProcResult,
  handlers: {
    ok: (r: Extract<ProcResult, { ok: true }>) => T
    exit: (r: Extract<ProcResult, { kind: 'exit' }>) => T
    timeout: (r: Extract<ProcResult, { kind: 'timeout' }>) => T
    spawn: (r: Extract<ProcResult, { kind: 'spawn' }>) => T
    overflow: (r: Extract<ProcResult, { kind: 'overflow' }>) => T
  }
): T {
  if (result.ok) return handlers.ok(result)
  switch (result.kind) {
    case 'exit':
      return handlers.exit(result)
    case 'timeout':
      return handlers.timeout(result)
    case 'spawn':
      return handlers.spawn(result)
    case 'overflow':
      return handlers.overflow(result)
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}

/**
 * Trimmed stdout on success; `null` on typed exit (domain negative).
 * Timeout / spawn / overflow throw `GitInfraError` — never collapse to null.
 */
export async function gitStdout(
  cwd: string,
  args: string[],
  opts: RunProcOptions = {}
): Promise<string | null> {
  const result = await runGit(args, { ...opts, cwd })
  if (result.ok) return result.stdout.trim()
  const infra = gitInfraErrorOf(result)
  if (infra) throw infra
  return null
}
