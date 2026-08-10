/**
 * Context7 is provider-aware: it configures into the ACTIVE harness's MCP
 * config (Claude → mcp.json, Codex → config.toml) and treats unmanaged
 * providers as a non-error skip. This is what unblocks `prjct sync` for
 * non-Claude harnesses — the smoke check is stubbed out here via
 * PRJCT_SKIP_CONTEXT7_SMOKE so we exercise config wiring, not the network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import context7Service from '../../services/context7-service'
import { codexHasContext7Server, getCodexConfigTomlPath } from '../../utils/codex-mcp'

const fixture: {
  home: string
} = {
  home: '',
}
const saved: Record<string, string | undefined> = {}

beforeEach(async () => {
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-c7-provider-'))
  for (const k of ['HOME', 'PRJCT_TEST_MODE', 'NODE_ENV', 'PRJCT_SKIP_CONTEXT7_SMOKE']) {
    saved[k] = process.env[k]
  }
  process.env.HOME = fixture.home
  process.env.PRJCT_TEST_MODE = '1' // route Codex config.toml under the temp home
  process.env.NODE_ENV = 'test' // route the verify cache to a temp path
  process.env.PRJCT_SKIP_CONTEXT7_SMOKE = '1' // skip the npx network smoke check
})

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await fs.rm(fixture.home, { recursive: true, force: true }).catch(() => {})
})

describe('context7Service provider-awareness', () => {
  it('install("codex") registers context7 in config.toml', async () => {
    const status = await context7Service.install('codex')
    expect(status.installed).toBe(true)
    expect(status.configPath).toBe(getCodexConfigTomlPath())
    expect(await codexHasContext7Server()).toBe(true)
  })

  it('ensureReady("codex") succeeds once configured (smoke skipped)', async () => {
    const status = await context7Service.ensureReady('codex')
    expect(status.verified).toBe(true)
    expect(await codexHasContext7Server()).toBe(true)
  })

  it('install() for an unmanaged provider is a non-error skip', async () => {
    const status = await context7Service.install('gemini')
    expect(status.installed).toBe(false)
    expect(status.message).toMatch(/not supported|skipping/i)
  })

  it('ensureReady() rejects for an unmanaged provider', async () => {
    await expect(context7Service.ensureReady('gemini')).rejects.toThrow()
  })
})
