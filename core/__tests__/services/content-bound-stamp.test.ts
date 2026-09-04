/**
 * Content-bound stamp — pure hash + drift verdict (Dynasty D2).
 * Plus the ship-safety rule: git infra must not collapse to "unverified → pass".
 */

import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  BLOB_MISSING,
  buildTreeHash,
  CONTENT_BOUND_VERSION,
  contentBoundDriftVerdict,
  currentTreeHashForStamp,
  hashBlobContent,
  resolveStampPaths,
  stampForApprove,
  stampFromContents,
  stampProjectPaths,
} from '../../services/content-bound-stamp'
import { GitInfraError } from '../../utils/exec'

describe('content-bound-stamp', () => {
  it('binds executable mode and symlink target identity, not only dereferenced bytes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stamp-identity-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      execFileSync('git', ['config', 'core.filemode', 'true'], { cwd: root })
      await fs.writeFile(path.join(root, 'a.txt'), 'same\n')
      await fs.writeFile(path.join(root, 'b.txt'), 'same\n')
      await fs.writeFile(path.join(root, 'script.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o644 })
      await fs.symlink('a.txt', path.join(root, 'current.txt'))

      const modeStamp = await stampProjectPaths(root, ['script.sh'], { stampedAt: 't0' })
      await fs.chmod(path.join(root, 'script.sh'), 0o755)
      expect(await currentTreeHashForStamp(root, modeStamp)).not.toBe(modeStamp.treeHash)

      const linkStamp = await stampProjectPaths(root, ['current.txt'], { stampedAt: 't1' })
      await fs.unlink(path.join(root, 'current.txt'))
      await fs.symlink('b.txt', path.join(root, 'current.txt'))
      expect(await currentTreeHashForStamp(root, linkStamp)).not.toBe(linkStamp.treeHash)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('binds the checked-out commit of a dirty submodule', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stamp-gitlink-'))
    const main = path.join(root, 'main')
    const source = path.join(root, 'source')
    try {
      await fs.mkdir(main)
      await fs.mkdir(source)
      for (const repo of [main, source]) {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
        execFileSync('git', ['config', 'user.email', 'test@prjct.local'], { cwd: repo })
        execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
      }
      await fs.writeFile(path.join(source, 'version.txt'), 'one\n')
      execFileSync('git', ['add', '.'], { cwd: source })
      execFileSync('git', ['commit', '-q', '-m', 'one'], { cwd: source })
      execFileSync(
        'git',
        ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'vendor/sub'],
        { cwd: main }
      )
      execFileSync('git', ['commit', '-q', '-am', 'add submodule'], { cwd: main })

      const stamp = await stampProjectPaths(main, ['vendor/sub'], { stampedAt: 't0' })
      const checkout = path.join(main, 'vendor', 'sub')
      execFileSync('git', ['config', 'user.email', 'test@prjct.local'], { cwd: checkout })
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: checkout })
      await fs.writeFile(path.join(checkout, 'version.txt'), 'two\n')
      execFileSync('git', ['add', '.'], { cwd: checkout })
      execFileSync('git', ['commit', '-q', '-m', 'two'], { cwd: checkout })

      expect(await currentTreeHashForStamp(main, stamp)).not.toBe(stamp.treeHash)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('binds the full payload even when diagnostic path stamps are capped', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stamp-full-payload-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'test@prjct.local'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: root })
      await fs.writeFile(path.join(root, 'base.txt'), 'base\n')
      execFileSync('git', ['add', '.'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root })
      const paths = Array.from(
        { length: 205 },
        (_, index) => `payload-${String(index).padStart(3, '0')}.ts`
      )
      await Promise.all(
        paths.map((file) => fs.writeFile(path.join(root, file), `export const n = ${file}\n`))
      )

      const stamp = await stampForApprove(root, paths, 't0')
      expect(stamp.pathCount).toBe(205)
      expect(stamp.paths).toHaveLength(200)

      await fs.writeFile(path.join(root, paths[204]!), 'changed outside diagnostic sample\n')
      expect(await currentTreeHashForStamp(root, stamp)).not.toBe(stamp.treeHash)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('binds fix-round paths added outside the originally frozen review scope', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stamp-fix-union-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'test@prjct.local'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: root })
      await fs.writeFile(path.join(root, 'base.ts'), 'base\n')
      execFileSync('git', ['add', '.'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root })
      execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root })
      await fs.writeFile(path.join(root, 'implementation.ts'), 'implementation\n')
      const frozenScope = ['implementation.ts']
      await fs.writeFile(path.join(root, 'implementation.test.ts'), 'regression\n')

      const stamp = await stampForApprove(root, frozenScope, 't0')

      expect(stamp.paths.map((entry) => entry.path)).toEqual([
        'implementation.test.ts',
        'implementation.ts',
      ])
      expect(await currentTreeHashForStamp(root, stamp)).toBe(stamp.treeHash)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('uses the final payload when a frozen review path was reverted during fixes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stamp-reverted-fix-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'test@prjct.local'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: root })
      await fs.writeFile(path.join(root, 'a.ts'), 'base a\n')
      await fs.writeFile(path.join(root, 'b.ts'), 'base b\n')
      execFileSync('git', ['add', '.'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root })
      await fs.writeFile(path.join(root, 'a.ts'), 'changed a\n')
      await fs.writeFile(path.join(root, 'b.ts'), 'changed b\n')
      const frozenScope = ['a.ts', 'b.ts']
      execFileSync('git', ['checkout', 'HEAD', '--', 'a.ts'], { cwd: root })

      const stamp = await stampForApprove(root, frozenScope, 't0')

      expect(stamp.paths.map((entry) => entry.path)).toEqual(['b.ts'])
      expect(await currentTreeHashForStamp(root, stamp)).toBe(stamp.treeHash)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('hashes blob content deterministically', () => {
    expect(hashBlobContent('hello')).toBe(hashBlobContent('hello'))
    expect(hashBlobContent('hello')).not.toBe(hashBlobContent('world'))
    expect(hashBlobContent(null)).toBe(BLOB_MISSING)
  })

  it('treeHash is order-independent and content-sensitive', () => {
    const a = buildTreeHash([
      { path: 'b.ts', blobHash: 'bbb' },
      { path: 'a.ts', blobHash: 'aaa' },
    ])
    const b = buildTreeHash([
      { path: 'a.ts', blobHash: 'aaa' },
      { path: 'b.ts', blobHash: 'bbb' },
    ])
    expect(a).toBe(b)
    const c = buildTreeHash([
      { path: 'a.ts', blobHash: 'aaa' },
      { path: 'b.ts', blobHash: 'CHANGED' },
    ])
    expect(c).not.toBe(a)
  })

  it('stampFromContents is stable for same inputs', () => {
    const s1 = stampFromContents(
      [
        { path: './src/x.ts', content: 'export const x = 1\n' },
        { path: 'src/y.ts', content: 'export const y = 2\n' },
      ],
      { stampedAt: 't0' }
    )
    const s2 = stampFromContents(
      [
        { path: 'src/y.ts', content: 'export const y = 2\n' },
        { path: 'src/x.ts', content: 'export const x = 1\n' },
      ],
      { stampedAt: 't1' }
    )
    expect(s1.treeHash).toBe(s2.treeHash)
    expect(s1.pathCount).toBe(2)
    expect(s1.version).toBe(CONTENT_BOUND_VERSION)
    expect(s1.paths.every((p) => p.blobHash !== BLOB_MISSING)).toBe(true)
  })

  it('preserves valid POSIX backslashes and surrounding spaces in paths', () => {
    if (process.platform === 'win32') return
    const exactPath = ' leading\\name.ts '
    const stamp = stampFromContents([{ path: exactPath, content: 'ok' }], { stampedAt: 't0' })

    expect(stamp.paths[0]?.path).toBe(exactPath)
    expect(stamp.pathCount).toBe(1)
  })

  it('stamp changes when file content changes', () => {
    const before = stampFromContents([{ path: 'a.ts', content: 'v1' }], { stampedAt: 't0' })
    const after = stampFromContents([{ path: 'a.ts', content: 'v2' }], { stampedAt: 't1' })
    expect(after.treeHash).not.toBe(before.treeHash)
  })

  it('drift verdict matches / hard-blocks on mismatch', () => {
    const stamp = stampFromContents([{ path: 'a.ts', content: 'ok' }], { stampedAt: 't0' })
    const match = contentBoundDriftVerdict({
      stamp,
      currentTreeHash: stamp.treeHash,
      hard: true,
    })
    expect(match.blocked).toBe(false)
    expect(match.reason).toBe('match')

    const drift = contentBoundDriftVerdict({
      stamp,
      currentTreeHash: 'deadbeef'.repeat(8),
      hard: true,
    })
    expect(drift.blocked).toBe(true)
    expect(drift.reason).toBe('drift')
    expect(drift.message).toMatch(/Content-bound drift|re-approve|judgment approve/i)

    const soft = contentBoundDriftVerdict({
      stamp,
      currentTreeHash: 'deadbeef'.repeat(8),
      hard: false,
    })
    expect(soft.blocked).toBe(false)
    expect(soft.reason).toBe('drift')

    const override = contentBoundDriftVerdict({
      stamp,
      currentTreeHash: 'deadbeef'.repeat(8),
      hard: true,
      override: true,
    })
    expect(override.blocked).toBe(false)
    expect(override.reason).toBe('override')
  })

  it('no-stamp hard-blocks under code-strict (A1); soft when not hard', () => {
    const hard = contentBoundDriftVerdict({ stamp: null, currentTreeHash: 'x', hard: true })
    expect(hard.blocked).toBe(true)
    expect(hard.reason).toBe('no-stamp')
    expect(
      contentBoundDriftVerdict({ stamp: null, currentTreeHash: 'x', hard: false }).blocked
    ).toBe(false)
  })

  it('unverified still does not hard-block (IO advisory)', () => {
    const stamp = stampFromContents([{ path: 'a.ts', content: 'ok' }], { stampedAt: 't0' })
    const u = contentBoundDriftVerdict({
      stamp,
      currentTreeHash: null,
      hard: true,
    })
    expect(u.blocked).toBe(false)
    expect(u.reason).toBe('unverified')
  })
})

/**
 * PATH-hijack: empty dir as PATH → git spawn ENOENT (real infra failure).
 */
async function withBrokenGit<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-no-git-'))
  const oldPath = process.env.PATH
  process.env.PATH = dir
  try {
    return await fn()
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

describe('content-bound stamp — git infra must not fail-open', () => {
  it('resolveStampPaths throws GitInfraError when git cannot spawn', async () => {
    if (process.platform === 'win32') return
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stamp-'))
    try {
      await withBrokenGit(async () => {
        await expect(resolveStampPaths(dir, null)).rejects.toBeInstanceOf(GitInfraError)
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('currentTreeHashForStamp rethrows GitInfraError (empty-path fallback)', async () => {
    if (process.platform === 'win32') return
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stamp-'))
    try {
      // Empty paths force resolveStampPaths → git. A pure stamp with no
      // recorded paths is the fail-open footgun if git collapses to null.
      const stamp = stampFromContents([], { stampedAt: 't0' })
      await withBrokenGit(async () => {
        await expect(currentTreeHashForStamp(dir, stamp)).rejects.toBeInstanceOf(GitInfraError)
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
