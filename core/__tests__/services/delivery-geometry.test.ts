import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  computeCommittedChangeset,
  computeWorkingTreeChangeset,
  geometryBlockMessage,
  geometryOf,
  intentGeometryVerdict,
  NORMAL_MAX_LOC,
  resolveReviewPayloadPaths,
  tierOf,
} from '../../services/delivery-geometry'

describe('delivery-geometry', () => {
  it('counts untracked lines so a large new file cannot route as trivial', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-untracked-loc-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'test@prjct.local'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: root })
      await fs.writeFile(path.join(root, 'base.txt'), 'base\n')
      execFileSync('git', ['add', '.'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root })
      await fs.writeFile(path.join(root, 'large-new.ts'), 'line\n'.repeat(NORMAL_MAX_LOC + 1))

      const changeset = await computeWorkingTreeChangeset(root)

      expect(changeset?.loc).toBe(NORMAL_MAX_LOC + 1)
      expect(changeset && tierOf(changeset)).toBe('large')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('resolves one review payload across committed, staged, unstaged, deleted and untracked paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-review-payload-'))
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    }
    try {
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 'test@prjct.local')
      git('config', 'user.name', 'test')
      await fs.writeFile(path.join(root, 'modified.ts'), 'base\n')
      await fs.writeFile(path.join(root, 'deleted.ts'), 'base\n')
      git('add', '.')
      git('commit', '-q', '-m', 'base')
      git('checkout', '-q', '-b', 'feature')
      await fs.writeFile(path.join(root, 'committed.ts'), 'committed\n')
      git('add', 'committed.ts')
      git('commit', '-q', '-m', 'committed change')

      await fs.writeFile(path.join(root, 'modified.ts'), 'dirty\n')
      await fs.writeFile(path.join(root, 'staged.ts'), 'staged\n')
      git('add', 'staged.ts')
      await fs.rm(path.join(root, 'deleted.ts'))
      await fs.writeFile(path.join(root, 'untracked.ts'), 'untracked\n')

      expect(await resolveReviewPayloadPaths(root)).toEqual([
        'committed.ts',
        'deleted.ts',
        'modified.ts',
        'staged.ts',
        'untracked.ts',
      ])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('finds committed payloads when the default branch is not main or master', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-review-trunk-'))
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    }
    try {
      git('init', '-q', '-b', 'trunk')
      git('config', 'user.email', 'test@prjct.local')
      git('config', 'user.name', 'test')
      await fs.writeFile(path.join(root, 'base.ts'), 'base\n')
      git('add', '.')
      git('commit', '-q', '-m', 'base')
      git('checkout', '-q', '-b', 'feature')
      await fs.writeFile(path.join(root, 'feature.ts'), 'feature\n')
      git('add', '.')
      git('commit', '-q', '-m', 'feature')
      if (process.platform !== 'win32') {
        await fs.writeFile(path.join(root, ' leading\\name.ts '), 'exact\n')
      }

      expect(await resolveReviewPayloadPaths(root)).toEqual(
        process.platform === 'win32' ? ['feature.ts'] : [' leading\\name.ts ', 'feature.ts']
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('does not let an auxiliary branch truncate earlier feature commits', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-review-auxiliary-'))
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    }
    try {
      git('init', '-q', '-b', 'trunk')
      git('config', 'user.email', 'test@prjct.local')
      git('config', 'user.name', 'test')
      await fs.writeFile(path.join(root, 'base.ts'), 'base\n')
      git('add', '.')
      git('commit', '-q', '-m', 'base')
      git('checkout', '-q', '-b', 'feature')
      await fs.writeFile(path.join(root, 'first.ts'), 'first\n')
      git('add', '.')
      git('commit', '-q', '-m', 'first feature commit')
      git('branch', 'backup')
      await fs.writeFile(path.join(root, 'second.ts'), 'second\n')
      git('add', '.')
      git('commit', '-q', '-m', 'second feature commit')
      git('branch', '-D', 'trunk')

      expect(await resolveReviewPayloadPaths(root)).toEqual(['first.ts', 'second.ts'])
      expect(await computeCommittedChangeset(root)).toMatchObject({ files: 2, loc: 2 })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('classifies tiers', () => {
    expect(tierOf({ files: 1, loc: 10 })).toBe('trivial')
    expect(tierOf({ files: 5, loc: 100 })).toBe('normal')
    expect(tierOf({ files: 2, loc: NORMAL_MAX_LOC + 1 })).toBe('large')
  })

  it('maps tiers to geometry', () => {
    expect(geometryOf('trivial')).toBe('direct')
    expect(geometryOf('normal')).toBe('single')
    expect(geometryOf('large')).toBe('split')
  })

  it('block message names the override flag', () => {
    const msg = geometryBlockMessage(
      { base: 'HEAD', files: 20, loc: 900, dirs: ['core', 'docs'], source: 'working-tree' },
      'split'
    )
    expect(msg).toContain('--geometry')
    expect(msg).toContain('900')
  })

  it('intent geometry: H3 without --geometry is advisory (mode off) / strict blocks', () => {
    const soft = intentGeometryVerdict({
      harnessLevel: 'H3',
      harnessRisk: 'high',
      mode: 'off',
      explicitGeometry: null,
    })
    expect(soft.blocked).toBe(false)
    expect(soft.reason).toBe('h2-intent-advisory')
    expect(soft.message).toMatch(/geometry|split|--geometry/i)

    const hard = intentGeometryVerdict({
      harnessLevel: 'H3',
      harnessRisk: 'high',
      mode: 'strict',
      explicitGeometry: null,
    })
    expect(hard.blocked).toBe(true)
    expect(hard.reason).toBe('h2-intent-strict')

    const ok = intentGeometryVerdict({
      harnessLevel: 'H3',
      mode: 'strict',
      explicitGeometry: 'split',
    })
    expect(ok.blocked).toBe(false)
    expect(ok.reason).toBe('has-geometry')
  })

  it('intent geometry: H0 and H2 medium risk skip when tree not large', () => {
    expect(
      intentGeometryVerdict({
        harnessLevel: 'H0',
        mode: 'strict',
        explicitGeometry: null,
      }).reason
    ).toBe('not-large')
    expect(
      intentGeometryVerdict({
        harnessLevel: 'H2',
        harnessRisk: 'medium',
        mode: 'advisory',
        explicitGeometry: null,
        treeLarge: false,
      }).reason
    ).toBe('not-large')
  })
})
