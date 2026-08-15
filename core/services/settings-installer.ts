/**
 * Claude Code settings installer.
 *
 * Merges prjct's hook entries into `~/.claude/settings.json` without
 * clobbering user keys or hooks installed by other tools. Every entry we
 * write is tagged with `_prjctManaged: true` so `uninstall` can strip
 * them cleanly.
 *
 * Why a separate file instead of a plugin manifest: Claude Code's plugin
 * system is still rolling out across hosts (Code / Design / Cowork);
 * settings.json is the universal fallback that works everywhere today.
 * When plugin manifests stabilize, we flip to that and delete this.
 */

import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Resolve home per call. Prefer `process.env.HOME` so tests can point
 * at a temp dir — `os.homedir()` on macOS/Linux ignores HOME and reads
 * the uid-mapped home, which breaks isolation. In normal CLI runs
 * `process.env.HOME` is set, so `os.homedir()` is a last-resort fallback.
 */
function settingsPath(): string {
  const home = process.env.HOME || os.homedir()
  return path.join(home, '.claude', 'settings.json')
}

const MANAGED_MARKER = '_prjctManaged'

/**
 * Per-hook timeout (seconds) written into every Claude Code entry. Claude
 * waits SYNCHRONOUSLY on UserPromptSubmit/PreToolUse, and its default hook
 * timeout (60s) is far above our hook SLO (p95 ≤ 800ms, see
 * scripts/bench-hooks.mjs) — a wedged daemon or cold bundle would freeze
 * the agent's tool loop for a full minute per event. Codex and Cursor
 * entries already carry `timeout: 30`; Claude now gets a tighter bound.
 */
export const HOOK_TIMEOUT_SECONDS = 10

/** Every hook we install — keep in one place so install/uninstall agree. */
export const PRJCT_HOOKS = [
  { event: 'SessionStart', matcher: '', subcommand: 'session-start' },
  { event: 'UserPromptSubmit', matcher: '', subcommand: 'prompt' },
  // One Bash hook combines commit memory + secret scanning + package
  // legitimacy. This preserves every decision while cutting three process
  // starts per Bash tool call down to one.
  { event: 'PreToolUse', matcher: 'Bash', subcommand: 'pre-bash' },
  // Secret scanning is folded into pre-edit before preventive memory/deny.
  { event: 'PreToolUse', matcher: 'Edit|Write', subcommand: 'pre-edit' },
  // Non-blocking code-graph augment for Grep/Glob (CBM-inspired). Never denies.
  { event: 'PreToolUse', matcher: 'Grep|Glob', subcommand: 'pre-search' },
  { event: 'PostToolUse', matcher: 'Edit|Write', subcommand: 'post-edit' },
  { event: 'Stop', matcher: '', subcommand: 'stop' },
  { event: 'SubagentStart', matcher: '', subcommand: 'subagent-start' },
  // Ping the user (best-effort OS notification, default on) when a subagent
  // finishes or Claude is waiting on them — so a background wait never hangs
  // silently. Gated by config.notify; the handler no-ops when off.
  { event: 'SubagentStop', matcher: '', subcommand: 'subagent-stop' },
  { event: 'Notification', matcher: '', subcommand: 'notification' },
  { event: 'CwdChanged', matcher: '', subcommand: 'cwd-changed' },
] as const

type HookSpec = (typeof PRJCT_HOOKS)[number]

interface HookEntry {
  type: 'command'
  command: string
  if?: string
  timeout?: number
  [MANAGED_MARKER]?: true
}

interface HookMatcher {
  matcher?: string
  hooks: HookEntry[]
}

interface SettingsFile {
  hooks?: Record<string, HookMatcher[]>
  [key: string]: unknown
}

interface InstallResult {
  settingsPath: string
  hooksWritten: number
  alreadyPresent: number
  /** Managed entries removed because their subcommand left PRJCT_HOOKS. */
  hooksPruned: number
}

/** Subcommand of a hook command string, e.g. `… prjct hook pre-edit …` → `pre-edit`. */
function subcommandOf(entry: HookEntry): string | null {
  const m = entry.command?.match(/\bhook\s+(\S+)/)
  return m ? m[1] : null
}

