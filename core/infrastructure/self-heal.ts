/**
 * Self-heal — re-installs hooks + global CLAUDE.md when the running
 * binary's version differs from the last successful sync.
 *
 * Why this exists: `npm install -g prjct-cli` only updates the binary.
 * `scripts/postinstall.js` is best-effort and disabled on many client
 * machines by `--ignore-scripts` or corporate security policies, so we
 * cannot rely on it to refresh `~/.claude/settings.json` hooks or the
 * `<!-- prjct:start -->` block in `~/.claude/CLAUDE.md` after an upgrade.
 *
 * The fix is runtime: every prjct invocation reads a tiny stamp file at
 * `~/.prjct-cli/state/installed-version`. If it matches the bundled
 * version → fast no-op (one fs read, microseconds). If it differs →
 * re-run `installGlobalConfig()` + `settings-installer.install()` and
 * rewrite the stamp.
 *
 * Idempotency comes from the installers themselves:
 *   - settings-installer: every entry tagged `_prjctManaged: true`,
 *     dedupes on re-run.
 *   - command-installer: rewrites the `<!-- prjct:start -->` block
 *     between markers; user content outside the markers is preserved.
 *
 * Failure mode: every step is wrapped — a self-heal failure must NEVER
 * block the user's command. Worst case the user keeps the stale config
 * until the next invocation.
 */

import fs from 'node:fs'
import path from 'node:path'
import pathManager from './path-manager'

// Lazy: resolve via pathManager at call time (honors PRJCT_CLI_HOME and
// test-time setGlobalBaseDir). Production === ~/.prjct-cli/state, unchanged.
const stampDir = (): string => pathManager.getStatePath()
const stampPath = (): string => path.join(stampDir(), 'installed-version')

function readStamp(): string | null {
  try {
    return fs.readFileSync(stampPath(), 'utf-8').trim()
  } catch {
    return null
  }
}

function writeStamp(version: string): void {
  try {
    fs.mkdirSync(stampDir(), { recursive: true })
    fs.writeFileSync(stampPath(), version, 'utf-8')
  } catch {
    // best-effort
  }
}

/**
 * Cheap check — single fs read. Use this to gate the slow path.
 * Returns true when the stamp matches the running version (no work needed).
 */
export function isSyncCurrent(currentVersion: string): boolean {
  if (!currentVersion) return true
  return readStamp() === currentVersion
}

/**
 * Run the actual re-sync. Caller is expected to have checked
 * `isSyncCurrent` first; calling this on the hot path is wasteful but
 * not incorrect — the underlying installers are idempotent.
 *
 * Errors are swallowed by design.
 */
export async function runSelfHeal(currentVersion: string): Promise<void> {
  if (!currentVersion) return
  if (process.env.PRJCT_NO_SELF_SYNC === '1') return

  try {
    const { installGlobalConfig } = await import('./command-installer')
    await installGlobalConfig()
  } catch {
    // best-effort
  }

  try {
    const settingsInstaller = await import('../services/settings-installer')
    await settingsInstaller.install()
  } catch {
    // best-effort
  }

  // Regenerate the Claude statusline so an upgrade actually delivers body
  // changes (e.g. the version-check rewrite). Without this, an old statusline
  // body persisted across upgrades — the source of the permanent false
  // "upgrade available" banner. installStatusLine is guarded to never clobber
  // a modern modular ("v2") statusline.
  try {
    const { SetupCommands } = await import('../commands/setup')
    await new SetupCommands().installStatusLine()
  } catch {
    // best-effort
  }

  // Same refresh for Kimi's footer command — but only when a Kimi home
  // already exists; self-heal must never create ~/.kimi-code for non-Kimi
  // users.
  try {
    const { getKimiHomeDir } = await import('../utils/kimi-mcp')
    if (fs.existsSync(getKimiHomeDir())) {
      const { ensureKimiStatusLine } = await import('../utils/kimi-tui')
      await ensureKimiStatusLine()
    }
  } catch {
    // best-effort
  }

  writeStamp(currentVersion)
}
