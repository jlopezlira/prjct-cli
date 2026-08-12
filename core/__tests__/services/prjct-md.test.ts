/**
 * PRJCT.md — the canonical per-project hub.
 *
 * Pins the contract:
 *   1. Body always carries the routing map, even with no package.json.
 *   2. Verified (real) commands appear, tagged read-only/mutating.
 *   3. writeProjectPrjctMd follows the same create/append/replace/idempotent
 *      contract as writeRoutingBlock (host-claude-md.ts's contract).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildPrjctMdBody,
  formatProjectFactsMd,
  writeProjectPrjctMd,
} from '../../services/prjct-md'
import { ROUTING_END_MARKER, ROUTING_START_MARKER } from '../../services/routing-block'

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

async function readPrjctMd(): Promise<string> {
  return fs.readFile(path.join(fixture.dir, 'PRJCT.md'), 'utf-8')
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

describe('writeProjectPrjctMd', () => {
  it('creates PRJCT.md when none exists', async () => {
    const r = await writeProjectPrjctMd(fixture.dir)
    expect(r.action).toBe('created')
    const body = await readPrjctMd()
    expect(body).toContain(ROUTING_START_MARKER)
    expect(body).toContain(ROUTING_END_MARKER)
    expect(body).toContain('## prjct')
  })

  it('preserves user content outside markers and replaces stale block content', async () => {
    const initial = `# Notes\n\nHand-written notes.\n\n${ROUTING_START_MARKER}\nold stale content\n${ROUTING_END_MARKER}\n`
    await fs.writeFile(path.join(fixture.dir, 'PRJCT.md'), initial)
    const r = await writeProjectPrjctMd(fixture.dir)
    expect(r.action).toBe('updated')
    const body = await readPrjctMd()
    expect(body).toContain('Hand-written notes.')
    expect(body).not.toContain('old stale content')
    expect(body).toContain('## prjct')
  })

  it('is idempotent — second run on a current file reports unchanged', async () => {
    await writeProjectPrjctMd(fixture.dir)
    const second = await writeProjectPrjctMd(fixture.dir)
    expect(second.action).toBe('unchanged')
  })
})
