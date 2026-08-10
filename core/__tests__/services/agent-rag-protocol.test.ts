import { describe, expect, it } from 'bun:test'
import { _routing as agentsRouting } from '../../services/host-agents-md'
import { _routing as claudeRouting } from '../../services/host-claude-md'
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
  it('keeps generated AGENTS.md and CLAUDE.md surfaces minimal pointers — no inline rules', () => {
    // Clean-repo doctrine: the only thing prjct ever writes into a client repo
    // (and only on explicit `prjct agents`) is a pointer to pull from prjct.
    // It must name the entrypoint and carry NO ruleset / RAG protocol.
    for (const body of [agentsRouting.FULL_BLOCK, claudeRouting.FULL_BLOCK]) {
      expect(body).toContain('prjct work --md')
      // Surface compression: work+ship default; rest is pull-on-demand
      expect(body).toMatch(/pull.on.demand/i)
      expect(body).toContain('ship')
      expect(body).toContain('This file holds no rules')
      for (const forbidden of FORBIDDEN_ALWAYS_ON_PHRASES) expect(body).not.toContain(forbidden)
      // The full protocol belongs in the global pull layer, never inlined here.
      expect(body).not.toContain('RAG-backed project memory harness')
    }
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

  it('keeps the always-loaded routing blocks under their byte budget', () => {
    expect(Buffer.byteLength(agentsRouting.FULL_BLOCK, 'utf-8')).toBeLessThanOrEqual(560)
    expect(Buffer.byteLength(claudeRouting.FULL_BLOCK, 'utf-8')).toBeLessThanOrEqual(560)
  })
})
