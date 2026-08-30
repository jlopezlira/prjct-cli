/**
 * Project facts formatter used by global context previews and MCP tools.
 *
 * Pins the contract:
 *   1. Body always carries the routing map, even with no package.json.
 *   2. Verified (real) commands appear, tagged read-only/mutating.
 *   3. Nothing is ever written to the client repository.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildPrjctMdBody, formatProjectFactsMd } from '../../services/prjct-md'

const fixture: { dir: string } = { dir: '' }

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-md-test-'))
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

async function writePkg(scripts: Record<string, string>): Promise<void> {
  await fs.writeFile(
    path.join(fixture.dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts }, null, 2)
  )
}

describe('buildPrjctMdBody', () => {
  it('always carries the routing map, even with no package.json', async () => {
    const body = await buildPrjctMdBody(fixture.dir)
    expect(body).toContain('## prjct')
    expect(body).toContain('prjct work --md')
    expect(body).not.toContain('## This project')
  })

  it('adds a "This project" section with verified commands, tagged read-only/mutating', async () => {
    await writePkg({ test: 'bun test', lint: 'biome check --write' })
    const body = await buildPrjctMdBody(fixture.dir)
    expect(body).toContain('## This project')
    expect(body).toContain('- test: `bun test` (read-only)')
    expect(body).toContain('- lint: `biome check --write` (mutating)')
    expect(body).toContain('deeper: `prjct context --md`')
  })

  it('never guesses a command that is not actually in package.json scripts', async () => {
    await writePkg({ 'some-custom-script': 'do whatever' })
    const body = await buildPrjctMdBody(fixture.dir)
    expect(body).not.toContain('do whatever')
  })

  it('is a MAP of the harness organs (pull commands), carrying no ruleset', async () => {
    const body = await buildPrjctMdBody(fixture.dir)
    expect(body).toContain('This file holds no rules')
    expect(body).toContain('prjct work --md') // entrypoint
    expect(body).toContain('ship') // ship after user confirm
    expect(body).toMatch(/pull-on-demand|pull:/i)
    expect(body).toContain('guard') // guardrails
    expect(body).toContain('remember') // persistence
    expect(body).not.toContain('intent brief')
    expect(body).not.toContain('RAG-backed project memory harness')
  })
})

describe('formatProjectFactsMd', () => {
  it('never writes anything to disk — pure live preview', async () => {
    await writePkg({ test: 'bun test' })
    await formatProjectFactsMd(fixture.dir)
    const entries = await fs.readdir(fixture.dir)
    expect(entries).toEqual(['package.json'])
  })

  it('reports no verified facts yet when nothing is detected', async () => {
    const md = await formatProjectFactsMd(fixture.dir)
    expect(md).toContain('# Project facts')
    expect(md).toContain('No verified facts yet')
  })

  it('renders the same facts section buildPrjctMdBody embeds', async () => {
    await writePkg({ test: 'bun test', lint: 'biome check --write' })
    const md = await formatProjectFactsMd(fixture.dir)
    expect(md).toContain('# Project facts')
    expect(md).toContain('- test: `bun test` (read-only)')
    expect(md).toContain('- lint: `biome check --write` (mutating)')
  })
})
