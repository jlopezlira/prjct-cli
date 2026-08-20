import { describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  assertRemoteDefaultBranchIncluded,
  bumpMajor,
  bumpMinor,
  bumpPatch,
  bumpVersion,
  inferBumpLevel,
  VersionService,
} from '../../services/version-service'
import { execFileAsync } from '../../utils/exec'

describe('bumpMinor / bumpMajor', () => {
  it('bumpMinor resets patch and drops pre-release', () => {
    expect(bumpMinor('2.32.8')).toBe('2.33.0')
    expect(bumpMinor('1.0.5')).toBe('1.1.0')
    expect(bumpMinor('2.0.0-alpha.3')).toBe('2.1.0')
  })
  it('bumpMajor resets minor+patch', () => {
    expect(bumpMajor('2.32.8')).toBe('3.0.0')
    expect(bumpMajor('0.9.9')).toBe('1.0.0')
  })
  it('bumpVersion dispatches by level', () => {
    expect(bumpVersion('2.32.8', 'patch')).toBe('2.32.9')
    expect(bumpVersion('2.32.8', 'minor')).toBe('2.33.0')
    expect(bumpVersion('2.32.8', 'major')).toBe('3.0.0')
  })
})

describe('inferBumpLevel', () => {
  it('treats a described feature ship as minor', () => {
    expect(inferBumpLevel('embeddings BYOT support')).toBe('minor')
    expect(inferBumpLevel('feat: add semantic search')).toBe('minor')
  })
  it('defaults to patch with no description (conservative)', () => {
    expect(inferBumpLevel(undefined)).toBe('patch')
    expect(inferBumpLevel('')).toBe('patch')
  })
  it('treats fix/chore/docs-class prefixes as patch', () => {
    expect(inferBumpLevel('fix: dedup key bug')).toBe('patch')
    expect(inferBumpLevel('chore: bump deps')).toBe('patch')
    expect(inferBumpLevel('docs(readme): update')).toBe('patch')
    expect(inferBumpLevel('refactor: extract helper')).toBe('patch')
  })
  it('treats `!` or BREAKING CHANGE as major', () => {
    expect(inferBumpLevel('feat!: drop node 18')).toBe('major')
    expect(inferBumpLevel('feat: x\n\nBREAKING CHANGE: removed API')).toBe('major')
  })
})

describe('bumpPatch', () => {
  it('bumps stable patch', () => {
    expect(bumpPatch('1.2.3')).toBe('1.2.4')
    expect(bumpPatch('0.0.0')).toBe('0.0.1')
    expect(bumpPatch('10.20.30')).toBe('10.20.31')
  })

  it('increments trailing numeric identifier in prerelease', () => {
    expect(bumpPatch('2.0.0-alpha.12')).toBe('2.0.0-alpha.13')
    expect(bumpPatch('1.0.0-rc.0')).toBe('1.0.0-rc.1')
    expect(bumpPatch('3.1.4-beta.99')).toBe('3.1.4-beta.100')
  })

  it('appends .1 to prerelease without numeric tail', () => {
    expect(bumpPatch('0.1.0-beta')).toBe('0.1.0-beta.1')
    expect(bumpPatch('1.0.0-alpha')).toBe('1.0.0-alpha.1')
    expect(bumpPatch('2.0.0-rc')).toBe('2.0.0-rc.1')
  })

  it('handles multi-segment prerelease with numeric tail', () => {
    expect(bumpPatch('1.0.0-alpha.beta.5')).toBe('1.0.0-alpha.beta.6')
  })

  it('appends .1 when multi-segment prerelease ends non-numerically', () => {
    expect(bumpPatch('1.0.0-alpha.beta')).toBe('1.0.0-alpha.beta.1')
  })

  it('drops build metadata on bump', () => {
    expect(bumpPatch('1.2.3+build.42')).toBe('1.2.4')
    expect(bumpPatch('2.0.0-alpha.1+sha.abc')).toBe('2.0.0-alpha.2')
  })

  it('returns unchanged when input is not a valid semver', () => {
    expect(bumpPatch('not-a-version')).toBe('not-a-version')
    expect(bumpPatch('1.2')).toBe('1.2')
    expect(bumpPatch('')).toBe('')
    expect(bumpPatch('v1.2.3')).toBe('v1.2.3')
  })

  it('does NOT regress prerelease to stable (P0 guard)', () => {
    expect(bumpPatch('2.0.0-alpha.12')).not.toBe('2.0.1')
    expect(bumpPatch('1.0.0-rc.1')).not.toBe('1.0.1')
  })
})

