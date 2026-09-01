/**
 * Daemon entry resolution.
 *
 * The regression this pins: the resolver assumed the running module sits in
 * `dist/bin/`, but the bundler emits it into `dist/bin/core-chunks/`. Every
 * candidate missed, so a published install could never spawn its daemon — and
 * the failure was silent, because callers only see `false`.
 */

import { describe, expect, test } from 'bun:test'
import { resolveDaemonLaunch } from '../../daemon/client'

/** An `exists` predicate backed by a fixed set of paths. */
function tree(...paths: string[]) {
  const set = new Set(paths)
  return (candidate: string) => set.has(candidate)
}

const PKG = '/opt/global/node_modules/prjct-cli'

describe('resolveDaemonLaunch — packaged installs', () => {
  test('finds the daemon from a bundled chunk dir (the regression)', () => {
    const launch = resolveDaemonLaunch(`${PKG}/dist/bin/core-chunks`, {
      exists: tree(`${PKG}/dist/daemon/entry.mjs`),
      preferBun: true,
    })
    expect(launch).toEqual({ entryPath: `${PKG}/dist/daemon/entry.mjs`, runtime: 'bun' })
  })

  test('finds it from the hook chunk dir too', () => {
    const launch = resolveDaemonLaunch(`${PKG}/dist/bin/hook-chunks`, {
      exists: tree(`${PKG}/dist/daemon/entry.mjs`),
      preferBun: false,
    })
    expect(launch?.entryPath).toBe(`${PKG}/dist/daemon/entry.mjs`)
    expect(launch?.runtime).toBe('node')
  })

  test('still works from dist/bin itself', () => {
    const launch = resolveDaemonLaunch(`${PKG}/dist/bin`, {
      exists: tree(`${PKG}/dist/daemon/entry.mjs`),
      preferBun: true,
    })
    expect(launch?.entryPath).toBe(`${PKG}/dist/daemon/entry.mjs`)
  })

  test('an adjacent daemon/ dir wins over ascending further', () => {
    const launch = resolveDaemonLaunch(`${PKG}/dist/bin`, {
      exists: tree(`${PKG}/dist/bin/daemon/entry.mjs`, `${PKG}/dist/daemon/entry.mjs`),
      preferBun: true,
    })
    expect(launch?.entryPath).toBe(`${PKG}/dist/bin/daemon/entry.mjs`)
  })
})

describe('resolveDaemonLaunch — source checkout', () => {
  test('a sibling entry.ts always runs on bun, even when node is preferred', () => {
    const launch = resolveDaemonLaunch('/repo/core/daemon', {
      exists: tree('/repo/core/daemon/entry.ts', '/repo/dist/daemon/entry.mjs'),
      preferBun: false,
    })
    expect(launch).toEqual({ entryPath: '/repo/core/daemon/entry.ts', runtime: 'bun' })
  })
})

describe('resolveDaemonLaunch — nothing to launch', () => {
  test('returns null rather than a path that does not exist', () => {
    expect(
      resolveDaemonLaunch('/nowhere/deep/inside', { exists: tree(), preferBun: true })
    ).toBeNull()
  })

  test('stops ascending instead of walking to the filesystem root forever', () => {
    const seen: string[] = []
    const launch = resolveDaemonLaunch('/a/b/c/d/e/f/g/h/i/j/k', {
      exists: (candidate) => {
        seen.push(candidate)
        return false
      },
      preferBun: true,
    })
    expect(launch).toBeNull()
    // 1 source probe + 2 probes per level, bounded by the ascent cap.
    expect(seen.length).toBeLessThanOrEqual(1 + 2 * 9)
  })
})
