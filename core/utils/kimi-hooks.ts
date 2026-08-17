/**
 * Kimi Code CLI hooks installer — maps PRJCT_HOOKS into
 * `~/.kimi-code/config.toml` as `[[hooks]]` array-of-tables entries.
 *
 * Kimi's hook contract (kimi.com/code/docs …/customization/hooks.html):
 *   - only four fields per entry: event, matcher (regex), command, timeout
 *     (seconds, 1-600). Extra fields make the WHOLE config fail to load, so
 *     unlike Claude's settings.json we cannot tag entries with a
 *     `_prjctManaged` key.
 *   - managed-entry identity instead rides on a `# prjct-managed` comment
 *     line immediately above each `[[hooks]]` block we write (comments are
 *     free in TOML), with a command-substring match (`prjct hook …` /
 *     `PRJCT_HOOK_HOST=kimi` / `hook-fast`) as the fallback for entries the
 *     user pasted by hand.
 *
 * The file is patched TEXTUALLY — never re-serialized — so user comments,
 * key order, and other tools' managed blocks (e.g. Orca's
 * `orca-managed-kimi-hooks`) survive byte-identical. Install strips our
 * previous entries and re-appends the canonical set, which gives refresh +
 * prune-of-retired-subcommands in one idempotent pass.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from '../infrastructure/user-home'
import { hookCommandChain } from '../services/hook-command'
import { HOOK_TIMEOUT_SECONDS, PRJCT_HOOKS } from '../services/settings-installer'
import { writeConfigIfChanged } from './mcp-config'

const MANAGED_COMMENT = '# prjct-managed'
const HOOKS_HEADER = '[[hooks]]'

export function getKimiHooksConfigPath(): string {
  if (process.env.PRJCT_TEST_MODE === '1') {
    return path.join(resolveUserPath('.prjct-tests'), 'kimi-code', 'config.toml')
  }
  return resolveUserPath('.kimi-code', 'config.toml')
}

export interface KimiHookMap {
  /** Kimi event name (same PascalCase names Claude uses). */
  event: string
  /** Regex over the event target (tool name for Pre/PostToolUse). */
  matcher?: string
  subcommand: string
}

/**
 * Claude PRJCT_HOOKS → Kimi events. Kimi's matcher is a plain regex (docs
 * example: `matcher = "task\\.completed"`), so Claude's ERE alternations
 * (`Edit|Write`) carry over verbatim — no pipe escaping. `CwdChanged` has no
 * Kimi equivalent; Kimi payloads carry `cwd` on every event instead.
 */
export function kimiHookMaps(): KimiHookMap[] {
  const maps: KimiHookMap[] = []
  for (const spec of PRJCT_HOOKS) {
    if (spec.event === 'CwdChanged') continue
    if (
      spec.event === 'SessionStart' ||
      spec.event === 'UserPromptSubmit' ||
      spec.event === 'Stop' ||
      spec.event === 'SubagentStart' ||
      spec.event === 'SubagentStop' ||
      spec.event === 'Notification'
    ) {
      maps.push({ event: spec.event, subcommand: spec.subcommand })
    } else if (spec.event === 'PreToolUse' || spec.event === 'PostToolUse') {
      maps.push({ event: spec.event, matcher: spec.matcher, subcommand: spec.subcommand })
    }
  }
  return maps
}

/**
 * Shared native/direct/portable chain with the host env inlined in EVERY
 * stage (see core/services/hook-command.ts). The native hook-fast binary
 * DOES forward PRJCT_HOOK_HOST to the daemon (native/hook-fast.c reads the
 * env and sends it as `hookHost` on the wire), so Kimi output adaptation
 * works on the native path exactly as on the portable one.
 */
function hookCommand(subcommand: string): string {
  return hookCommandChain(subcommand, 'PRJCT_HOOK_HOST=kimi')
}

interface KimiHookEntry {
  event?: string
  matcher?: string
  command?: string
  timeout?: number
}

interface ParsedHooksToml {
  /** Lines with every prjct-managed entry (and its marker comment) removed. */
  stripped: string
  /** The managed entries that were found (before removal). */
  managed: KimiHookEntry[]
}

