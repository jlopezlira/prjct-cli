import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeProjectAgentSurfaces } from '../../services/project-agent-surfaces'

const fixture: {
  dir: string
} = {
  dir: '',
}

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-agent-surfaces-test-'))
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

describe('writeProjectAgentSurfaces', () => {
  // Clean-repo sovereignty doctrine: automatic flows (sync/install/setup/work)
  // call this WITHOUT `explicit` and must write nothing into the repo. The sole
  // repo footprint is .prjct/. Only `prjct agents` opts in via `explicit: true`.
  it('writes nothing into the repo unless explicitly asked', async () => {
    const result = await writeProjectAgentSurfaces(fixture.dir)

    expect(result.prjctMd.action).toBe('unchanged')
    expect(result.agentsMd.action).toBe('unchanged')
    expect(result.claudeMd).toBeUndefined()
    expect(result.ideRules).toEqual([])
    const entries = await fs.readdir(fixture.dir)
    expect(entries).toEqual([])
  })

  it('is still a no-op even when agents are selected but not explicit', async () => {
    const result = await writeProjectAgentSurfaces(fixture.dir, { agents: ['cursor', 'opencode'] })

    expect(result.ideRules).toEqual([])
    expect(await fs.readdir(fixture.dir)).toEqual([])
  })

  it('writes PRJCT.md as the canonical hub + AGENTS.md self-contained on explicit opt-in', async () => {
    const result = await writeProjectAgentSurfaces(fixture.dir, { explicit: true })

    expect(result.prjctMd.action).toBe('created')
    expect(result.agentsMd.action).toBe('created')
    const prjct = await fs.readFile(path.join(fixture.dir, 'PRJCT.md'), 'utf-8')
    expect(prjct).toContain('prjct work --md')
    expect(prjct).toContain('This file holds no rules')
    // No inlined ruleset / RAG protocol in a client-repo surface.
    expect(prjct).not.toContain('RAG-backed project memory harness')
    expect(prjct).not.toContain('intent brief')

    // AGENTS.md is self-contained (no reliable cross-tool import exists —
    // verified against Claude Code docs) — the routing map lives here too,
    // not just a pointer, plus a pointer to PRJCT.md for verified facts.
    const agents = await fs.readFile(path.join(fixture.dir, 'AGENTS.md'), 'utf-8')
    expect(agents).toContain('prjct work --md')
    expect(agents).toContain('PRJCT.md')
  })

  it('does not write CLAUDE.md when Claude was neither detected/selected nor already present', async () => {
    // CLAUDE.md is Claude-specific — writing it into every project
    // regardless of which runtime is actually used (e.g. a Kimi-only team
    // that only ever reads AGENTS.md) would be exactly the kind of forced,
    // irrelevant footprint the clean-repo doctrine exists to prevent.
    const result = await writeProjectAgentSurfaces(fixture.dir, {
      explicit: true,
      agents: ['codex', 'gemini'],
    })
    expect(result.claudeMd).toBeUndefined()
    expect(await fs.readdir(fixture.dir)).not.toContain('CLAUDE.md')
  })

  it('writes CLAUDE.md as a native `@PRJCT.md` import when Claude is detected/selected', async () => {
    // Verified against Claude Code docs (2026-08): CLAUDE.md is the ONE
    // surface Claude Code auto-loads + auto-resolves `@import` on at
    // session start — the guaranteed-reliable channel when Claude actually
    // is the runtime in play.
    const result = await writeProjectAgentSurfaces(fixture.dir, {
      explicit: true,
      agents: ['claude'],
    })
    expect(result.claudeMd?.action).toBe('created')
    const claude = await fs.readFile(path.join(fixture.dir, 'CLAUDE.md'), 'utf-8')
    expect(claude).toContain('@PRJCT.md')
    expect(claude).not.toContain('## prjct')
    expect(claude).not.toContain('prjct work --md')
    expect(claude).not.toContain('RAG-backed project memory harness')
  })

  it('keeps refreshing an already-present CLAUDE.md even without Claude re-selected', async () => {
    // Once CLAUDE.md exists (however it got there), it stays maintained —
    // existence itself is evidence Claude is relevant to this repo.
    await writeProjectAgentSurfaces(fixture.dir, { explicit: true, agents: ['claude'] })
    const result = await writeProjectAgentSurfaces(fixture.dir, {
      explicit: true,
      agents: ['codex'],
    })
    expect(result.claudeMd?.action).toBe('unchanged')
  })

  it('writes known project rule adapters as minimal pointers when selected (explicit)', async () => {
    const result = await writeProjectAgentSurfaces(fixture.dir, {
      explicit: true,
      agents: ['cursor'],
    })

    expect(result.ideRules).toEqual(['.cursor/rules/prjct.mdc'])
    const cursor = await fs.readFile(
      path.join(fixture.dir, '.cursor', 'rules', 'prjct.mdc'),
      'utf-8'
    )
    expect(cursor).toContain('prjct work --md')
    expect(cursor).toContain('This file holds no rules')
    expect(cursor).not.toContain('RAG-backed project memory harness')
    expect(cursor).not.toContain('Pull only relevant context')
  })

  it('does not invent project files for runtimes covered by AGENTS.md only (explicit) — no CLAUDE.md without Claude', async () => {
    const result = await writeProjectAgentSurfaces(fixture.dir, {
      explicit: true,
      agents: ['opencode', 'qwen-code', 'cline'],
    })

    expect(result.ideRules).toEqual([])
    expect(result.claudeMd).toBeUndefined()
    const entries = await fs.readdir(fixture.dir)
    expect(entries.sort()).toEqual(['AGENTS.md', 'PRJCT.md'])
  })

  describe('refreshIfAdopted (prjct sync)', () => {
    // Every `prjct sync` now keeps an already-adopted surface current, but
    // must never create the FIRST copy in a repo that never opted in —
    // that's still the exclusive job of an explicit `prjct agents doctor --fix`.
    it('stays a no-op in a virgin repo — sync alone never creates the first pointer', async () => {
      const result = await writeProjectAgentSurfaces(fixture.dir, { refreshIfAdopted: true })

      expect(result.prjctMd.action).toBe('unchanged')
      expect(result.agentsMd.action).toBe('unchanged')
      expect(result.claudeMd).toBeUndefined()
      expect(await fs.readdir(fixture.dir)).toEqual([])
    })

    it('refreshes PRJCT.md once the repo has already adopted it', async () => {
      await writeProjectAgentSurfaces(fixture.dir, { explicit: true })

      // Simulate drift: hand-edit PRJCT.md's routing block to something stale.
      const prjctPath = path.join(fixture.dir, 'PRJCT.md')
      const stale = (await fs.readFile(prjctPath, 'utf-8')).replace(
        'This file holds no rules.',
        'STALE OLD CONTENT'
      )
      await fs.writeFile(prjctPath, stale)

      const result = await writeProjectAgentSurfaces(fixture.dir, { refreshIfAdopted: true })
      expect(result.prjctMd.action).toBe('updated')
      const refreshed = await fs.readFile(prjctPath, 'utf-8')
      expect(refreshed).toContain('This file holds no rules.')
      expect(refreshed).not.toContain('STALE OLD CONTENT')
    })

    it('migrates a stale/drifted legacy AGENTS.md block to the current shape and adds the PRJCT.md pointer', async () => {
      // A hand-edited or older-shape block sitting between the markers.
      const legacy = `<!-- prjct:routing - do not edit between markers -->
## prjct
STALE OLD CONTENT FROM A PRIOR VERSION
<!-- /prjct:routing - managed by prjct -->
`
      await fs.writeFile(path.join(fixture.dir, 'AGENTS.md'), legacy)

      const result = await writeProjectAgentSurfaces(fixture.dir, { refreshIfAdopted: true })
      expect(result.agentsMd.action).toBe('updated')
      const agents = await fs.readFile(path.join(fixture.dir, 'AGENTS.md'), 'utf-8')
      expect(agents).not.toContain('STALE OLD CONTENT')
      expect(agents).toContain('prjct work --md')
      expect(agents).toContain('PRJCT.md')
      // PRJCT.md gets created as part of the same adopted-repo refresh.
      expect(result.prjctMd.action).toBe('created')
      // No CLAUDE.md — Claude was never detected/selected for this repo,
      // and none existed before, so it stays a Kimi/Codex-style AGENTS.md-only setup.
      expect(result.claudeMd).toBeUndefined()
    })

    it('does NOT create CLAUDE.md just because some other surface was adopted — must actually detect Claude', async () => {
      // A repo that only ever adopted AGENTS.md (e.g. a Kimi/Codex-only
      // team) must not get a CLAUDE.md conjured out of nowhere — that's
      // exactly the forced, irrelevant footprint the doctrine forbids.
      await fs.writeFile(path.join(fixture.dir, 'AGENTS.md'), '# my instructions\n')

      const result = await writeProjectAgentSurfaces(fixture.dir, { refreshIfAdopted: true })
      expect(result.claudeMd).toBeUndefined()
      expect(await fs.readdir(fixture.dir)).not.toContain('CLAUDE.md')
    })

    it('DOES create CLAUDE.md on refresh once Claude is detected, even if adoption predates the detection', async () => {
      // The reliability fix: re-detection happens on every sync, not just
      // at whatever moment the surface was first adopted — so a repo that
      // starts Codex-only and later picks up Claude Code gets CLAUDE.md
      // the next time it syncs, without needing a fresh `agents doctor --fix`.
      await fs.writeFile(path.join(fixture.dir, 'AGENTS.md'), '# my instructions\n')

      const result = await writeProjectAgentSurfaces(fixture.dir, {
        refreshIfAdopted: true,
        agents: ['claude'],
      })
      expect(result.claudeMd?.action).toBe('created')
      const claude = await fs.readFile(path.join(fixture.dir, 'CLAUDE.md'), 'utf-8')
      expect(claude).toContain('@PRJCT.md')
    })

    it('is idempotent — a second sync on a fresh surface reports unchanged', async () => {
      await writeProjectAgentSurfaces(fixture.dir, { explicit: true, agents: ['claude'] })
      const result = await writeProjectAgentSurfaces(fixture.dir, { refreshIfAdopted: true })
      expect(result.prjctMd.action).toBe('unchanged')
      expect(result.agentsMd.action).toBe('unchanged')
      expect(result.claudeMd?.action).toBe('unchanged')
    })
  })
})