/**
 * Remove prjct-managed hook entries whose subcommand is no longer declared
 * in PRJCT_HOOKS. Empty matcher blocks and events are pruned too. Returns
 * the count removed. Non-prjct hooks and current managed hooks are untouched.
 */
function pruneOrphanedManagedHooks(hooks: Record<string, HookMatcher[]>): number {
  const valid = new Set<string>(PRJCT_HOOKS.map((h) => h.subcommand))
  const pruned: HookEntry[] = []
  for (const event of Object.keys(hooks)) {
    const blocks = hooks[event]
    const keptBlocks: HookMatcher[] = []
    for (const block of blocks) {
      block.hooks = block.hooks.filter((h) => {
        if (!isPrjctHook(h)) return true
        const sub = subcommandOf(h)
        if (sub && !valid.has(sub)) {
          pruned.push(h)
          return false
        }
        return true
      })
      if (block.hooks.length > 0) keptBlocks.push(block)
    }
    if (keptBlocks.length > 0) hooks[event] = keptBlocks
    else delete hooks[event]
  }
  return pruned.length
}

interface UninstallResult {
  settingsPath: string
  hooksRemoved: number
}

async function readSettings(): Promise<SettingsFile> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') return parsed as SettingsFile
    return {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function writeSettings(settings: SettingsFile): Promise<void> {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true })
  await fs.writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
}

/**
 * Absolute `runtime + shim` prefix for the hook command, when resolvable.
 *
 * Perf: the portable `prjct hook X` form pays for the POSIX wrapper
 * (bin/prjct): symlink resolution, runtime detection, ~5-8 forks ≈ 10-15ms
 * on EVERY hook event. Hooks fire per prompt/tool-call, so install time is
 * the right moment to resolve the direct path: the running CLI knows its own
 * runtime (process.execPath) and the shipped daemon shim's location.
 * The wrapper form stays as the `||` fallback — if the resolved runtime or
 * shim disappears (bun uninstalled, package moved), the hook still works.
 *
 * Layouts covered: bundled core (dist/bin/prjct-core.mjs → shim sibling),
 * split hook chunks (dist/bin/hook-chunks/ → one level up), daemon bundle
 * and source tree (…/dist/bin/prjct.mjs two levels up).
 */
function directHookPrefix(): string | null {
  if (process.platform === 'win32') return null
  const exec = process.execPath
  if (!exec) return null
  const here = __dirname
  const shim = [
    path.join(here, 'prjct.mjs'),
    path.resolve(here, '..', 'prjct.mjs'),
    path.resolve(here, '..', '..', 'dist', 'bin', 'prjct.mjs'),
  ].find((candidate) => existsSync(candidate))
  if (!shim) return null
  // Node <24 needs the node:sqlite flag for the shim's COLD fallback
  // (prjct-hooks.mjs → storage). Bun and Node 24+ tolerate it regardless;
  // prefixing unconditionally keeps the command correct across runtimes.
  const env = path.basename(exec).includes('bun')
    ? ''
    : // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell parameter expansion, not JS
      'NODE_OPTIONS="--experimental-sqlite${NODE_OPTIONS:+ $NODE_OPTIONS}" '
  return `${env}"${exec}" "${shim}"`
}

/**
 * Absolute path to the compiled native hook-fast binary for THIS platform
 * + arch (`hook-fast-<platform>-<arch>`, matching Node's own
 * process.platform/process.arch strings — see buildNativeHookFast() in
 * scripts/build.js), when the build produced one.
 *
 * Perf: this binary is a native process (no bun/node runtime boot), so it
 * removes the ~15-25ms of interpreted-runtime startup the bun-based
 * direct path (below) still pays on every hook fire. Measured end-to-end
 * against a warm daemon: ~68-73% faster than the bun shim for the same
 * request. POSIX only — native/hook-fast.c has no Windows named-pipe
 * support, so this returns null on win32 (directHookPrefix() already
 * special-cases that platform for the same reason).
 *
 * Purely additive: hookCommand() tries this FIRST, but every existing
 * fallback stays exactly as it was — a platform this build didn't produce
 * a binary for (no C toolchain at build time, or a target build.js
 * couldn't reach) just keeps using the bun-based path, identical to
 * before this existed.
 */