// VersionService.bump idempotency — prevents the "double-bump on ship retry"
// failure mode where v2.4.39 → v2.4.41 → v2.4.43 stacks across runs.

interface VersionRepositoryFixture {
  dir: string
  commitPkg(version: string): Promise<void>
  readPkgVersion(): Promise<string>
}

async function withVersionRepository<T>(
  prefix: string,
  run: (fixture: VersionRepositoryFixture) => Promise<T>
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })

    const commitPkg = async (version: string): Promise<void> => {
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ version }, null, 2))
      await execFileAsync('git', ['add', 'package.json'], { cwd: dir })
      await execFileAsync('git', ['commit', '-q', '-m', `v${version}`], { cwd: dir })
    }
    const readPkgVersion = async (): Promise<string> => {
      const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf-8')
      return (JSON.parse(raw) as { version: string }).version
    }

    return await run({ dir, commitPkg, readPkgVersion })
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

describe('VersionService.bump (idempotency)', () => {
  it('bumps normally when working tree matches HEAD', async () => {
    await withVersionRepository('prjct-version-', async ({ dir, commitPkg, readPkgVersion }) => {
      await commitPkg('1.2.3')
      const next = await new VersionService(dir).bump()
      expect(next).toBe('1.2.4')
      expect(await readPkgVersion()).toBe('1.2.4')
    })
  })

  it('returns working-tree version unchanged when already ahead of HEAD', async () => {
    await withVersionRepository('prjct-version-', async ({ dir, commitPkg, readPkgVersion }) => {
      // Simulate a partial-ship: HEAD is 1.2.3 but working tree was bumped to 1.2.4.
      await commitPkg('1.2.3')
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ version: '1.2.4' }, null, 2)
      )

      // Retry: should NOT bump to 1.2.5.
      const next = await new VersionService(dir).bump()
      expect(next).toBe('1.2.4')
      expect(await readPkgVersion()).toBe('1.2.4')
    })
  })

  it('still bumps when working tree equals HEAD even after multi-bump history', async () => {
    await withVersionRepository('prjct-version-', async ({ dir, commitPkg }) => {
      // Successful prior ship: HEAD is 1.2.4, working tree is 1.2.4.
      // Next ship should bump normally to 1.2.5.
      await commitPkg('1.2.3')
      await commitPkg('1.2.4')
      const next = await new VersionService(dir).bump()
      expect(next).toBe('1.2.5')
    })
  })

  it('falls back to normal bump when no git HEAD exists', async () => {
    await withVersionRepository('prjct-version-', async ({ dir }) => {
      // Fresh repo with no commits — package.json is untracked.
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ version: '0.1.0' }, null, 2)
      )
      const next = await new VersionService(dir).bump()
      expect(next).toBe('0.1.1')
    })
  })

  it('rejects before writing when the candidate tag already exists locally', async () => {
    await withVersionRepository(
      'prjct-version-tag-',
      async ({ dir, commitPkg, readPkgVersion }) => {
        await commitPkg('1.2.3')
        await execFileAsync('git', ['tag', 'v1.2.4'], { cwd: dir })

        await expect(new VersionService(dir).bump()).rejects.toThrow(
          /Release v1\.2\.4 already exists as a local Git tag/
        )
        expect(await readPkgVersion()).toBe('1.2.3')
      }
    )
  })

  it('rejects before writing when the candidate tag exists only on a remote', async () => {
    await withVersionRepository(
      'prjct-version-remote-tag-',
      async ({ dir, commitPkg, readPkgVersion }) => {
        await commitPkg('1.2.3')
        const remoteDir = path.join(dir, 'origin.git')
        await execFileAsync('git', ['init', '-q', '--bare', remoteDir], { cwd: dir })
        await execFileAsync('git', ['remote', 'add', 'origin', remoteDir], { cwd: dir })
        await execFileAsync('git', ['tag', 'v1.2.4'], { cwd: dir })
        await execFileAsync('git', ['push', '-q', 'origin', 'refs/tags/v1.2.4'], { cwd: dir })
        await execFileAsync('git', ['tag', '-d', 'v1.2.4'], { cwd: dir })

        await expect(new VersionService(dir).bump()).rejects.toThrow(
          /Release v1\.2\.4 already exists on Git remote origin/
        )
        expect(await readPkgVersion()).toBe('1.2.3')
      }
    )
  })
})

