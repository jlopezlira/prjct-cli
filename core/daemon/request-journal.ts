import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { DaemonRequest, DaemonResponse } from '../types/daemon'
import { DAEMON_PATHS } from './protocol'

const StoredOperationSchema = z.object({
  createdAt: z.number().finite(),
  completedAt: z.number().finite().optional(),
  fingerprint: z.string().length(64),
  response: z
    .object({
      id: z.string(),
      success: z.boolean(),
      exitCode: z.number().int(),
      stdout: z.string().optional(),
      stderr: z.string().optional(),
      result: z.unknown().optional(),
      retry: z.boolean().optional(),
    })
    .optional(),
})
const MAX_OPERATION_BYTES = 1024 * 1024

interface JournalEntry {
  createdAt: number
  completedAt?: number
  fingerprint: string
  promise?: Promise<DaemonResponse>
  response?: DaemonResponse
}

export interface RequestJournalOptions {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
  storageDir?: () => string
}

/** Retain running work until it finishes. Expiry is measured from completion. */
export class RequestJournal {
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number
  private readonly entries = new Map<string, JournalEntry>()
  private lastPruneAt = 0

  constructor(private readonly options: RequestJournalOptions = {}) {
    this.ttlMs = options.ttlMs ?? 86_400_000
    this.maxEntries = options.maxEntries ?? 1000
    this.now = options.now ?? Date.now
  }

  private file(id: string): string | null {
    return this.options.storageDir
      ? path.join(
          this.options.storageDir(),
          `${createHash('sha256').update(id).digest('hex')}.json`
        )
      : null
  }

  private persist(id: string, entry: JournalEntry): void {
    const file = this.file(id)
    if (!file) return
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const response =
      entry.response && JSON.stringify(entry.response).length > MAX_OPERATION_BYTES / 2
        ? {
            id,
            success: false,
            exitCode: 1,
            stderr:
              'Operation finished; its result exceeded the resume record budget. Inspect the QA/gauntlet receipt or command artifacts; it will not be replayed.',
          }
        : entry.response
    const body = JSON.stringify({
      createdAt: entry.createdAt,
      completedAt: entry.completedAt,
      fingerprint: entry.fingerprint,
      response,
    })
    const temporary = `${file}.tmp`
    fs.writeFileSync(temporary, body, { mode: 0o600 })
    fs.renameSync(temporary, file)
  }

  private restore(id: string): JournalEntry | undefined {
    const file = this.file(id)
    if (!file || !fs.existsSync(file)) return undefined
    if (fs.statSync(file).size > MAX_OPERATION_BYTES)
      throw new Error('Operation record exceeds read budget; execution refused')
    const saved = StoredOperationSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
    if (saved.completedAt !== undefined && this.now() - saved.completedAt > this.ttlMs) {
      fs.unlinkSync(file)
      return undefined
    }
    return saved
  }

