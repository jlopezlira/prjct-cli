/**
 * Global install detection across package-manager layouts.
 *
 * The regression this pins: `pnpm root -g` used to return the global
 * node_modules, but pnpm v11 returns the global DIR, whose installs live in
 * hashed per-project subdirectories. Probing only `<root>/prjct-cli` made a
 * healthy install invisible, so `prjct update` reported "No global prjct-cli
 * install found" immediately after installing it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readInstalledVersion } from '../../commands/update/package-managers'

const fixture: { root: string } = { root: '' }

beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-install-detect-'))
})

afterEach(async () => {
  if (fixture.root) await fs.rm(fixture.root, { recursive: true, force: true })
})

async function writeManifest(dir: string, version: string, name = 'prjct-cli'): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version }))
}

describe('readInstalledVersion', () => {
  test('root IS node_modules — the classic npm/bun layout', async () => {
    await writeManifest(path.join(fixture.root, 'prjct-cli'), '4.16.0')
    expect(readInstalledVersion(fixture.root)).toBe('4.16.0')
  })

  test('root is a project dir holding node_modules', async () => {
    await writeManifest(path.join(fixture.root, 'node_modules', 'prjct-cli'), '4.16.0')
    expect(readInstalledVersion(fixture.root)).toBe('4.16.0')
  })

  test('pnpm v11 — install lives in a hashed per-project subdirectory', async () => {
    await writeManifest(
      path.join(fixture.root, '93918-1a05e33d9af-8369c54aa46e56c0', 'node_modules', 'prjct-cli'),
      '4.16.0'
    )
    expect(readInstalledVersion(fixture.root)).toBe('4.16.0')
  })

  test('with several global projects, the newest one wins', async () => {
    const older = path.join(fixture.root, 'old-project', 'node_modules', 'prjct-cli')
    const newer = path.join(fixture.root, 'new-project', 'node_modules', 'prjct-cli')
    await writeManifest(older, '4.15.0')
    await writeManifest(newer, '4.16.0')
    // pnpm writes a fresh project dir per global install; mtime is the ordering.
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(path.join(fixture.root, 'old-project'), past, past)
    expect(readInstalledVersion(fixture.root)).toBe('4.16.0')
  })

  test('a foreign package under the same layout is not mistaken for ours', async () => {
    await writeManifest(path.join(fixture.root, 'prjct-cli'), '9.9.9', 'something-else')
    expect(readInstalledVersion(fixture.root)).toBeNull()
  })

  test('nothing installed → null, not a throw', () => {
    expect(readInstalledVersion(fixture.root)).toBeNull()
    expect(readInstalledVersion(path.join(fixture.root, 'does-not-exist'))).toBeNull()
  })
})
