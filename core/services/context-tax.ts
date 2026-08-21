/**
 * Context tax — what a host re-sends on every API call, measured from the
 * host's OWN session logs, plus session-size stats. Real-log attribution
 * (2026-08-19) showed prjct at ~1% of session input while host-native tool
 * catalogs and marathon sessions (60M+ cumulative tokens) dominate window
 * burn — this surfaces those numbers where the user already looks: doctor.
 *
 * Critical catalog/session burn is a health error, not an informational
 * warning. Collection stays fail-soft and read-only; doctor --fix owns the
 * separate repair pass and must verify afterward.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { CheckResult } from '../types/services/extracted'
import { getCodexConfigTomlPath } from '../utils/codex-mcp'
import { getKimiMcpConfigPaths } from '../utils/kimi-mcp'

const CHARS_PER_TOKEN = 4
/** Flag a single MCP server whose catalog costs more than this per request. */
export const SERVER_FLAG_TOKENS = 2_000
/** A catalog this large is unhealthy even when host-native tools dominate. */
const KIMI_CATALOG_CRITICAL_TOKENS = 10_000
/** Flag sessions past either bound as marathons (cumulative window burn). */
const MARATHON_TOKENS = 10_000_000
const MARATHON_TURNS = 150
/** Newest session files inspected per host — enough signal, bounded I/O. */
const SESSIONS_SCANNED = 3

export interface ServerCatalogCost {
  server: string
  chars: number
  approxTokens: number
}

export interface SessionSizeStat {
  label: string
  turns: number
  /** Cumulative tokens the session has re-paid (input incl. cached + output). */
  totalTokens: number
}

export interface HostContextTax {
  host: 'kimi' | 'codex'
  servers: ServerCatalogCost[]
  totalCatalogChars: number
  sessions: SessionSizeStat[]
  marathonSessions: number
}

async function newestFiles(root: string, fileName: string | null, limit: number) {
  const found: Array<{ file: string; mtimeMs: number; size: number }> = []
  const stack = [root]
  const pop = () => stack.pop()
  for (const _ of Array.from({ length: 50_000 })) {
    const dir = pop()
    if (!dir) break
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && (fileName ? e.name === fileName : e.name.endsWith('.jsonl'))) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) found.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size })
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
}

function serverOfToolName(name: string): string {
  const m = /^mcp__(.+?)__/.exec(name)
  return m ? `mcp:${m[1]}` : 'native'
}

/** Kimi: catalog from the last llm.tools_snapshot; session size from usage.record. */
async function collectKimiTax(): Promise<HostContextTax | null> {
  const homes = getKimiMcpConfigPaths().map((p) => path.dirname(p))
  const sessionRoots = homes.map((h) => path.join(h, 'sessions'))
  const files = (
    await Promise.all(sessionRoots.map((r) => newestFiles(r, 'wire.jsonl', SESSIONS_SCANNED)))
  )
    .flat()
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, SESSIONS_SCANNED)
  if (files.length === 0) return null

  const perServer = new Map<string, number>()
  const sessions: SessionSizeStat[] = []
  for (const f of files) {
    const raw = await fs.readFile(f.file, 'utf-8').catch(() => '')
    if (!raw) continue
    const totals = { turns: 0, tokens: 0 }
    const lastSnapshot = { chars: new Map<string, number>() }
    for (const line of raw.split('\n')) {
      if (line.includes('"llm.tools_snapshot"')) {
        try {
          const evt = JSON.parse(line) as { tools?: Array<{ name?: string }> }
          if (Array.isArray(evt.tools)) {
            const snap = new Map<string, number>()
            for (const t of evt.tools) {
              const server = serverOfToolName(String(t.name ?? ''))
              snap.set(server, (snap.get(server) ?? 0) + JSON.stringify(t).length)
            }
            lastSnapshot.chars = snap
          }
        } catch {
          /* skip malformed line */
        }
      } else if (line.includes('"usage.record"')) {
        try {
          const evt = JSON.parse(line) as {
            usageScope?: string
            usage?: Record<string, number>
          }
          if ((evt.usageScope ?? 'turn') === 'turn' && evt.usage) {
            totals.turns++
            totals.tokens +=
              (evt.usage.inputOther ?? 0) +
              (evt.usage.inputCacheRead ?? 0) +
              (evt.usage.inputCacheCreation ?? 0) +
              (evt.usage.output ?? 0)
          }
        } catch {
          /* skip malformed line */
        }
      }
    }
    for (const [server, chars] of lastSnapshot.chars) {
      perServer.set(server, Math.max(perServer.get(server) ?? 0, chars))
    }
    if (totals.turns > 0) {
      sessions.push({
        label: path.basename(path.dirname(f.file)),
        turns: totals.turns,
        totalTokens: totals.tokens,
      })
    }
  }
  if (perServer.size === 0 && sessions.length === 0) return null
  const servers = [...perServer.entries()]
    .map(([server, chars]) => ({
      server,
      chars,
      approxTokens: Math.round(chars / CHARS_PER_TOKEN),
    }))
    .sort((a, b) => b.chars - a.chars)
  return {
    host: 'kimi',
    servers,
    totalCatalogChars: servers.reduce((s, x) => s + x.chars, 0),
    sessions,
    marathonSessions: sessions.filter(
      (s) => s.totalTokens > MARATHON_TOKENS || s.turns > MARATHON_TURNS
    ).length,
  }
}

