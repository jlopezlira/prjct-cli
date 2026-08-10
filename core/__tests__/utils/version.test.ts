/**
 * version — env-var first, package.json fallback.
 *
 * Critical regression coverage: standalone binaries built via
 * `bun build --compile` cannot read package.json at runtime
 * (the baked-in __dirname points at the CI runner's filesystem).
 * The PRJCT_VERSION env-var path is the only thing that makes those
 * binaries report the right version. Without this test, the
 * regression is silent until a user installs the binary and gets
 * v0.0.0 with a noisy ENOENT log.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const fixture: {
  originalEnv: string | undefined
} = {
  originalEnv: undefined as unknown as string | undefined,
}

beforeEach(() => {
  fixture.originalEnv = process.env.PRJCT_VERSION
})

afterEach(() => {
  if (fixture.originalEnv === undefined) {
    delete process.env.PRJCT_VERSION
  } else {
    process.env.PRJCT_VERSION = fixture.originalEnv
  }
})

async function freshImport(): Promise<typeof import('../../utils/version')> {
  return import(`../../utils/version?t=${Date.now()}`)
}

describe('version — env-var bake', () => {
  test('PRJCT_VERSION env var wins over package.json read', async () => {
    process.env.PRJCT_VERSION = '99.99.99'
    const m = await freshImport()
    expect(m.getVersion()).toBe('99.99.99')
  })

  test('rejects malformed env-var values (falls through to filesystem)', async () => {
    process.env.PRJCT_VERSION = 'not-a-version'
    const m = await freshImport()
    // Falls through to package.json — should yield a real semver
    const v = m.getVersion()
    expect(v).toMatch(/^\d+\.\d+\.\d+/)
    expect(v).not.toBe('not-a-version')
  })

  test('reads package.json when env-var is absent', async () => {
    delete process.env.PRJCT_VERSION
    const m = await freshImport()
    const v = m.getVersion()
    expect(v).toMatch(/^\d+\.\d+\.\d+/)
  })

  test('VERSION constant matches getVersion()', async () => {
    delete process.env.PRJCT_VERSION
    const m = await freshImport()
    expect(m.VERSION).toBe(m.getVersion())
  })
})
