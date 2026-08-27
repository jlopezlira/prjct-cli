/**
 * Codex hooks installer — maps PRJCT_HOOKS into `~/.codex/hooks.json` and
 * ensures `[features].hooks = true` in config.toml.
 *
 * Codex hook shape mirrors Claude settings.json (event → matcher groups →
 * command handlers). Docs: https://developers.openai.com/codex/hooks
 * (feature key is `hooks`; `codex_hooks` is a deprecated alias).
 *
 * Events Claude has that Codex does not: Notification, CwdChanged — skipped.
 * Non-managed hooks require user trust via `/hooks` in the Codex TUI.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from '../infrastructure/user-home'
import { PRJCT_HOOKS } from '../services/settings-installer'
import { getCodexConfigTomlPath } from './codex-mcp'

const MANAGED_MARKER = '_prjctManaged' as const

/** Codex-supported lifecycle events we install (subset of PRJCT_HOOKS). */
export const CODEX_HOOK_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
])

const FEATURES_START = '# prjct:features:start - managed by prjct, do not edit between markers'
const FEATURES_END = '# prjct:features:end'

export function getCodexHooksJsonPath(): string {
  if (process.env.PRJCT_TEST_MODE === '1') {
    return path.join(resolveUserPath('.prjct-tests'), 'codex', 'hooks.json')
  }
  return resolveUserPath('.codex', 'hooks.json')
}

interface CodexHookHandler {
  type: 'command'
  command: string
  commandWindows?: string
  timeout?: number
  statusMessage?: string
  [MANAGED_MARKER]?: true
}

interface CodexMatcherGroup {
  matcher?: string
  hooks: CodexHookHandler[]
}

interface CodexHooksFile {
  hooks?: Record<string, CodexMatcherGroup[]>
  [key: string]: unknown
}

export interface CodexHooksInstallResult {
  hooksPath: string
  configPath: string
  hooksWritten: number
  alreadyPresent: number
  hooksPruned: number
  featuresEnabled: boolean
  featuresChanged: boolean
}

export interface CodexHooksUninstallResult {
  hooksPath: string
  hooksRemoved: number
}

function hookCommandUnix(subcommand: string): string {
  const bin = process.env.PRJCT_BIN ?? 'prjct'
  return `command -v ${bin} >/dev/null 2>&1 && ${bin} hook ${subcommand} || exit 0`
}

function hookCommandWindows(subcommand: string): string {
  const bin = process.env.PRJCT_BIN ?? 'prjct'
  // cmd.exe: where succeeds → run hook; else exit 0 (fail-soft).
  return `where ${bin} >nul 2>&1 && ${bin} hook ${subcommand} || exit /b 0`
}

function isPrjctHandler(h: CodexHookHandler): boolean {
  return h[MANAGED_MARKER] === true
}

function isLegacyPrjctHandler(h: CodexHookHandler): boolean {
  if (h[MANAGED_MARKER] === true) return false
  const cmd = h.command?.trim() ?? ''
  return /(^|\/|\\|\s)prjct(\.cmd)?\s+hook\s+\S+/i.test(cmd)
}

function subcommandOf(h: CodexHookHandler): string | null {
  const m = h.command?.match(/\bhook\s+(\S+)/i)
  return m ? m[1] : null
}

function handlerFor(subcommand: string, statusMessage?: string): CodexHookHandler {
  const entry: CodexHookHandler = {
    type: 'command',
    command: hookCommandUnix(subcommand),
    commandWindows: hookCommandWindows(subcommand),
    timeout: 30,
    [MANAGED_MARKER]: true,
  }
  if (statusMessage) entry.statusMessage = statusMessage
  return entry
}

function statusFor(subcommand: string): string {
  return `prjct ${subcommand}`
}

/** PRJCT_HOOKS entries that Codex can actually fire. */
export function codexHookSpecs(): Array<(typeof PRJCT_HOOKS)[number]> {
  return PRJCT_HOOKS.filter((h) => CODEX_HOOK_EVENTS.has(h.event))
}

