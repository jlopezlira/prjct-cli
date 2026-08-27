/**
 * Gemini CLI settings wiring — MCP servers + lifecycle hooks in
 * `~/.gemini/settings.json`.
 *
 * Gemini event names differ from Claude (BeforeTool / AfterTool / BeforeAgent /
 * AfterAgent). We install the same `prjct hook <sub>` commands with
 * PRJCT_HOOK_HOST=gemini so _shared.adaptHookOutputForHost remaps deny/context
 * shapes. Docs: https://geminicli.com/docs/hooks/
 *
 * MCP: top-level mcpServers (same JSON shape as Claude). Prefer not to use
 * underscores in server names (Gemini policy parser); "prjct" is fine.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from '../infrastructure/user-home'
import { hookCommandChain } from '../services/hook-command'
import { PRJCT_HOOKS } from '../services/settings-installer'
import { MCP_SERVER_PRESETS } from './mcp-config'

const MANAGED_MARKER = '_prjctManaged' as const

export function getGeminiSettingsPath(): string {
  if (process.env.PRJCT_TEST_MODE === '1') {
    return path.join(resolveUserPath('.prjct-tests'), 'gemini', 'settings.json')
  }
  return resolveUserPath('.gemini', 'settings.json')
}

interface GeminiHookHandler {
  type: 'command'
  command: string
  name?: string
  timeout?: number
  description?: string
  [MANAGED_MARKER]?: true
}

interface GeminiMatcherGroup {
  matcher?: string
  hooks: GeminiHookHandler[]
}

interface GeminiSettings {
  mcpServers?: Record<string, unknown>
  hooks?: Record<string, GeminiMatcherGroup[]>
  [key: string]: unknown
}

export interface GeminiInstallResult {
  settingsPath: string
  mcpChanged: boolean
  hooksWritten: number
  alreadyPresent: number
  hooksPruned: number
}

export interface GeminiUninstallResult {
  settingsPath: string
  hooksRemoved: number
  mcpRemoved: boolean
}

/** Claude event → Gemini event + optional tool matcher override. */
interface GeminiHookMap {
  geminiEvent: string
  /** Override Claude matcher for Gemini tool names (regex). */
  matcher?: string
  subcommand: string
  name: string
}

/**
 * Map only hooks Gemini can fire. Tool matchers use Gemini built-in names
 * (run_shell_command, write_file, replace) per tools reference.
 */
export function geminiHookMaps(): GeminiHookMap[] {
  const maps: GeminiHookMap[] = []
  for (const spec of PRJCT_HOOKS) {
    if (spec.event === 'SessionStart') {
      maps.push({
        geminiEvent: 'SessionStart',
        matcher: spec.matcher || undefined,
        subcommand: spec.subcommand,
        name: `prjct-${spec.subcommand}`,
      })
    } else if (spec.event === 'UserPromptSubmit') {
      maps.push({
        geminiEvent: 'BeforeAgent',
        subcommand: spec.subcommand,
        name: `prjct-${spec.subcommand}`,
      })
    } else if (spec.event === 'PreToolUse' && spec.matcher === 'Bash') {
      // Consolidated Bash gate: one process covers secrets, packages, commit memory.
      maps.push({
        geminiEvent: 'BeforeTool',
        matcher: 'run_shell_command',
        subcommand: spec.subcommand,
        name: `prjct-${spec.subcommand}`,
      })
    } else if (spec.event === 'PreToolUse' && spec.subcommand === 'pre-edit') {
      maps.push({
        geminiEvent: 'BeforeTool',
        matcher: 'write_file|replace',
        subcommand: spec.subcommand,
        name: `prjct-${spec.subcommand}`,
      })
    } else if (spec.event === 'PostToolUse' && spec.subcommand === 'post-edit') {
      maps.push({
        geminiEvent: 'AfterTool',
        matcher: 'write_file|replace',
        subcommand: spec.subcommand,
        name: `prjct-${spec.subcommand}`,
      })
    } else if (spec.event === 'PostToolUse' && spec.subcommand === 'post-read') {
      maps.push({
        geminiEvent: 'AfterTool',
        matcher: 'read_file',
        subcommand: spec.subcommand,
        name: `prjct-${spec.subcommand}`,
      })
    } else if (spec.event === 'Stop') {
      maps.push({
        geminiEvent: 'AfterAgent',
        subcommand: spec.subcommand,
        name: `prjct-${spec.subcommand}`,
      })
    } else if (spec.event === 'Notification') {
      maps.push({
        geminiEvent: 'Notification',
        subcommand: spec.subcommand,
        name: `prjct-${spec.subcommand}`,
      })
    }
    // SubagentStart/Stop, CwdChanged: no Gemini equivalent — skip
  }
  return maps
}

