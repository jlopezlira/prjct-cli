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

/** Every hook we install — keep in one place so install/uninstall agree. */
export const PRJCT_HOOKS = [
  { event: 'SessionStart', matcher: '', subcommand: 'session-start' },
  { event: 'UserPromptSubmit', matcher: '', subcommand: 'prompt' },
  {
    event: 'PreToolUse',
    matcher: 'Bash',
    subcommand: 'pre-commit',
    ifClause: 'Bash(git commit *)',
  },
  // Credential non-exposure MUST — deny tools whose args contain secret
  // material. No $PPID / host-only env (Gemini sanitizes env and skips hooks
  // that require vars it does not set). Two matchers share one subcommand.
  { event: 'PreToolUse', matcher: 'Bash', subcommand: 'pre-secrets' },
  { event: 'PreToolUse', matcher: 'Edit|Write', subcommand: 'pre-secrets' },
  // Package legitimacy — flag/deny unknown npm|pnpm|yarn|bun adds BEFORE install.
  { event: 'PreToolUse', matcher: 'Bash', subcommand: 'pre-package' },
  // Push a file's preventive memory (gotchas/anti-patterns) the moment Claude
  // is about to edit it — closes the apply loop that pull-only `guard` left to
  // the agent's (unreliable) instinct. Fires regardless of model = update-proof.
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
 * Shell command for a hook — delegates to the installed `prjct` binary.
 *
 * Resilience: wraps the call in a `command -v` guard so that if `prjct`
 * is missing from PATH (uninstall, package-manager move, broken nvm
 * shim, post-cleanup stranding), the hook silently no-ops with exit 0
 * rather than spamming "command not found" errors into every Claude
 * Code session. The user can still see prjct is missing — they just
 * see it on `prjct -v`, not on every Stop hook fire.
 *
 * Resolves via PATH so the hook survives node/bun upgrades; if the
 * user moves prjct to a non-PATH location they can override via
 * PRJCT_BIN env var.
 */
function hookCommand(subcommand: string): string {
  const bin = process.env.PRJCT_BIN ?? 'prjct'
  // command -v works in sh/bash/zsh — what Claude Code's hook runner uses.
  return `command -v ${bin} >/dev/null 2>&1 && ${bin} hook ${subcommand} || exit 0`
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
    [MANAGED_MARKER]: true,
  }
  if ('ifClause' in spec && spec.ifClause) entry.if = spec.ifClause
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
      // Refresh command + if clause in case the binary path or matcher changed.
      const refreshed = hookEntryFor(spec)
      if (
        existing.command === refreshed.command &&
        existing.if === refreshed.if &&
        droppedLegacy === 0
      ) {
        present.push(spec)
      } else {
        existing.command = refreshed.command
        existing.if = refreshed.if
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