/** Codex: session size from rollout token_count; catalog is not logged, so
 *  only the configured server list is reported (names, no sizes). */
async function collectCodexTax(): Promise<HostContextTax | null> {
  const home = path.dirname(getCodexConfigTomlPath())
  const files = await newestFiles(path.join(home, 'sessions'), null, SESSIONS_SCANNED)
  const config = await fs.readFile(getCodexConfigTomlPath(), 'utf-8').catch(() => '')
  const servers = [...config.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)].map((m) => ({
    server: `mcp:${m[1]}`,
    chars: 0,
    approxTokens: 0,
  }))
  if (files.length === 0 && servers.length === 0) return null

  const sessions: SessionSizeStat[] = []
  for (const f of files) {
    const raw = await fs.readFile(f.file, 'utf-8').catch(() => '')
    if (!raw) continue
    const totals = { turns: 0, tokens: 0 }
    for (const line of raw.split('\n')) {
      if (!line.includes('token_count')) continue
      try {
        const evt = JSON.parse(line) as {
          payload?: { type?: string; info?: { last_token_usage?: Record<string, number> } }
        }
        const last = evt.payload?.type === 'token_count' ? evt.payload.info?.last_token_usage : null
        if (last) {
          totals.turns++
          totals.tokens +=
            (last.input_tokens ?? 0) +
            (last.output_tokens ?? 0) +
            (last.reasoning_output_tokens ?? 0)
        }
      } catch {
        /* skip malformed line */
      }
    }
    if (totals.turns > 0) {
      sessions.push({
        label: path.basename(f.file).slice(8, 27),
        turns: totals.turns,
        totalTokens: totals.tokens,
      })
    }
  }
  return {
    host: 'codex',
    servers,
    totalCatalogChars: 0,
    sessions,
    marathonSessions: sessions.filter(
      (s) => s.totalTokens > MARATHON_TOKENS || s.turns > MARATHON_TURNS
    ).length,
  }
}

export async function collectContextTax(): Promise<HostContextTax[]> {
  const results = await Promise.all([
    collectKimiTax().catch(() => null),
    collectCodexTax().catch(() => null),
  ])
  return results.filter((r): r is HostContextTax => Boolean(r))
}

const fmtTok = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`

/** Doctor-shaped checks: catalog cost per host + marathon-session signal. */
export function contextTaxChecks(taxes: HostContextTax[]): CheckResult[] {
  const checks: CheckResult[] = []
  for (const tax of taxes) {
    if (tax.host === 'kimi' && tax.servers.length > 0) {
      const flagged = tax.servers.filter(
        (s) => s.server !== 'native' && s.approxTokens > SERVER_FLAG_TOKENS
      )
      const top = tax.servers
        .slice(0, 3)
        .map((s) => `${s.server}=${s.approxTokens || '?'}tok`)
        .join(' · ')
      const totalTokens = Math.round(tax.totalCatalogChars / CHARS_PER_TOKEN)
      const isCritical = flagged.length > 0 || totalTokens > KIMI_CATALOG_CRITICAL_TOKENS
      // Do NOT point at `prjct doctor --fix`. No heal action disables an MCP
      // entry (see doctor-heal.ts), and these servers are observed from Kimi's
      // session wire log rather than read from a file prjct manages — a Kimi
      // config can carry no MCP entries at all and still show a heavy catalog.
      // The old text sent the reader to run `--fix`, which changed nothing and
      // re-printed the same ACTION REQUIRED: an instruction that cannot be
      // satisfied, which an agent will retry instead of acting on.
      const action =
        flagged.length > 0
          ? `ACTION: remove or disable ${flagged.map((s) => s.server.replace('mcp:', '')).join(', ')} where Kimi registers it, then reload Kimi or start a new session. prjct cannot disable it for you — it is not in a prjct-managed config.`
          : `ACTION: host-native tools dominate this catalog; configure a project-appropriate lean Kimi tool allowlist, then reload or start a new session.`
      checks.push({
        name: 'kimi catalog',
        status: isCritical ? 'error' : 'ok',
        message: `≈${totalTokens.toLocaleString()} tok re-sent/request — ${top}${flagged.length > 0 ? ` · heavy: ${flagged.map((s) => s.server).join(', ')}` : ''}${isCritical ? ` · ${action}` : ''}`,
      })
    }
    if (tax.host === 'codex' && tax.servers.length > 0) {
      checks.push({
        name: 'codex servers',
        status: 'ok',
        message: `${tax.servers.length} MCP server(s): ${tax.servers.map((s) => s.server.replace('mcp:', '')).join(', ')} (catalog not logged by Codex)`,
      })
    }
    if (tax.sessions.length > 0) {
      const biggest = [...tax.sessions].sort((a, b) => b.totalTokens - a.totalTokens)[0]!
      checks.push({
        name: `${tax.host} sessions`,
        status: tax.marathonSessions > 0 ? 'error' : 'ok',
        message:
          tax.marathonSessions > 0
            ? `${tax.marathonSessions} marathon session(s) — biggest ${fmtTok(biggest.totalTokens)} tok cumulative over ${biggest.turns} turns. Long sessions re-pay their whole context every turn. ACTION REQUIRED: run \`prjct land --md\`, start a fresh host session, then run \`prjct prime --md\`; doctor cannot shrink an already-open host context safely.`
            : `biggest recent session ${fmtTok(biggest.totalTokens)} tok / ${biggest.turns} turns`,
      })
    }
  }
  return checks
}
