/**
 * `prjct lean` — anti-over-engineering surface (prjct-native ponytail).
 *
 * Pure heuristic core (smells + flags + mode resolution) plus integration
 * smoke over a real tmp git repo for mode round-trip, the diff review, and
 * the debt ledger. Storage is sandboxed under a tmp root via the canonical
 * pathManager patch so no DB lands in ~/.prjct-cli.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _internal, LeanCommands } from '../../commands/lean'
import { REGISTERED_VERBS_SET } from '../../commands/verb-names'
import configManager from '../../infrastructure/config-manager'
import { projectMemory } from '../../memory/project-memory'
import { execFileAsync } from '../../utils/exec'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

describe('lean — pure heuristics', () => {
  it('effectiveMode: config wins, env is the fallback, unknown → off', () => {
    const saved = process.env.PRJCT_LEAN_MODE
    delete process.env.PRJCT_LEAN_MODE
    try {
      expect(_internal.effectiveMode({ lean: { mode: 'full' } } as never)).toBe('full')
      expect(_internal.effectiveMode(null)).toBe('off')
      expect(_internal.effectiveMode({ lean: { mode: 'bogus' } } as never)).toBe('off')
      process.env.PRJCT_LEAN_MODE = 'ultra'
      expect(_internal.effectiveMode(null)).toBe('ultra')
    } finally {
      if (saved === undefined) delete process.env.PRJCT_LEAN_MODE
      else process.env.PRJCT_LEAN_MODE = saved
    }
  })

  it('scanDiffSmells counts new files, deps, lean markers, and LOC', () => {
    const diff = [
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '+    "left-pad": "^1.0.0",',
      'diff --git a/note.ts b/note.ts',
      '--- /dev/null',
      '+++ b/note.ts',
      '+// lean: stubbed; upgrade to the real impl later',
      '+export const x = 1',
    ].join('\n')
    const nameStatus = ['A\tnote.ts', 'M\tpackage.json'].join('\n')
    const s = _internal.scanDiffSmells(diff, nameStatus)
    expect(s.addedFiles).toBe(1)
    expect(s.newDeps).toBe(1)
    expect(s.leanMarkers).toBe(1)
    expect(s.loc).toBe(3)
  })

  it('leanFlags surfaces deps + markers, stays silent when clean', () => {
    const flags = _internal.leanFlags({ loc: 3, addedFiles: 1, newDeps: 1, leanMarkers: 1 })
    expect(flags.length).toBe(2)
    expect(flags.some((f) => /dependency/i.test(f))).toBe(true)
    expect(flags.some((f) => /marker/i.test(f))).toBe(true)
    expect(_internal.leanFlags({ loc: 10, addedFiles: 1, newDeps: 0, leanMarkers: 0 })).toEqual([])
  })

  it('is a registered verb (so it never auto-captures to the inbox)', () => {
    expect(REGISTERED_VERBS_SET.has('lean')).toBe(true)
  })
})

describe('lean — integration (git + storage)', () => {
  const fixture: {
    dir: string
    globalRoot: string
  } = {
    dir: '',
    globalRoot: '',
  }

  const cmd = new LeanCommands()

  async function git(args: string[]): Promise<void> {
    await execFileAsync('git', args, { cwd: fixture.dir })
  }

  beforeEach(async () => {
    fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-lean-'))
    fixture.globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-lean-global-'))
    patchPathManager(fixture.globalRoot)
    await git(['init', '-q', '-b', 'main'])
    await git(['config', 'user.email', 't@example.com'])
    await git(['config', 'user.name', 'T'])
    await git(['config', 'commit.gpgsign', 'false'])
    await fs.mkdir(path.join(fixture.dir, '.prjct'), { recursive: true })
    await configManager.writeConfig(fixture.dir, {
      projectId: `lean-${Math.random().toString(36).slice(2, 10)}`,
      dataPath: path.join(fixture.dir, '.prjct-data'),
    })
  })

  afterEach(async () => {
    restorePathManager()
    await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(fixture.globalRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('sets and reports the intensity mode (round-trip via config)', async () => {
    const set = await cmd.lean('full', fixture.dir, { md: true })
    expect(set.success).toBe(true)
    expect(set.mode).toBe('full')
    const config = await configManager.readConfig(fixture.dir)
    expect(config?.lean?.mode).toBe('full')
    const status = await cmd.lean(null, fixture.dir, { md: true })
    expect(status.mode).toBe('full')
  }, 15_000)

  it('review flags new files, a new dep, and a lean marker on a feature branch', async () => {
    await fs.writeFile(
      path.join(fixture.dir, 'package.json'),
      JSON.stringify({ name: 't', dependencies: {} }, null, 2)
    )
    await git(['add', '.'])
    await git(['commit', '-q', '-m', 'seed'])
    await git(['checkout', '-q', '-b', 'feat/x'])
    await fs.writeFile(path.join(fixture.dir, 'mod1.ts'), 'export const a = 1\n')
    await fs.writeFile(path.join(fixture.dir, 'mod2.ts'), 'export const b = 2\n')
    await fs.writeFile(
      path.join(fixture.dir, 'note.ts'),
      '// lean: stub; upgrade later\nexport const c = 3\n'
    )
    await fs.writeFile(
      path.join(fixture.dir, 'package.json'),
      JSON.stringify({ name: 't', dependencies: { 'left-pad': '^1.0.0' } }, null, 2)
    )
    await git(['add', '.'])
    await git(['commit', '-q', '-m', 'feat'])

    const r = await cmd.lean('review', fixture.dir, { md: true })
    expect(r.success).toBe(true)
    const s = r.smells as { addedFiles: number; newDeps: number; leanMarkers: number; loc: number }
    expect(s.addedFiles).toBeGreaterThanOrEqual(3)
    expect(s.newDeps).toBeGreaterThanOrEqual(1)
    expect(s.leanMarkers).toBeGreaterThanOrEqual(1)
  }, 15_000)

  it('review reports no-signal when there is nothing to review', async () => {
    await fs.writeFile(path.join(fixture.dir, 'a.txt'), 'x')
    await git(['add', '.'])
    await git(['commit', '-q', '-m', 'init'])
    const r = await cmd.lean('review', fixture.dir, { md: true })
    expect(r.success).toBe(true)
    expect((r.smells as { loc: number }).loc).toBe(0)
  }, 15_000)

  it('debt lists logged lean-debt memories and lean: markers in source', async () => {
    await fs.writeFile(
      path.join(fixture.dir, 'svc.ts'),
      '// lean: hardcoded; make configurable later\nexport const v = 1\n'
    )
    await git(['add', '.'])
    await git(['commit', '-q', '-m', 'seed'])

    const config = await configManager.readConfig(fixture.dir)
    await projectMemory.remember(fixture.dir, {
      type: 'lean-debt',
      content: 'Deferred: replaced custom parser with a one-liner; revisit if perf matters.',
      projectId: config!.projectId,
    })

    const r = await cmd.lean('debt', fixture.dir, { md: true })
    expect(r.success).toBe(true)
    expect(r.markers).toBeGreaterThanOrEqual(1)
    expect(r.logged).toBeGreaterThanOrEqual(1)
  }, 15_000)

  it('rejects an unknown subcommand', async () => {
    const r = await cmd.lean('frobnicate', fixture.dir, { md: true })
    expect(r.success).toBe(false)
  })
})