describe('assertRemoteDefaultBranchIncluded', () => {
  it('accepts a branch that includes the refreshed remote default branch', async () => {
    await withVersionRepository('prjct-version-base-', async ({ dir, commitPkg }) => {
      await commitPkg('1.2.3')
      const remoteDir = path.join(dir, 'origin.git')
      await execFileAsync('git', ['init', '-q', '--bare', remoteDir], { cwd: dir })
      await execFileAsync(
        'git',
        ['--git-dir', remoteDir, 'symbolic-ref', 'HEAD', 'refs/heads/main'],
        {
          cwd: dir,
        }
      )
      await execFileAsync('git', ['remote', 'add', 'origin', remoteDir], { cwd: dir })
      await execFileAsync('git', ['push', '-q', 'origin', 'main'], { cwd: dir })

      await expect(assertRemoteDefaultBranchIncluded(dir)).resolves.toBeUndefined()
    })
  })

  it('blocks a stale ship branch even before the newer release has a tag', async () => {
    await withVersionRepository('prjct-version-stale-base-', async ({ dir, commitPkg }) => {
      await commitPkg('1.2.3')
      const remoteDir = path.join(dir, 'origin.git')
      await execFileAsync('git', ['init', '-q', '--bare', remoteDir], { cwd: dir })
      await execFileAsync(
        'git',
        ['--git-dir', remoteDir, 'symbolic-ref', 'HEAD', 'refs/heads/main'],
        {
          cwd: dir,
        }
      )
      await execFileAsync('git', ['remote', 'add', 'origin', remoteDir], { cwd: dir })
      await execFileAsync('git', ['push', '-q', 'origin', 'main'], { cwd: dir })

      await commitPkg('1.3.0')
      await execFileAsync('git', ['push', '-q', 'origin', 'main'], { cwd: dir })
      await execFileAsync('git', ['reset', '--hard', 'HEAD~1'], { cwd: dir })

      await expect(assertRemoteDefaultBranchIncluded(dir)).rejects.toThrow(
        /does not include the latest origin\/main/
      )
    })
  })
})

/**
 * PATH-hijack: an empty dir as PATH means `git` resolves nowhere, so spawn
 * fails with a real ENOENT — exercises the infra-failure path without mocks.
 */
async function withBrokenGit<T>(fn: () => Promise<T>): Promise<T> {
  const noGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-no-git-'))
  const oldPath = process.env.PATH
  process.env.PATH = noGitDir
  try {
    return await fn()
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    await fs.rm(noGitDir, { recursive: true, force: true }).catch(() => {})
  }
}

describe('VersionService — typed git failures (WS1)', () => {
  it('bump rejects on git infra failure instead of treating the tree as fresh', async () => {
    if (process.platform === 'win32') return
    await withVersionRepository('prjct-version-nogit-', async ({ dir, commitPkg }) => {
      await commitPkg('1.2.3')

      await withBrokenGit(async () => {
        await expect(new VersionService(dir).bump()).rejects.toThrow(/git (timeout|spawn) failure/)
      })

      // The transient failure must NOT have touched the version.
      const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf-8')) as {
        version: string
      }
      expect(pkg.version).toBe('1.2.3')
    })
  })
})