  run(request: DaemonRequest, runner: () => Promise<DaemonResponse>): Promise<DaemonResponse> {
    const now = this.now()
    const persistent =
      request.command !== 'hook' &&
      request.command !== 'daemon' &&
      !request.command.startsWith('__')
    if (persistent && now - this.lastPruneAt >= 60_000) {
      this.prune(now)
      this.lastPruneAt = now
    }
    const id =
      typeof request.options['operation-id'] === 'string'
        ? request.options['operation-id']
        : request.id
    const fingerprint = requestFingerprint(request)
    const failure = (stderr: string): Promise<DaemonResponse> =>
      Promise.resolve({ id: request.id, success: false, exitCode: 1, stderr })
    const existing = this.entries.get(id) ?? (persistent ? this.restore(id) : undefined)
    if (
      existing &&
      (existing.completedAt === undefined || now - existing.completedAt <= this.ttlMs)
    ) {
      if (existing.fingerprint !== fingerprint)
        return failure('Duplicate daemon request id reused with different payload')
      const state = existing.promise
        ? 'running'
        : existing.response
          ? existing.response.success
            ? 'completed'
            : 'failed'
          : 'interrupted'
      if (request.options['operation-status'])
        return Promise.resolve({
          id: request.id,
          success: true,
          exitCode: 0,
          stdout: `Operation ${id}: ${state}`,
          result: { operationId: id, state },
        })
      if (existing.response) return Promise.resolve({ ...existing.response, id: request.id })
      if (existing.promise) return existing.promise.then((r) => ({ ...r, id: request.id }))
      return failure(
        `Operation ${id} was interrupted by daemon restart; inspect its effects before explicitly starting a new operation id.`
      )
    }
    if (request.options['operation-status'] || request.options['operation-id'])
      return failure(
        `Operation ${id} is unknown or expired; nothing executed. Inspect previous effects before starting a new command without --operation-id.`
      )
    if (this.entries.size >= this.maxEntries) {
      const completed = [...this.entries].find(([, entry]) => entry.completedAt !== undefined)
      if (completed) this.entries.delete(completed[0])
      else return failure('Operation capacity reached; wait for running work to finish.')
    }
    const entry: JournalEntry = { createdAt: now, fingerprint }
    // Durable start is written BEFORE execution; inability to record must fail closed.
    if (persistent) {
      const dir = this.options.storageDir?.()
      if (
        dir &&
        fs.existsSync(dir) &&
        fs.readdirSync(dir).filter((name) => name.endsWith('.json')).length >= this.maxEntries
      ) {
        this.prune(now, 1)
        if (fs.readdirSync(dir).filter((name) => name.endsWith('.json')).length >= this.maxEntries)
          return failure(
            'Persisted operation capacity reached; inspect interrupted operations before starting more work.'
          )
      }
      this.persist(id, entry)
    }
    this.entries.set(id, entry)
    const promise = Promise.resolve()
      .then(runner)
      .catch((error) => ({
        id: request.id,
        success: false,
        exitCode: 1,
        stderr: error instanceof Error ? error.message : String(error),
      }))
      .then((response) => {
        entry.response = { ...response }
        entry.completedAt = this.now()
        entry.promise = undefined
        if (persistent) this.persist(id, entry)
        return { ...response }
      })
    entry.promise = promise
    return promise
  }

  clear(): void {
    this.entries.clear()
  }
  size(): number {
    return this.entries.size
  }

  private prune(now: number, reserve = 0): void {
    for (const [id, entry] of this.entries) {
      if (entry.completedAt !== undefined && now - entry.completedAt > this.ttlMs)
        this.entries.delete(id)
    }
    const dir = this.options.storageDir?.()
    if (!dir || !fs.existsSync(dir)) return
    const terminal: Array<{ file: string; time: number }> = []
    for (const name of fs.readdirSync(dir).filter((n) => /^[a-f0-9]{64}\.json$/.test(n))) {
      const file = path.join(dir, name)
      try {
        if (fs.statSync(file).size > MAX_OPERATION_BYTES) continue
        const entry = StoredOperationSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
        if (entry.completedAt !== undefined) terminal.push({ file, time: entry.completedAt })
        else if (
          now - entry.createdAt > this.ttlMs &&
          ![...this.entries.values()].some(
            (running) => running.promise && running.fingerprint === entry.fingerprint
          )
        )
          fs.unlinkSync(file)
      } catch {
        /* preserve corrupt records; never grant replay */
      }
    }
    terminal
      .sort((a, b) => b.time - a.time)
      .forEach((entry, i) => {
        if (now - entry.time > this.ttlMs || i >= this.maxEntries - reserve)
          fs.unlinkSync(entry.file)
      })
  }
}

function requestFingerprint(request: DaemonRequest): string {
  const options = Object.fromEntries(
    Object.entries(request.options).filter(
      ([key]) => key !== 'operation-id' && key !== 'operation-status'
    )
  )
  const cwd = fs.existsSync(request.cwd) ? fs.realpathSync(request.cwd) : path.resolve(request.cwd)
  return createHash('sha256')
    .update(
      stableStringify({
        command: request.command,
        args: request.args,
        options,
        cwd,
        stdin: request.stdin,
        callerSession: request.command === 'hook' ? request.callerSession : undefined,
        hookHost: request.hookHost,
      })
    )
    .digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    )
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const daemonRequestJournal = new RequestJournal({
  storageDir: () => path.join(DAEMON_PATHS.runDir(), 'operations'),
})
