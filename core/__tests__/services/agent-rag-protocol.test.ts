import { describe, expect, it } from 'bun:test'
import { MINIMAL_ROUTING_BODY } from '../../services/routing-block'
import {
  buildAntigravityConfig,
  buildAntigravitySkill,
  buildCodexSkill,
  buildGeminiConfig,
} from '../../services/skill-generator/editor-surfaces'

// GLOBAL agent-config surfaces — the pull layer where the protocol LIVES.
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
  it('keeps the canonical routing map compact and pull-first', () => {
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
})
