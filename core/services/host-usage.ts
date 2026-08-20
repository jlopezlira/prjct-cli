/**
 * Host adapters for inference usage. Each collector returns the same
 * { model, tokensIn, tokensOut } records. Adding a host is one function —
 * the cost report does not change.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserHome } from '../infrastructure/user-home'
import type { InferenceUsage } from './inference-usage'
import { persistInferenceUsage } from './inference-usage'
import {
  parseTranscriptJsonl,
  sumTranscriptUsageByModel,
  type TranscriptJsonlLine,
} from './transcript-jsonl'

export interface HostUsageContext {
  projectPath: string
  home: string
}

export type HostUsageCollector = (ctx: HostUsageContext) => Promise<InferenceUsage[]>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b)
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf-8')) as unknown
}

async function listFiles(root: string, match: (name: string) => boolean): Promise<string[]> {
  const found: string[] = []
  const stack = [root]
  while (stack.length > 0 && found.length < 4_000) {
    const dir = stack.pop()
    if (!dir) break
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && match(entry.name)) found.push(full)
    }
  }
  return found
}

function parseJsonLine(line: string): TranscriptJsonlLine | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return parsed && typeof parsed === 'object' ? (parsed as TranscriptJsonlLine) : null
  } catch {
    return null
  }
}

function findStringField(value: unknown, key: string, depth = 0): string {
  if (depth > 8 || !value || typeof value !== 'object') return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findStringField(item, key, depth + 1)
      if (hit) return hit
    }
    return ''
  }
  const rec = value as Record<string, unknown>
  const direct = str(rec[key])
  if (direct) return direct
  for (const nested of Object.values(rec)) {
    const hit = findStringField(nested, key, depth + 1)
    if (hit) return hit
  }
  return ''
}

function usageFrom(usage: InferenceUsage): InferenceUsage | null {
  const model = usage.model.trim()
  if (!model || model === 'unknown') return null
  if (usage.tokensIn + usage.tokensOut <= 0) return null
  return usage
}

/** Claude Code: ~/.claude/projects/<sanitized-cwd>/*.jsonl */
export async function collectClaudeUsage(ctx: HostUsageContext): Promise<InferenceUsage[]> {
  const sanitized = ctx.projectPath.replace(/[/.]/g, '-')
  const dir = path.join(ctx.home, '.claude', 'projects', sanitized)
  const files = await fs
    .readdir(dir)
    .then((names) => names.filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n)))
    .catch(() => [] as string[])
  const out: InferenceUsage[] = []
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf-8').catch(() => '')
    if (!raw) continue
    const lines = parseTranscriptJsonl(raw)
    const sessionId = path.basename(file, '.jsonl')
    const measuredAt = lines.reduce((latest, line) => {
      const t =
        typeof line.timestamp === 'string'
          ? Date.parse(line.timestamp)
          : typeof line.time === 'number'
            ? line.time
            : Number.NaN
      return Number.isFinite(t) && t > latest ? t : latest
    }, 0)
    for (const [model, tokens] of sumTranscriptUsageByModel(lines)) {
      const row = usageFrom({
        model,
        tokensIn: tokens.tokensIn,
        tokensOut: tokens.tokensOut,
        measuredAt: measuredAt || Date.now(),
        host: 'claude',
        sessionId,
      })
      if (row) out.push(row)
    }
  }
  return out
}

/** Grok Build: ~/.grok/sessions/<urlencoded-cwd>/<session>/summary.json + signals.json */
export async function collectGrokUsage(ctx: HostUsageContext): Promise<InferenceUsage[]> {
  const root = path.join(ctx.home, '.grok', 'sessions', encodeURIComponent(ctx.projectPath))
  const sessions = await fs
    .readdir(root, { withFileTypes: true })
    .then((list) => list.filter((e) => e.isDirectory()).map((e) => e.name))
    .catch(() => [] as string[])
  const out: InferenceUsage[] = []
  for (const sessionId of sessions) {
    const dir = path.join(root, sessionId)
    const [summaryRaw, signalsRaw] = await Promise.all([
      readJson(path.join(dir, 'summary.json')).catch(() => null),
      readJson(path.join(dir, 'signals.json')).catch(() => null),
    ])
    const summary = asRecord(summaryRaw)
    const signals = asRecord(signalsRaw)
    const model = str(summary?.current_model_id) || str(signals?.primaryModelId)
    const tokens = Math.round(num(signals?.totalTokensBeforeCompaction))
    const stamp = Date.parse(
      str(summary?.last_active_at) || str(summary?.updated_at) || str(summary?.created_at)
    )
    const row = usageFrom({
      model,
      tokensIn: tokens,
      tokensOut: 0,
      measuredAt: Number.isFinite(stamp) ? stamp : Date.now(),
      host: 'grok',
      sessionId,
      estimated: true,
    })
    if (row) out.push(row)
  }
  return out
}

