/**
 * Project AGENTS.md — self-contained routing writer, written by `prjct init`
 * (and every `prjct sync` once adopted). AGENTS.md carries the routing map
 * INLINE (not just a pointer) — verified against Claude Code docs (2026-08):
 * no cross-tool `@import`-equivalent standard exists for AGENTS.md consumers
 * (Codex, Gemini, Cursor, etc.), so a bare "see PRJCT.md" pointer would
 * depend on the model actively choosing to open another file to learn
 * basic verbs — unreliable, and the literal bug this used to cause ("I say
 * ship and the agent doesn't know what it means"). Verified per-project
 * facts (stack/commands) stay a pointer to PRJCT.md — lower-stakes pull.
 * Mirrors the CLAUDE.md contract:
 *   1. Missing AGENTS.md → created with the block.
 *   2. Existing AGENTS.md without markers → block appended, user content
 *      preserved (this repo's own handwritten AGENTS.md is the canary).
 *   3. Stale markers → refreshed in place.
 *   4. Re-run on current file → action='unchanged' (idempotent).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _routing, writeProjectAgentsMd } from '../../services/host-agents-md'

const fixture: {
  dir: string
} = {
  dir: '',
}

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-agents-md-test-'))
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

async function readAgentsMd(): Promise<string> {
  return fs.readFile(path.join(fixture.dir, 'AGENTS.md'), 'utf-8')
}

describe('writeProjectAgentsMd', () => {
  it('creates AGENTS.md when none exists, self-contained with the routing map', async () => {
    const r = await writeProjectAgentsMd(fixture.dir)
    expect(r.action).toBe('created')
    const body = await readAgentsMd()
    expect(body).toContain(_routing.START_MARKER)
    expect(body).toContain(_routing.END_MARKER)
    expect(body).toContain('## prjct')
    expect(body).toContain('prjct work --md')
    expect(body).toContain('This file holds no rules')
    // Verified facts (stack/commands) stay a pointer — lower-stakes pull.
    expect(body).toContain('PRJCT.md')
    // Clean-repo doctrine: a routing map, never an inlined ruleset.
    expect(body).not.toContain('RAG-backed project memory harness')
  })

  it('appends the block to an existing AGENTS.md without markers', async () => {
    await fs.writeFile(
      path.join(fixture.dir, 'AGENTS.md'),
      '# Contributor guide\n\nHandwritten conventions.\n'
    )
    const r = await writeProjectAgentsMd(fixture.dir)
    expect(r.action).toBe('updated')
    const body = await readAgentsMd()
    expect(body).toContain('# Contributor guide')
    expect(body).toContain('Handwritten conventions.')
    expect(body).toContain(_routing.START_MARKER)
    expect(body.indexOf('Handwritten conventions.')).toBeLessThan(
      body.indexOf(_routing.START_MARKER)
    )
  })

  it('refreshes a stale block between markers, preserving outside content', async () => {
    const stale = `# Mine\n\n${_routing.START_MARKER}\nOLD CONTENT\n${_routing.END_MARKER}\n\nTrailing notes.\n`
    await fs.writeFile(path.join(fixture.dir, 'AGENTS.md'), stale)
    const r = await writeProjectAgentsMd(fixture.dir)
    expect(r.action).toBe('updated')
    const body = await readAgentsMd()
    expect(body).not.toContain('OLD CONTENT')
    expect(body).toContain('# Mine')
    expect(body).toContain('Trailing notes.')
    expect(body).toContain('## prjct')
  })

  it('is idempotent — re-run reports unchanged', async () => {
    await writeProjectAgentsMd(fixture.dir)
    const first = await readAgentsMd()
    const r = await writeProjectAgentsMd(fixture.dir)
    expect(r.action).toBe('unchanged')
    expect(await readAgentsMd()).toBe(first)
  })

  it('block is vendor-neutral — no Claude-only paths', async () => {
    await writeProjectAgentsMd(fixture.dir)
    const body = await readAgentsMd()
    expect(body).not.toContain('.claude/')
    expect(body).not.toContain('Claude Code')
  })

  it('is a MAP of the harness organs (pull commands), carrying no ruleset', async () => {
    await writeProjectAgentsMd(fixture.dir)
    const body = await readAgentsMd()
    expect(body).toContain('This file holds no rules')
    // Names each organ + the one command to pull it — the map, not the rules.
    expect(body).toContain('prjct work --md') // entrypoint
    expect(body).toContain('ship') // ship after user confirm
    expect(body).toMatch(/pull-on-demand|pull:/i)
    expect(body).toContain('guard') // guardrails
    expect(body).toContain('remember') // persistence
    // But the rules/protocol themselves are NOT inlined here — they live in prjct.
    expect(body).not.toContain('intent brief')
    expect(body).not.toContain('RAG-backed project memory harness')
  })

  it('stays well under the L0 routing byte budget even with the facts pointer appended', async () => {
    await writeProjectAgentsMd(fixture.dir)
    const body = await readAgentsMd()
    expect(Buffer.byteLength(body, 'utf-8')).toBeLessThanOrEqual(500)
  })
})