function nativeHookFastBinary(): string | null {
  if (process.platform === 'win32') return null
  const here = __dirname
  const label = `hook-fast-${process.platform}-${process.arch}`
  return (
    [
      path.join(here, label),
      path.resolve(here, '..', label),
      path.resolve(here, '..', '..', 'dist', 'bin', label),
    ].find((candidate) => existsSync(candidate)) ?? null
  )
}

/**
 * Shell command for a hook — tries the native binary first, then the
 * resolved `runtime + shim` fast path, falls back to the installed
 * `prjct` binary on PATH.
 *
 * Resilience: the chain ends in a `command -v` guard so that if `prjct`
 * is missing from PATH (uninstall, package-manager move, broken nvm
 * shim, post-cleanup stranding), the hook silently no-ops with exit 0
 * rather than spamming "command not found" errors into every Claude
 * Code session. The user can still see prjct is missing — they just
 * see it on `prjct -v`, not on every Stop hook fire.
 *
 * Precedence note: shell `&&`/`||` are left-associative with EQUAL
 * precedence, so the fast path and the portable guard are joined through a
 * braced group — `A || { B && C; } || exit 0` — otherwise the fallback
 * would fire even when the fast path succeeds. PRJCT_BIN keeps its
 * override and forces the portable form. The native binary and the direct
 * bun form are both plain commands (no internal `&&`), so chaining them
 * with plain `||` ahead of the braced portable group needs no extra
 * bracing — see native/hook-fast.c's docstring for why it's safe to punt
 * to the next stage at all (it never does so after reading stdin).
 */
function hookCommand(subcommand: string): string {
  const bin = process.env.PRJCT_BIN ?? 'prjct'
  const portable = `command -v ${bin} >/dev/null 2>&1 && ${bin} hook ${subcommand} || exit 0`
  if (process.env.PRJCT_BIN) return portable
  const direct = directHookPrefix()
  if (!direct) return portable
  const directStage = `${direct} hook ${subcommand}`
  const native = nativeHookFastBinary()
  const fastStage = native ? `"${native}" ${subcommand} || ${directStage}` : directStage
  // Precedence: shell `&&`/`||` are LEFT-associative with EQUAL precedence,
  // so `A || B && C || exit 0` groups as `((A || B) && C) || exit 0` — the
  // fallback hook would run EVEN WHEN the fast path succeeded (double hook
  // fire per event). The braces force the intended `A || (B && C) || exit 0`.
  return `${fastStage} || { ${portable.replace(' || exit 0', '')}; } || exit 0`
}

function isPrjctHook(entry: HookEntry): boolean {
  return entry[MANAGED_MARKER] === true
}

/**
 * Heuristic for legacy unmanaged duplicates: pre-marker installs wrote
 * `prjct hook <subcommand>` entries without `_prjctManaged: true`. Each
 * subsequent setup added a new (now-marked) entry instead of refreshing
 * them, so settings.json accumulates 3+ copies per event in the wild
 * (see e.g. JJ's machine 2026-05-01). Treat any unmanaged entry whose
 * command parses as `prjct hook …` as ours-from-an-old-version and let
 * `install()` collapse it into the canonical marked entry.
 */
function isLegacyPrjctHook(entry: HookEntry): boolean {
  if (entry[MANAGED_MARKER] === true) return false
  const cmd = entry.command?.trim() ?? ''
  // Match both `prjct hook X` and `${PRJCT_BIN} hook X` shapes.
  return /(^|\/|\s)prjct\s+hook\s+\S+/.test(cmd)
}

function hookEntryFor(spec: HookSpec): HookEntry {
  const entry: HookEntry = {
    type: 'command',
    command: hookCommand(spec.subcommand),
    timeout: HOOK_TIMEOUT_SECONDS,
    [MANAGED_MARKER]: true,
  }
  const ifClause = 'ifClause' in spec ? spec.ifClause : undefined
  if (typeof ifClause === 'string' && ifClause) entry.if = ifClause
  return entry
}

/**
 * Install prjct's hook stack. Idempotent — existing prjct entries are
 * refreshed (command + if clause), never duplicated. Non-prjct hooks
 * stay untouched.
 */