function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function parseTomlBasicString(raw: string): string {
  const m = raw.match(/^"((?:[^"\\]|\\.)*)"/)
  if (!m) return raw
  return m[1].replace(/\\(["\\])/g, '$1')
}

/** Parse the key/value lines of one `[[hooks]]` entry body. */
function parseEntry(bodyLines: string[]): KimiHookEntry {
  const entry: Record<string, unknown> = {}
  for (const line of bodyLines) {
    const m = line.trim().match(/^([a-zA-Z_]+)\s*=\s*(.+)$/)
    if (!m) continue
    const [, key, raw] = m
    if (raw.startsWith('"')) entry[key] = parseTomlBasicString(raw)
    else if (/^\d+$/.test(raw)) entry[key] = Number.parseInt(raw, 10)
  }
  return entry as KimiHookEntry
}

function isPrjctCommand(command: string): boolean {
  return (
    /PRJCT_HOOK_HOST=kimi/.test(command) ||
    /(^|\/|\s)prjct\s+hook\s+\S+/.test(command) ||
    /hook-fast/.test(command)
  )
}

/** Subcommand of a hook command string, e.g. `… prjct hook pre-edit …` → `pre-edit`. */
function subcommandOf(command: string | undefined): string | null {
  const m = command?.match(/\bhook\s+(\S+)/)
  return m ? m[1] : null
}

/**
 * Locate every `[[hooks]]` entry in the file and mark the prjct-managed ones.
 * An entry spans its header line plus the body up to the next table header;
 * trailing blank/comment lines belong to the inter-entry gap and are kept.
 * A `# prjct-managed` comment DIRECTLY above the header (no blank line
 * between) marks the entry; the command match is the marker-less fallback.
 */
function parseHooksToml(content: string): ParsedHooksToml {
  const lines = content.split('\n')
  const isHeader = (line: string) => line.trim().startsWith('[')
  const headerIndexes = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.trim() === HOOKS_HEADER)
    .map(({ i }) => i)

  const stripIndexes = new Set<number>()
  const managed: KimiHookEntry[] = []

  for (const h of headerIndexes) {
    const nextHeader = lines.findIndex((line, i) => i > h && isHeader(line))
    const end = nextHeader === -1 ? lines.length : nextHeader
    const body = lines.slice(h + 1, end)
    // Trailing blank/comment lines are gap, not entry body.
    const trailingGap = [...body].reverse().findIndex((line) => {
      const t = line.trim()
      return t !== '' && !t.startsWith('#')
    })
    const bodyContent = trailingGap === -1 ? [] : body.slice(0, body.length - trailingGap)
    const entry = parseEntry(bodyContent)
    const hasMarker = h > 0 && lines[h - 1].trim() === MANAGED_COMMENT
    if (!hasMarker && !isPrjctCommand(entry.command ?? '')) continue

    managed.push(entry)
    if (hasMarker) stripIndexes.add(h - 1)
    stripIndexes.add(h)
    for (const k of bodyContent.keys()) stripIndexes.add(h + 1 + k)
  }

  return {
    stripped: lines.filter((_, i) => !stripIndexes.has(i)).join('\n'),
    managed,
  }
}

function entryFor(map: KimiHookMap): KimiHookEntry {
  return {
    event: map.event,
    matcher: map.matcher,
    command: hookCommand(map.subcommand),
    timeout: HOOK_TIMEOUT_SECONDS,
  }
}

function entriesEqual(a: KimiHookEntry, b: KimiHookEntry): boolean {
  return (
    (a.event ?? '') === (b.event ?? '') &&
    (a.matcher ?? '') === (b.matcher ?? '') &&
    (a.command ?? '') === (b.command ?? '') &&
    (a.timeout ?? 0) === (b.timeout ?? 0)
  )
}

function renderEntry(entry: KimiHookEntry): string {
  return [
    MANAGED_COMMENT,
    HOOKS_HEADER,
    `event = ${tomlBasicString(entry.event ?? '')}`,
    ...(entry.matcher ? [`matcher = ${tomlBasicString(entry.matcher)}`] : []),
    `command = ${tomlBasicString(entry.command ?? '')}`,
    `timeout = ${entry.timeout ?? HOOK_TIMEOUT_SECONDS}`,
  ].join('\n')
}

export interface KimiHooksInstallResult {
  configPath: string
  hooksWritten: number
  alreadyPresent: number
  /** Managed entries removed because their subcommand left PRJCT_HOOKS. */
  hooksPruned: number
  changed: boolean
}

/**
 * Idempotently install prjct's hook stack into `~/.kimi-code/config.toml`.
 * The previous managed block is replaced wholesale, so retired subcommands
 * are pruned and changed commands refreshed; user entries and other tools'
 * blocks (Orca) stay byte-identical. Kimi reads `[[hooks]]` at session
 * start — entries apply on the NEXT session (or after `/reload`).
 */
export async function installKimiHooks(
  configPath = getKimiHooksConfigPath()
): Promise<KimiHooksInstallResult> {
  const existing = await fs.readFile(configPath, 'utf-8').catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  })

  const desired = kimiHookMaps().map(entryFor)
  const parsed = parseHooksToml(existing)
  const validSubcommands = new Set(kimiHookMaps().map((map) => map.subcommand))

  const written = desired.filter((d) => !parsed.managed.some((m) => entriesEqual(m, d))).length
  const hooksPruned = parsed.managed.filter((m) => {
    const sub = subcommandOf(m.command)
    return sub !== null && !validSubcommands.has(sub)
  }).length

  const block = desired.map(renderEntry).join('\n\n')
  const base = parsed.stripped.replace(/\s+$/, '')
  const next = base ? `${base}\n\n${block}\n` : `${block}\n`
  const { changed } = await writeConfigIfChanged(configPath, existing, next)

  return {
    configPath,
    hooksWritten: changed ? written : 0,
    alreadyPresent: changed ? desired.length - written : desired.length,
    hooksPruned,
    changed,
  }
}

export interface KimiHooksUninstallResult {
  configPath: string
  hooksRemoved: number
}

/** Strip every prjct-managed `[[hooks]]` entry; user entries are untouched. */
export async function uninstallKimiHooks(
  configPath = getKimiHooksConfigPath()
): Promise<KimiHooksUninstallResult> {
  const existing = await fs.readFile(configPath, 'utf-8').catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  })
  if (!existing) return { configPath, hooksRemoved: 0 }

  const parsed = parseHooksToml(existing)
  if (parsed.managed.length === 0) return { configPath, hooksRemoved: 0 }

  const base = parsed.stripped.replace(/\s+$/, '')
  const next = base ? `${base}\n` : ''
  await writeConfigIfChanged(configPath, existing, next)
  return { configPath, hooksRemoved: parsed.managed.length }
}
