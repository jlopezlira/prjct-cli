/**
 * WS4+WS5 — `prjct update` install consolidation + one-command notify.
 *
 *  - the new-version banner must point at `prjct upgrade` (the ONE command
 *    that updates every install AND consolidates), never the hardcoded
 *    `npm install -g` that creates the multi-install footgun;
 *  - `--no-cleanup` must deterministically skip consolidation;
 *  - `planCleanup()` is defensive — it never throws and never proposes
 *    removing without a provable winner.
 */

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  type CleanupLocation,
  consolidateInstalls,
  planCleanup,
  planCleanupFrom,
} from '../../commands/update/cleanup-installs'
import { formatMdOutput } from '../../commands/update/output'
import pathManager from '../../infrastructure/path-manager'
import { getUpdateNotificationSync } from '../../infrastructure/update-checker'

// planCleanup() shells out to real PM detection (brew list, npm/pnpm/yarn
// root -g) — slower than bun's 5s default; give it headroom.
setDefaultTimeout(60_000)

describe('WS5 — new-version banner is one-command', () => {
  const fixture: {
    tmp: string
  } = {
    tmp: '',
  }
  const origBase = pathManager.getGlobalBasePath()

  beforeEach(async () => {
    fixture.tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-banner-'))
    pathManager.setGlobalBaseDir(fixture.tmp)
    await fs.mkdir(path.join(fixture.tmp, 'config'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.tmp, 'config', 'update-cache.json'),
      JSON.stringify({ lastCheck: Date.now(), latestVersion: '99.0.0' })
    )
  })
  afterEach(async () => {
    pathManager.setGlobalBaseDir(origBase)
    await fs.rm(fixture.tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('recommends `prjct upgrade`, never `npm install -g`', () => {
    const banner = getUpdateNotificationSync('1.0.0')
    expect(banner).not.toBeNull()
    expect(banner).toContain('prjct upgrade')
    expect(banner).not.toContain('npm install -g')
    expect(banner).toContain('99.0.0') // the cached latest
  })
})

describe('WS4 — consolidateInstalls', () => {
  it('--no-cleanup (off) deterministically skips, no errors', async () => {
    const r = await consolidateInstalls('off', false, false)
    expect(r.errors).toEqual([])
    expect(r.details.join(' ')).toContain('--no-cleanup')
  })

  it('dry-run never removes — only reports intent', async () => {
    // dry-run must not shell out to any uninstall; details only.
    const r = await consolidateInstalls('auto', true, false)
    expect(r.errors).toEqual([])
    for (const d of r.details) expect(d).not.toContain('Removed redundant')
  })

  it('planCleanup() is defensive: never throws, well-formed shape', () => {
    const plan = planCleanup()
    expect(Array.isArray(plan.removable)).toBe(true)
    expect(Array.isArray(plan.skipped)).toBe(true)
    // Safety invariant: nothing is ever removable without a winner.
    if (plan.winner === null) expect(plan.removable).toEqual([])
  })
})

/** Pure prefix ownership for fixtures (no realpath / no disk). */
function prefixOwns(installRoot: string | null | undefined, winnerReal: string | null): boolean {
  if (!installRoot || !winnerReal) return false
  return winnerReal === installRoot || winnerReal.startsWith(`${installRoot}/`)
}

function loc(
  name: CleanupLocation['name'],
  installRoot: string,
  version = '1.0.0'
): CleanupLocation {
  return { name, installRoot, version }
}

describe('planCleanupFrom — install winner invariants', () => {
  it('refuses all removals when neither winnerReal nor winnerPm is known', () => {
    const plan = planCleanupFrom({
      winnerReal: null,
      winnerPm: null,
      locations: [
        loc('npm', '/opt/npm/lib/node_modules'),
        loc('bun', '/Users/x/.bun/install/global/node_modules'),
      ],
      brewInstalled: false,
      sourceRoot: '/dev/src',
      ownsWinner: prefixOwns,
      resolvePath: (p) => p,
    })
    expect(plan.winner).toBeNull()
    expect(plan.removable).toEqual([])
    expect(plan.skipped[0]?.reason).toMatch(/refusing to remove/i)
  })

  it('never lists the PATH-winner PM as removable', () => {
    // Use non-Homebrew paths so brew-path heuristics do not fire.
    const npmRoot = '/usr/local/lib/node_modules'
    const plan = planCleanupFrom({
      winnerReal: `${npmRoot}/prjct-cli/bin/prjct.js`,
      winnerPm: 'npm',
      locations: [
        loc('npm', npmRoot, '3.35.0'),
        loc('bun', '/Users/x/.bun/install/global/node_modules', '3.34.0'),
      ],
      brewInstalled: false,
      sourceRoot: '/dev/src',
      ownsWinner: prefixOwns,
      resolvePath: (p) => p,
    })
    expect(plan.winner).toBe('npm')
    expect(plan.removable.map((r) => r.pm)).toEqual(['bun'])
    expect(plan.removable.map((r) => r.pm)).not.toContain('npm')
  })

  it('prefers path ownership over mis-detected winnerPm (keeps A, removes B)', () => {
    // Dogfood footgun: which prjct → npm, but detectInstaller said bun.
    const npmRoot = '/usr/local/lib/node_modules'
    const bunRoot = '/Users/x/.bun/install/global/node_modules'
    const plan = planCleanupFrom({
      winnerReal: `${npmRoot}/prjct-cli/bin/prjct.js`,
      winnerPm: 'bun',
      locations: [loc('npm', npmRoot), loc('bun', bunRoot)],
      brewInstalled: false,
      sourceRoot: '/dev/src',
      ownsWinner: prefixOwns,
      resolvePath: (p) => p,
    })
    expect(plan.winner).toBe('npm')
    expect(plan.removable.map((r) => r.pm)).toEqual(['bun'])
    expect(plan.skipped.some((s) => s.pm === 'npm')).toBe(true)
  })

  it('keeps winnerPm by name only when winnerReal is unknown', () => {
    const plan = planCleanupFrom({
      winnerReal: null,
      winnerPm: 'pnpm',
      locations: [
        loc('pnpm', '/Users/x/Library/pnpm/global/5/node_modules'),
        loc('npm', '/usr/local/lib/node_modules'),
      ],
      brewInstalled: false,
      sourceRoot: '/dev/src',
      ownsWinner: prefixOwns,
      resolvePath: (p) => p,
    })
    expect(plan.winner).toBe('pnpm')
    expect(plan.removable.map((r) => r.pm)).toEqual(['npm'])
  })

  it('never removes the dev source tree even when it is not the winner PM', () => {
    const src = '/Users/x/Apps/prjct/prjct-cli'
    const npmRoot = '/usr/local/lib/node_modules'
    // yarn "install" is actually a link into the source tree.
    const yarnRoot = '/Users/x/.config/yarn/global/node_modules'
    const plan = planCleanupFrom({
      winnerReal: `${npmRoot}/prjct-cli/bin/prjct.js`,
      winnerPm: 'npm',
      locations: [loc('npm', npmRoot), loc('yarn', yarnRoot)],
      brewInstalled: false,
      sourceRoot: src,
      ownsWinner: prefixOwns,
      resolvePath: (p) => (p === `${yarnRoot}/prjct-cli` ? src : p),
    })
    expect(plan.winner).toBe('npm')
    expect(plan.removable.map((r) => r.pm)).not.toContain('yarn')
    expect(plan.skipped.some((s) => s.pm === 'yarn' && /dev source tree/i.test(s.reason))).toBe(
      true
    )
  })

  it('does not treat Homebrew-node npm global as brew winner', () => {
    // Real dogfood: Node from Homebrew puts npm globals under
    // /opt/homebrew/lib/node_modules — that is still an npm install, not brew.
    const npmRoot = '/opt/homebrew/lib/node_modules'
    const plan = planCleanupFrom({
      winnerReal: `${npmRoot}/prjct-cli/bin/prjct.js`,
      winnerPm: 'npm',
      locations: [loc('npm', npmRoot), loc('bun', '/Users/x/.bun/install/global/node_modules')],
      brewInstalled: false,
      sourceRoot: '/dev/src',
      ownsWinner: prefixOwns,
      resolvePath: (p) => p,
    })
    expect(plan.winner).toBe('npm')
    expect(plan.removable.map((r) => r.pm)).toEqual(['bun'])
  })

  it('keeps brew when PATH winner is a Cellar binary; marks other PMs removable', () => {
    const plan = planCleanupFrom({
      winnerReal: '/opt/homebrew/Cellar/prjct-cli/3.35.0/bin/prjct',
      winnerPm: null,
      locations: [loc('npm', '/usr/local/lib/node_modules')],
      brewInstalled: true,
      sourceRoot: '/dev/src',
      ownsWinner: prefixOwns,
      resolvePath: (p) => p,
    })
    expect(plan.winner).toBe('brew')
    expect(plan.removable.map((r) => r.pm)).toContain('npm')
    expect(plan.removable.map((r) => r.pm)).not.toContain('brew')
    expect(plan.skipped.some((s) => s.pm === 'brew')).toBe(true)
  })

  it('proposes brew removal only when brew is installed and not the winner', () => {
    const npmRoot = '/usr/local/lib/node_modules'
    const plan = planCleanupFrom({
      winnerReal: `${npmRoot}/prjct-cli/bin/prjct.js`,
      winnerPm: 'npm',
      locations: [loc('npm', npmRoot)],
      brewInstalled: true,
      sourceRoot: '/dev/src',
      ownsWinner: prefixOwns,
      resolvePath: (p) => p,
    })
    expect(plan.winner).toBe('npm')
    expect(plan.removable.map((r) => r.pm)).toContain('brew')
  })

  it('Windows path ownership: keeps AppData npm winner, removes bun', () => {
    // Simulates case-insensitive NTFS + backslash paths via prefixOwns-style check.
    const npmRoot = 'C:/Users/Dev/AppData/Roaming/npm/node_modules'
    const bunRoot = 'C:/Users/Dev/.bun/install/global/node_modules'
    const ownsWin = (root: string | null | undefined, win: string | null) => {
      if (!root || !win) return false
      const r = root.replace(/\\/g, '/').toLowerCase()
      const w = win.replace(/\\/g, '/').toLowerCase()
      return w === r || w.startsWith(`${r}/`)
    }
    const plan = planCleanupFrom({
      winnerReal: `${npmRoot}/prjct-cli/bin/prjct.js`,
      winnerPm: 'bun', // mis-detect common when process.execPath is bun
      locations: [loc('npm', npmRoot), loc('bun', bunRoot)],
      brewInstalled: false,
      sourceRoot: 'C:/Users/Dev/src/prjct-cli',
      ownsWinner: ownsWin,
      resolvePath: (p) => p.replace(/\\/g, '/'),
    })
    expect(plan.winner).toBe('npm')
    expect(plan.removable.map((r) => r.pm)).toEqual(['bun'])
  })

  it('Linuxbrew Cellar path is brew winner', () => {
    const plan = planCleanupFrom({
      winnerReal: '/home/linuxbrew/.linuxbrew/Cellar/prjct-cli/3.35.0/bin/prjct',
      winnerPm: null,
      locations: [loc('npm', '/usr/lib/node_modules')],
      brewInstalled: true,
      sourceRoot: '/home/dev/src',
      ownsWinner: prefixOwns,
      resolvePath: (p) => p,
    })
    expect(plan.winner).toBe('brew')
    expect(plan.removable.map((r) => r.pm)).toContain('npm')
  })
})

describe('prjct update — non-fatal legacy project warnings', () => {
  const originalLog = console.log

  afterEach(() => {
    console.log = originalLog
  })

  it('does not fail the update when cleanup only has legacy migration warnings', () => {
    console.log = () => {}

    const result = formatMdOutput(
      {
        phase1: { success: true, details: ['package ok'], errors: [] },
        phase2: {
          success: true,
          details: ['2 project(s) checked, 1 already on SQLite'],
          errors: [],
          warnings: ['legacy1: unable to open database file'],
        },
        phase3: { success: true, details: ['daemon ok'], errors: [] },
      },
      false
    )

    expect(result.success).toBe(true)
    expect(result.message).toBe('System updated')
  })

  it('still fails the update when cleanup has real errors', () => {
    console.log = () => {}

    const result = formatMdOutput(
      {
        phase1: { success: true, details: ['package ok'], errors: [] },
        phase2: {
          success: false,
          details: ['cleanup ran'],
          errors: ['Commands: permission denied'],
          warnings: ['legacy1: unable to open database file'],
        },
        phase3: { success: true, details: ['daemon ok'], errors: [] },
      },
      false
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('Updated with errors')
  })
})