/** Codex: ~/.codex/sessions — last cumulative usage, cwd-filtered. */
export async function collectCodexUsage(ctx: HostUsageContext): Promise<InferenceUsage[]> {
  const files = await listFiles(path.join(ctx.home, '.codex', 'sessions'), (n) =>
    n.endsWith('.jsonl')
  )
  const out: InferenceUsage[] = []
  for (const file of files) {
    const peek = await fs.open(file, 'r').catch(() => null)
    if (!peek) continue
    const buf = Buffer.alloc(4_096)
    const { bytesRead } = await peek.read(buf, 0, 4_096, 0)
    await peek.close()
    const firstLine = buf.toString('utf8', 0, bytesRead).split('\n')[0] ?? ''
    const metaPeek = parseJsonLine(firstLine)
    const cwd = str(asRecord(metaPeek?.payload)?.cwd)
    if (!cwd || !samePath(cwd, ctx.projectPath)) continue
    const raw = await fs.readFile(file, 'utf-8').catch(() => '')
    if (!raw) continue
    const parsed = parseTranscriptJsonl(raw)
    const meta = parsed.find((line) => line.type === 'session_meta') ?? metaPeek
    const last = { usage: null as Record<string, unknown> | null, model: '', at: 0 }
    for (const line of parsed) {
      const payload = asRecord(line.payload)
      const info = asRecord(payload?.info)
      const total = asRecord(info?.total_token_usage) ?? asRecord(info?.last_token_usage)
      if (total) last.usage = total
      const model = findStringField(line, 'model')
      if (model && model !== 'openai') last.model = model
      const t = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : Number.NaN
      if (Number.isFinite(t)) last.at = t
    }
    if (!last.usage) continue
    const sessionId = str(asRecord(meta?.payload)?.id) || path.basename(file, '.jsonl')
    const row = usageFrom({
      model: last.model,
      tokensIn: num(last.usage.input_tokens),
      tokensOut: num(last.usage.output_tokens) + num(last.usage.reasoning_output_tokens),
      measuredAt: last.at || Date.now(),
      host: 'codex',
      sessionId,
    })
    if (row) out.push(row)
  }
  return out
}

/** Kimi: session state.json (cwd) plus agent wire.jsonl usage.record */
export async function collectKimiUsage(ctx: HostUsageContext): Promise<InferenceUsage[]> {
  const roots = [
    path.join(ctx.home, '.kimi-code', 'sessions'),
    path.join(ctx.home, '.kimi', 'sessions'),
  ]
  const out: InferenceUsage[] = []
  for (const root of roots) {
    const states = await listFiles(root, (n) => n === 'state.json')
    for (const stateFile of states) {
      const state = asRecord(await readJson(stateFile).catch(() => null))
      const cwd = str(state?.cwd)
      if (!cwd || !samePath(cwd, ctx.projectPath)) continue
      const sessionId = str(state?.id) || path.basename(path.dirname(stateFile))
      const wires = await listFiles(path.dirname(stateFile), (n) => n === 'wire.jsonl')
      const lines: TranscriptJsonlLine[] = []
      for (const wire of wires) {
        const raw = await fs.readFile(wire, 'utf-8').catch(() => '')
        if (raw) lines.push(...parseTranscriptJsonl(raw))
      }
      const measuredAt = lines.reduce((latest, line) => {
        const t = typeof line.time === 'number' ? line.time : Number.NaN
        return Number.isFinite(t) && t > latest ? t : latest
      }, 0)
      for (const [model, tokens] of sumTranscriptUsageByModel(lines)) {
        const row = usageFrom({
          model,
          tokensIn: tokens.tokensIn,
          tokensOut: tokens.tokensOut,
          measuredAt: measuredAt || Date.now(),
          host: 'kimi',
          sessionId,
        })
        if (row) out.push(row)
      }
    }
  }
  return out
}

export const HOST_USAGE_COLLECTORS: readonly HostUsageCollector[] = [
  collectClaudeUsage,
  collectGrokUsage,
  collectCodexUsage,
  collectKimiUsage,
]

export async function collectProjectUsage(
  projectPath: string,
  home = resolveUserHome()
): Promise<InferenceUsage[]> {
  const ctx = { projectPath: path.resolve(projectPath), home }
  const batches = await Promise.all(
    HOST_USAGE_COLLECTORS.map((collect) => collect(ctx).catch(() => [] as InferenceUsage[]))
  )
  return batches.flat()
}

/** Read every host log for this project into token_usage, then cost is table-only. */
export async function ensureHostTokenUsage(
  projectId: string,
  projectPath: string,
  home = resolveUserHome()
): Promise<number> {
  try {
    const usages = await collectProjectUsage(projectPath, home)
    return persistInferenceUsage(projectId, usages)
  } catch {
    return 0
  }
}
