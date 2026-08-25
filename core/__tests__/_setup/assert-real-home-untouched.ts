/**
 * Red-test guard for the ~/.kimi-code/mcp.json incident class (mem_19026).
 *
 * Snapshots the REAL host-config surfaces — resolved via os.homedir(), which
 * Bun freezes to the launch environment (the developer's actual home, NOT the
 * sandbox from isolate-cli-home.ts) — at preload time, then re-checks at process
 * exit. A change means a test reached a writer still on raw os.homedir(); fix it
 * by migrating to resolveUserHome()/resolveUserPath() or gating on
 * PRJCT_TEST_MODE. Fails the run loudly instead of silently overwriting config.
 *
 * This file is the one place outside the home resolvers allowed to call
 * os.homedir() (see scripts/check-no-homedir.ts) — it must read the real home.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REAL_HOME = os.homedir()

// The union of every host-config surface the foreign-config writers touch.
// Dirs are stamped by mtime + entry count (catches new/removed entries); files
// by mtime + size (catches in-place edits).
const WATCHED = [
  '.claude',
  '.claude.json',
  '.claude/settings.json',
  '.claude/mcp.json',
  '.claude/CLAUDE.md',
  '.claude/prjct-statusline.sh',
  '.claude/commands',
  '.claude/commands/p',
  '.claude/skills/prjct/SKILL.md',
  '.gemini',
  '.gemini/GEMINI.md',
  '.gemini/settings.json',
  '.gemini/commands',
  '.gemini/antigravity/skills/prjct/SKILL.md',
  '.kimi-code/mcp.json',
  '.kimi/mcp.json',
  '.codex/config.toml',
  '.codex/skills/prjct/SKILL.md',
  '.grok/config.toml',
  '.cursor',
].map((seg) => path.join(REAL_HOME, seg))

function stampOf(target: string): string {
  try {
    const st = fs.statSync(target)
    const detail = st.isDirectory() ? `dir:${fs.readdirSync(target).length}` : `file:${st.size}`
    return `${target}|${st.mtimeMs}|${detail}`
  } catch {
    return `${target}|absent`
  }
}

function snapshot(): string {
  return WATCHED.map(stampOf).sort().join('\n')
}

// PRJCT_TEST_HOME_GUARD=0 disables the exit assertion for the one legitimate
// false-positive: an EXTERNAL writer (e.g. a live agent session's prjct
// self-heal) touching a watched config mid-run on a dev machine. CI has no
// external writers, so it always keeps the guard on.
const GUARD_ON = process.env.PRJCT_TEST_HOME_GUARD !== '0'
const BEFORE = GUARD_ON ? snapshot() : ''

process.on('exit', () => {
  if (GUARD_ON && snapshot() !== BEFORE) {
    process.exitCode = 1
    process.stderr.write(
      '\n[test-isolation] REAL host config changed during the test run.\n' +
        'Most likely a writer resolved the real home (os.homedir()) instead of the sandbox — ' +
        'migrate it to resolveUserHome()/resolveUserPath() or gate it on PRJCT_TEST_MODE.\n' +
        'If an EXTERNAL process (e.g. a live agent session) wrote the config during the run, ' +
        're-run to confirm, or set PRJCT_TEST_HOME_GUARD=0 for that run only.\n\n'
    )
  }
})