export async function install(): Promise<InstallResult> {
  const settings = await readSettings()
  const hooks: Record<string, HookMatcher[]> = settings.hooks ?? {}

  const written: HookSpec[] = []
  const present: HookSpec[] = []

  for (const spec of PRJCT_HOOKS) {
    const eventEntries: HookMatcher[] = hooks[spec.event] ?? []
    // Find an existing matcher block with the same matcher, or add one.
    const existingBlock = eventEntries.find((b) => (b.matcher ?? '') === spec.matcher)
    const block = existingBlock ?? { matcher: spec.matcher, hooks: [] }
    if (!existingBlock) {
      eventEntries.push(block)
    }

    // Drop any legacy unmanaged prjct entries first so we collapse stale
    // duplicates from older installs into the single canonical marked one.
    const beforeLen = block.hooks.length
    block.hooks = block.hooks.filter((h) => !isLegacyPrjctHook(h))
    const droppedLegacy = beforeLen - block.hooks.length

    // Match by subcommand — multiple managed hooks can share a matcher
    // (e.g. Bash → pre-commit + pre-secrets; Edit|Write → pre-secrets + pre-edit).
    const existing = block.hooks.find((h) => isPrjctHook(h) && subcommandOf(h) === spec.subcommand)
    if (existing) {
      // Refresh command + if clause + timeout in case the binary path,
      // matcher or timeout policy changed (entries installed before the
      // timeout was introduced carry none — they must be rewritten).
      const refreshed = hookEntryFor(spec)
      if (
        existing.command === refreshed.command &&
        existing.if === refreshed.if &&
        existing.timeout === refreshed.timeout &&
        droppedLegacy === 0
      ) {
        present.push(spec)
      } else {
        existing.command = refreshed.command
        existing.if = refreshed.if
        existing.timeout = refreshed.timeout
        written.push(spec)
      }
    } else {
      block.hooks.push(hookEntryFor(spec))
      written.push(spec)
    }

    hooks[spec.event] = eventEntries
  }

  // Prune orphaned managed hooks: entries we wrote in a prior version whose
  // subcommand is no longer in PRJCT_HOOKS. (`pre-edit` was once retired this
  // way when anticipation went pull-only; it's back now as the apply-loop
  // push, so it's no longer pruned — but the mechanism still matters for any
  // future retirement.) Without this, a refresh-only `install()` would leave
  // dead `prjct hook X` entries in the user's settings forever.
  const hooksPruned = pruneOrphanedManagedHooks(hooks)

  settings.hooks = hooks
  await writeSettings(settings)
  return {
    settingsPath: settingsPath(),
    hooksWritten: written.length,
    alreadyPresent: present.length,
    hooksPruned,
  }
}

/**
 * Remove every hook entry tagged as prjct-managed. Empty matcher blocks
 * and empty events are pruned so the file stays clean. User hooks
 * under the same events survive.
 */
export async function uninstall(): Promise<UninstallResult> {
  const settings = await readSettings()
  if (!settings.hooks) return { settingsPath: settingsPath(), hooksRemoved: 0 }

  const removedHooks: HookEntry[] = []
  for (const [event, blocks] of Object.entries(settings.hooks)) {
    const cleanedBlocks: HookMatcher[] = []
    for (const block of blocks) {
      const remaining = block.hooks.filter((h) => {
        if (isPrjctHook(h)) {
          removedHooks.push(h)
          return false
        }
        return true
      })
      if (remaining.length > 0) cleanedBlocks.push({ ...block, hooks: remaining })
    }
    if (cleanedBlocks.length > 0) settings.hooks[event] = cleanedBlocks
    else delete settings.hooks[event]
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks

  await writeSettings(settings)
  return { settingsPath: settingsPath(), hooksRemoved: removedHooks.length }
}

/** Introspection for `prjct doctor` — returns count currently installed. */
export async function status(): Promise<{ installed: number; expected: number }> {
  const settings = await readSettings()
  const hooks = settings.hooks ?? {}
  const installed = Object.values(hooks)
    .flat()
    .flatMap((block) => block.hooks)
    .filter(isPrjctHook).length
  return { installed, expected: PRJCT_HOOKS.length }
}
