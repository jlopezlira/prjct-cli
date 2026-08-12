import { describe, expect, it } from 'bun:test'
import { _routing as agentsRouting } from '../../services/host-agents-md'
import { _routing as claudeRouting } from '../../services/host-claude-md'
import { MINIMAL_ROUTING_BODY } from '../../services/routing-block'
import {
  buildAntigravityConfig,
  buildAntigravitySkill,
  buildCodexSkill,
  buildGeminiConfig,
} from '../../services/skill-generator/editor-surfaces'

// GLOBAL agent-config surfaces — the pull layer where the protocol LIVES.
// Per-repo IDE pointers (CURSOR.mdc) are deliberately excluded:
// under the clean-repo doctrine they are minimal pointers, not protocol
// carriers (see the minimal-pointer test below).
const STATIC_AGENT_SURFACES = [
  buildCodexSkill,
  buildAntigravitySkill,
  buildGeminiConfig,
  buildAntigravityConfig,
] as const

const SIZE_CAPPED_SKILLS = [buildCodexSkill, buildAntigravitySkill] as const

const MAX_SKILL_BYTES = 1024

const REQUIRED_PROTOCOL = [
  'RAG-backed project memory harness',
  'do not preload project history',
  'Pull',
  'not something to load wholesale',
] as const

const FORBIDDEN_ALWAYS_ON_PHRASES = [
  'prjct runs → LLM generates relevant data',
  'Context synthesis first, then Key data for UI',
  'load full project history',
  'preload full project history',
] as const

function expectProtocol(body: string): void {
  const normalized = body.toLowerCase()
  for (const required of REQUIRED_PROTOCOL) {
    expect(normalized).toContain(required.toLowerCase())
  }
}

describe('compact RAG-first agent protocol', () => {
  it('AGENTS.md carries the routing map inline (self-contained — no reliable cross-tool import exists)', () => {
    // Verified against Claude Code docs (2026-08): Claude Code does NOT
    // auto-load AGENTS.md at all, and no other AGENTS.md-consuming tool
    // (Codex, Gemini, Cursor, ...) has an equivalent guaranteed-resolving
    // `@import`. A bare "see PRJCT.md" pointer would depend on the model
    // actively choosing to open another file just to learn basic verbs —
    // AGENTS.md must stand on its own, per its own file's docstring.
    const body = agentsRouting.FULL_BLOCK
    expect(body).toContain('prjct work --md')
    expect(body).toMatch(/pull.on.demand|pull:/i)
    expect(body).toContain('ship')
    expect(body).toContain('This file holds no rules')
    // Verified per-project facts (stack/commands) stay a pointer — lower stakes.
    expect(body).toContain('PRJCT.md')
    for (const forbidden of FORBIDDEN_ALWAYS_ON_PHRASES) expect(body).not.toContain(forbidden)
    expect(body).not.toContain('RAG-backed project memory harness')
  })

  it('CLAUDE.md stays a bare `@PRJCT.md` import — Claude Code auto-resolves it, verified reliable', () => {
    // Verified against Claude Code docs (2026-08): CLAUDE.md IS auto-loaded
    // at session start, and `@path` imports inside it auto-resolve as part
    // of that same load (max 4 hops) — zero extra agent action required.
    // Unlike AGENTS.md, duplicating the routing map here would be pure
    // waste: the import is a guaranteed, not a hopeful, connection to
    // PRJCT.md's content (which itself embeds MINIMAL_ROUTING_BODY).
    const body = claudeRouting.FULL_BLOCK
    expect(body).toContain('@PRJCT.md')
    expect(body).not.toContain('prjct work --md')
    expect(body).not.toContain('This file holds no rules')
    for (const forbidden of FORBIDDEN_ALWAYS_ON_PHRASES) expect(body).not.toContain(forbidden)
    expect(body).not.toContain('RAG-backed project memory harness')

    // The routing map that PRJCT.md embeds (and CLAUDE.md transitively
    // imports) still carries the entrypoint map.
    expect(MINIMAL_ROUTING_BODY).toContain('prjct work --md')
    expect(MINIMAL_ROUTING_BODY).toMatch(/pull.on.demand|pull:/i)
    expect(MINIMAL_ROUTING_BODY).toContain('ship')
    expect(MINIMAL_ROUTING_BODY).toContain('This file holds no rules')
    expect(MINIMAL_ROUTING_BODY).not.toContain('RAG-backed project memory harness')
  })

  it('keeps generated agent adapters aligned with the lookup-first protocol', () => {
    for (const buildSurface of STATIC_AGENT_SURFACES) {
      const body = buildSurface()
      expectProtocol(body)
      for (const forbidden of FORBIDDEN_ALWAYS_ON_PHRASES) expect(body).not.toContain(forbidden)
    }
  })

  it('keeps always-loaded skills below the Codex skill size ceiling', () => {
    for (const buildSkill of SIZE_CAPPED_SKILLS) {
      expect(Buffer.byteLength(buildSkill(), 'utf-8')).toBeLessThanOrEqual(MAX_SKILL_BYTES)
    }
  })

  it('keeps AGENTS.md under the L0 routing budget and CLAUDE.md under a bare pointer-sized budget', () => {
    // AGENTS.md is self-contained (routing map + facts pointer) — same L0
    // routing budget as PRJCT.md's own routing section. CLAUDE.md is a bare
    // `@PRJCT.md` import, so it stays tiny — PRJCT.md's own budget is
    // covered by PRJCT_MD_BODY_BYTES_MAX in context-tiers.test.ts, not here.
    expect(Buffer.byteLength(agentsRouting.FULL_BLOCK, 'utf-8')).toBeLessThanOrEqual(500)
    expect(Buffer.byteLength(claudeRouting.FULL_BLOCK, 'utf-8')).toBeLessThanOrEqual(150)
  })
})
