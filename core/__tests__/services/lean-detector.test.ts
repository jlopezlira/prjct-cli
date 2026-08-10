/**
 * Lean detector — tracks `lean:` simplification-marker growth, opt-in via
 * `config.lean.mode`. Pure mode-resolution + marker measurement, plus the
 * gating / first-run / growth-persist paths over a sandboxed tmp project.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import { projectMemory } from '../../memory/project-memory'
import { _internal, detectAndPersistLeanDebt } from '../../services/lean-detector'
import { execFileAsync } from '../../utils/exec'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

describe('lean-detector — pure', () => {
  it('effectiveMode: config wins, env fallback, unknown → off', () => {
    const saved = process.env.PRJCT_LEAN_MODE
    delete process.env.PRJCT_LEAN_MODE
    try {
      expect(_internal.effectiveMode({ lean: { mode: 'lite' } } as never)).toBe('lite')
      expect(_internal.effectiveMode(null)).toBe('off')
      expect(_internal.effectiveMode({} as never)).toBe('off')
      process.env.PRJCT_LEAN_MODE = 'full'
      expect(_internal.effectiveMode(null)).toBe('full')
    } finally {
      if (saved === undefined) delete process.env.PRJCT_LEAN_MODE
      else process.env.PRJCT_LEAN_MODE = saved
    }
  })
})

describe('lean-detector — integration', () => {
  const fixture: {
    dir: string
    globalRoot: string
    projectId: string
  } = {
    dir: '',
    globalRoot: '',
    projectId: '',
  }

  async function git(args: string[]): Promise<void> {
    await execFileAsync('git', args, { cwd: fixture.dir })
  }

  async function commitFile(name: string, content: string): Promise<void> {
    await fs.writeFile(path.join(fixture.dir, name), content)
    await git(['add', '.'])
    await git(['commit', '-q', '-m', name])
  }

  beforeEach(async () => {
    fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-leandet-'))
    fixture.globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-leandet-global-'))
    patchPathManager(fixture.globalRoot)
    await git(['init', '-q', '-b', 'main'])
    await git(['config', 'user.email', 't@example.com'])
    await git(['config', 'user.name', 'T'])
    await git(['config', 'commit.gpgsign', 'false'])
    await fs.mkdir(path.join(fixture.dir, '.prjct'), { recursive: true })
    fixture.projectId = `leandet-${Math.random().toString(36).slice(2, 10)}`
    await configManager.writeConfig(fixture.dir, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.dir, '.prjct-data'),
    })
  })

  afterEach(async () => {
    restorePathManager()
    await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(fixture.globalRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('measureLeanMarkers counts markers across tracked files', async () => {
    await commitFile('a.ts', '// lean: one\n// lean: two\nexport const a = 1\n')
    await commitFile('b.ts', '// lean: three\nexport const b = 2\n')
    const n = await _internal.measureLeanMarkers(fixture.dir)
    expect(n).toBe(3)
  }, 15_000)

  it('stays dormant when lean mode is off', async () => {
    await commitFile('a.ts', '// lean: x\nexport const a = 1\n')
    const r = await detectAndPersistLeanDebt(fixture.dir, { projectId: fixture.projectId } as never)
    expect(r.active).toBe(false)
    expect(r.persisted).toBe(false)
  }, 15_000)

  it('first run never flags (no previous snapshot)', async () => {
    await commitFile('a.ts', '// lean: x\n// lean: y\nexport const a = 1\n')
    const r = await detectAndPersistLeanDebt(fixture.dir, {
      projectId: fixture.projectId,
      lean: { mode: 'full' },
    } as never)
    expect(r.active).toBe(true)
    expect(r.total).toBe(2)
    expect(r.persisted).toBe(false)
  }, 15_000)

  it('flags growth past the threshold against the last snapshot', async () => {
    // Seed a previous snapshot of 1 marker, then grow to 4 (delta 3 >= 3).
    await projectMemory.remember(fixture.dir, {
      type: 'lean-debt',
      content: 'prior snapshot',
      tags: { source: 'lean-detector', total: '1' },
      provenance: 'inferred',
      projectId: fixture.projectId,
    })
    await commitFile('a.ts', '// lean: a\n// lean: b\n// lean: c\n// lean: d\nexport const a = 1\n')
    const r = await detectAndPersistLeanDebt(fixture.dir, {
      projectId: fixture.projectId,
      lean: { mode: 'full' },
    } as never)
    expect(r.active).toBe(true)
    expect(r.total).toBe(4)
    expect(r.previous).toBe(1)
    expect(r.persisted).toBe(true)
  }, 15_000)
})