function hookCommand(subcommand: string): string {
  // Host env remaps deny/context for Gemini schema. It is inlined in EVERY
  // stage of the shared chain — the native hook-fast binary forwards it to
  // the daemon as `hookHost` (native/hook-fast.c), the runtime stages read
  // it from their own env.
  // CRITICAL: never reference $PPID or other host-only vars. Gemini runs hooks
  // with a sanitized env and refuses commands that require unset vars
  // ("required env var(s) not set: ${PPID}") — which would skip the
  // credential MUST. Only GEMINI_* / explicit PRJCT_* are portable here.
  return hookCommandChain(subcommand, 'PRJCT_HOOK_HOST=gemini')
}

function isPrjctHandler(h: GeminiHookHandler): boolean {
  return h[MANAGED_MARKER] === true || (h.name?.startsWith('prjct-') ?? false)
}

function isLegacyPrjctHandler(h: GeminiHookHandler): boolean {
  if (h[MANAGED_MARKER] === true) return false
  const cmd = h.command?.trim() ?? ''
  return /(^|\/|\s)prjct\s+hook\s+\S+/.test(cmd) || /PRJCT_HOOK_HOST=gemini/.test(cmd)
}

async function readSettings(settingsPath: string): Promise<GeminiSettings> {
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') return parsed as GeminiSettings
    return {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function writeSettings(settingsPath: string, data: GeminiSettings): Promise<void> {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  await fs.writeFile(settingsPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
}

function handlerFor(map: GeminiHookMap): GeminiHookHandler {
  return {
    type: 'command',
    command: hookCommand(map.subcommand),
    name: map.name,
    timeout: 30_000, // Gemini uses milliseconds
    description: `prjct ${map.subcommand} (managed)`,
    [MANAGED_MARKER]: true,
  }
}

function pruneOrphans(hooks: Record<string, GeminiMatcherGroup[]>): number {
  const validNames = new Set(geminiHookMaps().map((m) => m.name))
  const pruned: GeminiHookHandler[] = []
  for (const event of Object.keys(hooks)) {
    const kept: GeminiMatcherGroup[] = []
    for (const block of hooks[event] ?? []) {
      block.hooks = block.hooks.filter((h) => {
        if (!isPrjctHandler(h) && !isLegacyPrjctHandler(h)) return true
        if (h.name && validNames.has(h.name)) return true
        // legacy without name or retired name
        if (h.name && !validNames.has(h.name)) {
          pruned.push(h)
          return false
        }
        if (!h.name && isLegacyPrjctHandler(h)) {
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

/** Upsert mcpServers.prjct (and leave other servers untouched). */
export async function ensureGeminiMcpServer(
  settingsPath = getGeminiSettingsPath()
): Promise<{ path: string; changed: boolean }> {
  const settings = await readSettings(settingsPath)
  const servers = { ...(settings.mcpServers ?? {}) }
  const previous = servers.prjct
  const next = MCP_SERVER_PRESETS.prjct
  const changed = JSON.stringify(previous) !== JSON.stringify(next)
  servers.prjct = next
  settings.mcpServers = servers
  if (changed || previous === undefined) {
    await writeSettings(settingsPath, settings)
  }
  return { path: settingsPath, changed: changed || previous === undefined }
}

/** Install prjct hooks into Gemini settings.json (idempotent). */
export async function installGeminiHooks(settingsPath = getGeminiSettingsPath()): Promise<{
  path: string
  hooksWritten: number
  alreadyPresent: number
  hooksPruned: number
}> {
  const settings = await readSettings(settingsPath)
  const hooks: Record<string, GeminiMatcherGroup[]> = settings.hooks ?? {}
  const written: GeminiHookMap[] = []
  const present: GeminiHookMap[] = []

  for (const map of geminiHookMaps()) {
    const eventEntries: GeminiMatcherGroup[] = hooks[map.geminiEvent] ?? []
    const wantMatcher = map.matcher ?? ''
    const existingBlock = eventEntries.find((b) => (b.matcher ?? '') === wantMatcher)
    const block = existingBlock ?? { matcher: map.matcher, hooks: [] }
    if (!existingBlock) {
      eventEntries.push(block)
    }

    block.hooks = block.hooks.filter((h) => !isLegacyPrjctHandler(h) || isPrjctHandler(h))
    // Drop legacy unmarked only
    block.hooks = block.hooks.filter((h) => {
      if (isLegacyPrjctHandler(h) && !isPrjctHandler(h)) return false
      return true
    })

    const desired = handlerFor(map)
    const existing = block.hooks.find(
      (h) => isPrjctHandler(h) && (h.name === map.name || h.command.includes(map.subcommand))
    )
    if (existing) {
      if (existing.command === desired.command && existing.timeout === desired.timeout) {
        present.push(map)
      } else {
        existing.command = desired.command
        existing.timeout = desired.timeout
        existing.name = desired.name
        existing.description = desired.description
        existing[MANAGED_MARKER] = true
        written.push(map)
      }
    } else {
      block.hooks.push(desired)
      written.push(map)
    }

    if (!block.matcher) delete block.matcher
    hooks[map.geminiEvent] = eventEntries
  }

  const hooksPruned = pruneOrphans(hooks)
  settings.hooks = hooks
  await writeSettings(settingsPath, settings)
  return {
    path: settingsPath,
    hooksWritten: written.length,
    alreadyPresent: present.length,
    hooksPruned,
  }
}

/** Full Gemini surface: MCP + hooks. */
export async function installGeminiSettings(
  settingsPath = getGeminiSettingsPath()
): Promise<GeminiInstallResult> {
  const mcp = await ensureGeminiMcpServer(settingsPath)
  const hooks = await installGeminiHooks(settingsPath)
  return {
    settingsPath,
    mcpChanged: mcp.changed,
    hooksWritten: hooks.hooksWritten,
    alreadyPresent: hooks.alreadyPresent,
    hooksPruned: hooks.hooksPruned,
  }
}

export async function uninstallGeminiSettings(
  settingsPath = getGeminiSettingsPath()
): Promise<GeminiUninstallResult> {
  const settings = await readSettings(settingsPath)
  const removedHooks: GeminiHookHandler[] = []
  if (settings.hooks) {
    for (const [event, blocks] of Object.entries(settings.hooks)) {
      const cleaned: GeminiMatcherGroup[] = []
      for (const block of blocks) {
        const remaining = block.hooks.filter((h) => {
          if (isPrjctHandler(h) || isLegacyPrjctHandler(h)) {
            removedHooks.push(h)
            return false
          }
          return true
        })
        if (remaining.length > 0) cleaned.push({ ...block, hooks: remaining })
      }
      if (cleaned.length > 0) settings.hooks[event] = cleaned
      else delete settings.hooks[event]
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  }

  const mcpRemoved = Boolean(settings.mcpServers?.prjct)
  if (mcpRemoved && settings.mcpServers) {
    delete settings.mcpServers.prjct
    if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers
  }

  await writeSettings(settingsPath, settings)
  return { settingsPath, hooksRemoved: removedHooks.length, mcpRemoved }
}
