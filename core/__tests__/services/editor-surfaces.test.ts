/**
 * Multi-editor surfaces are generated from ONE contract (harness pillar 4).
 *
 * Codex/Gemini/Antigravity surfaces compose the same atomic CONTRACT, so every
 * rig teaches the canonical verbs + sovereign KB and can never drift from the
 * Claude skill. Codex's ~1024-byte cap is honored with metadata headroom.
 */

import { describe, expect, it } from 'bun:test'
import {
  buildAntigravityConfig,
  buildAntigravitySkill,
  buildCodexSkill,
  buildCursorRule,
  buildGeminiConfig,
  CONTRACT,
} from '../../services/skill-generator/editor-surfaces'

const KB_FACETS = ['identity', 'voice', 'glossary', 'framework']
const CODEX_CAP = 1024

describe('multi-editor surfaces generated from one contract', () => {
  const codex = buildCodexSkill()
  const antigravitySkill = buildAntigravitySkill()
  const gemini = buildGeminiConfig()
  const antigravityConfig = buildAntigravityConfig()
  const all = [codex, antigravitySkill, gemini, antigravityConfig]

  it('teaches the same core contract on every rig (no drift)', () => {
    for (const surface of all) {
      expect(surface).toContain('prjct work')
      expect(surface).toContain('prjct remember')
      expect(surface).toContain('RAG-backed project memory harness')
      for (const facet of KB_FACETS) expect(surface).toContain(facet)
    }
  })

  it('teaches verb dispatch: known cmds bare, never work-wrap (token-burn fix)', () => {
    // Compact skills + global configs must carry the anti work-"sync" contract.
    for (const surface of all) {
      expect(surface).toContain(CONTRACT.entrypoint)
      expect(surface.toLowerCase()).toMatch(/never work-wrap|never wrap/)
      expect(surface).toContain('sync')
    }
  })

  it('keeps the compact skills under the Codex cap with metadata headroom', () => {
    for (const skill of [codex, antigravitySkill]) {
      expect(Buffer.byteLength(skill, 'utf-8')).toBeLessThanOrEqual(CODEX_CAP - 50)
    }
  })

  it('global configs keep the operational guidance + markers, rig-named', () => {
    for (const cfg of [gemini, antigravityConfig]) {
      expect(cfg).toContain('<!-- prjct:start')
      expect(cfg).toContain('Worktree hygiene')
      expect(cfg).toContain('Crew (opt-in')
    }
    expect(gemini).toContain('in Gemini, identify the role')
    expect(antigravityConfig).toContain('in Antigravity, identify the role')
  })

  it('every surface composes the shared CONTRACT (single source of truth)', () => {
    for (const surface of all) expect(surface).toContain(CONTRACT.rag)
    for (const surface of all) expect(surface).toContain(CONTRACT.output)
  })

  it('loop-discipline contract is on every multi-runtime surface (SUPERIOR parity)', () => {
    for (const surface of all) {
      expect(surface).toContain(CONTRACT.loop)
      expect(surface).toMatch(/tip→user|close|land|H2\+/)
    }
  })

  it('keeps compact skills pull-only and storage-safe', () => {
    for (const skill of [codex, antigravitySkill]) {
      expect(skill).toContain('do not preload project history')
      expect(skill).toContain('not something to load wholesale')
      expect(skill).toContain('Save synthesized memory in English')
      expect(skill).not.toContain('~/.prjct-cli/projects/{projectId}/prjct.db')
      expect(skill).not.toContain('workflow stations')
    }
  })

  it('global configs keep the world-class proof verbs visible without heavy methodology', () => {
    for (const cfg of [gemini, antigravityConfig]) {
      expect(cfg).toContain('insights')
      expect(cfg).toContain('performance')
      expect(cfg).toContain('prjct work')
      expect(cfg).not.toContain('## Builder ethos')
      expect(cfg).not.toContain('### Subagent dispatch')
    }
  })
})

describe('IDE rule pointer', () => {
  const cursor = buildCursorRule()

  it('carries the shared minimal pointer (clean-repo: no ruleset)', () => {
    expect(cursor).toContain('prjct work --md')
    expect(cursor).toContain('This file holds no rules')
    expect(cursor).toContain('<!-- prjct:start')
    expect(cursor).not.toContain('RAG-backed project memory harness') // pointer, not contract
  })

  it('uses Cursor frontmatter', () => {
    expect(cursor).toContain('alwaysApply: true')
  })
})