async function readHooksFile(hooksPath: string): Promise<CodexHooksFile> {
  try {
    const raw = await fs.readFile(hooksPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') return parsed as CodexHooksFile
    return {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function writeHooksFile(hooksPath: string, data: CodexHooksFile): Promise<void> {
  await fs.mkdir(path.dirname(hooksPath), { recursive: true })
  await fs.writeFile(hooksPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
}

function pruneOrphans(hooks: Record<string, CodexMatcherGroup[]>): number {
  const valid = new Set<string>(codexHookSpecs().map((h) => h.subcommand))
  const pruned: CodexHookHandler[] = []
  for (const event of Object.keys(hooks)) {
    const kept: CodexMatcherGroup[] = []
    for (const block of hooks[event] ?? []) {
      block.hooks = block.hooks.filter((h) => {
        if (!isPrjctHandler(h)) return true
        const sub = subcommandOf(h)
        if (sub && !valid.has(sub)) {
          pruned.push(h)
          return false
        }
        return true
      })
      if (block.hooks.length > 0) kept.push(block)
    }
    if (kept.length > 0) hooks[event] = kept
    else delete hooks[event]
  }
  return pruned.length
}

/**
 * Enable Codex hooks feature in config.toml (idempotent, marker-managed).
 * Returns whether the features block was written/changed.
 */
export async function ensureCodexHooksFeature(
  configPath = getCodexConfigTomlPath()
): Promise<{ path: string; changed: boolean; enabled: boolean }> {
  const existing = await fs.readFile(configPath, 'utf-8').catch(() => '')

  const block = [FEATURES_START, '[features]', 'hooks = true', FEATURES_END, ''].join('\n')

  const startIdx = existing.indexOf(FEATURES_START)
  const endIdx = existing.indexOf(FEATURES_END)

  if (
    startIdx === -1 &&
    (/^\s*hooks\s*=\s*true\b/m.test(existing) || /^\s*codex_hooks\s*=\s*true\b/m.test(existing))
  ) {
    return { path: configPath, changed: false, enabled: true }
  }

  const next = (() => {
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const before = existing.slice(0, startIdx)
      const rawAfter = existing.slice(endIdx + FEATURES_END.length)
      const after = rawAfter.startsWith('\n') ? rawAfter.slice(1) : rawAfter
      return before + block + after
    }
    if (
      /^\s*hooks\s*=\s*true\b/m.test(existing) ||
      /^\s*codex_hooks\s*=\s*true\b/m.test(existing)
    ) {
      return existing
    }
    if (/^\s*\[features\]/m.test(existing)) {
      return !/^\s*hooks\s*=/m.test(existing) && !/^\s*codex_hooks\s*=/m.test(existing)
        ? existing.replace(/^(\s*\[features\]\s*)$/m, `$1\nhooks = true`)
        : existing
    }
    return existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${block}` : block
  })()
  const changed = next !== existing

  if (changed) {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, next, 'utf-8')
  }

  return { path: configPath, changed, enabled: true }
}

/**
 * Idempotently install prjct hooks into Codex hooks.json + enable features.hooks.
 */
export async function installCodexHooks(opts?: {
  hooksPath?: string
  configPath?: string
}): Promise<CodexHooksInstallResult> {
  const hooksPath = opts?.hooksPath ?? getCodexHooksJsonPath()
  const configPath = opts?.configPath ?? getCodexConfigTomlPath()

  const file = await readHooksFile(hooksPath)
  const hooks: Record<string, CodexMatcherGroup[]> = file.hooks ?? {}

  const outcomes: Array<'written' | 'present'> = []

  for (const spec of codexHookSpecs()) {
    const existingEntries: CodexMatcherGroup[] = hooks[spec.event] ?? []
    const movedStale = existingEntries.reduce((count, candidate) => {
      if ((candidate.matcher ?? '') === (spec.matcher ?? '')) return count
      const before = candidate.hooks.length
      candidate.hooks = candidate.hooks.filter((handler) => {
        const managed = isPrjctHandler(handler) || isLegacyPrjctHandler(handler)
        return !(managed && subcommandOf(handler) === spec.subcommand)
      })
      return count + before - candidate.hooks.length
    }, 0)
    const eventEntries = existingEntries.filter((candidate) => candidate.hooks.length > 0)
    const matchingBlock = eventEntries.find((b) => (b.matcher ?? '') === (spec.matcher ?? ''))
    const block = matchingBlock ?? { matcher: spec.matcher || undefined, hooks: [] }
    if (!matchingBlock) {
      eventEntries.push(block)
    }

    // Collapse legacy unmarked prjct commands.
    block.hooks = block.hooks.filter((h) => !isLegacyPrjctHandler(h))

    const desired = handlerFor(spec.subcommand, statusFor(spec.subcommand))
    // Match by subcommand — multiple managed hooks share a matcher (Bash /
    // Edit|Write both carry pre-secrets + a sibling).
    const existing = block.hooks.find(
      (h) => isPrjctHandler(h) && subcommandOf(h) === spec.subcommand
    )
    if (existing) {
      if (
        existing.command === desired.command &&
        existing.commandWindows === desired.commandWindows &&
        existing.timeout === desired.timeout &&
        movedStale === 0
      ) {
        outcomes.push('present')
      } else {
        existing.command = desired.command
        existing.commandWindows = desired.commandWindows
        existing.timeout = desired.timeout
        existing.statusMessage = desired.statusMessage
        outcomes.push('written')
      }
    } else {
      block.hooks.push(desired)
      outcomes.push('written')
    }

    // Empty matcher → omit key (Codex treats omit/* as match-all).
    if (!block.matcher) delete block.matcher
    hooks[spec.event] = eventEntries
  }

  const hooksPruned = pruneOrphans(hooks)
  file.hooks = hooks
  await writeHooksFile(hooksPath, file)

  const features = await ensureCodexHooksFeature(configPath)

  return {
    hooksPath,
    configPath,
    hooksWritten: outcomes.filter((outcome) => outcome === 'written').length,
    alreadyPresent: outcomes.filter((outcome) => outcome === 'present').length,
    hooksPruned,
    featuresEnabled: features.enabled,
    featuresChanged: features.changed,
  }
}

/** Remove every prjct-managed Codex hook handler. */
export async function uninstallCodexHooks(
  hooksPath = getCodexHooksJsonPath()
): Promise<CodexHooksUninstallResult> {
  const file = await readHooksFile(hooksPath)
  if (!file.hooks) return { hooksPath, hooksRemoved: 0 }

  const removed: CodexHookHandler[] = []
  for (const [event, blocks] of Object.entries(file.hooks)) {
    const cleaned: CodexMatcherGroup[] = []
    for (const block of blocks) {
      const remaining = block.hooks.filter((h) => {
        if (isPrjctHandler(h) || isLegacyPrjctHandler(h)) {
          removed.push(h)
          return false
        }
        return true
      })
      if (remaining.length > 0) {
        cleaned.push({ ...block, hooks: remaining })
      }
    }
    if (cleaned.length > 0) file.hooks[event] = cleaned
    else delete file.hooks[event]
  }

  if (Object.keys(file.hooks).length === 0) delete file.hooks
  await writeHooksFile(hooksPath, file)
  return { hooksPath, hooksRemoved: removed.length }
}

export async function codexHooksStatus(hooksPath = getCodexHooksJsonPath()): Promise<{
  installed: number
  expected: number
  path: string
}> {
  const file = await readHooksFile(hooksPath)
  const installed = Object.values(file.hooks ?? {})
    .flat()
    .flatMap((block) => block.hooks)
    .filter((handler) => isPrjctHandler(handler) || isLegacyPrjctHandler(handler)).length
  return { installed, expected: codexHookSpecs().length, path: hooksPath }
}
