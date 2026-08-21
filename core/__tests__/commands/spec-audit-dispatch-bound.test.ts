/**
 * renderAuditDispatch — the spec lives in prjct, never in the prompt, and the
 * dispatch is correct for the active rig (native subagents on Claude, emulated
 * fresh-context fan-out elsewhere). Provider is pinned for determinism.
 *
 * MUST: no plan/memory/task is duplicated outside prjct's SQLite + vault.
 */

import { describe, expect, it } from 'bun:test'
import { renderAuditDispatch } from '../../commands/spec'
import { emptySpecContent } from '../../types/spec'

describe('renderAuditDispatch — points reviewers at prjct, never embeds the spec', () => {
  it('does NOT embed the spec body, even pathological free text', async () => {
    const c = emptySpecContent('Add rate limiting to the auth endpoint')
    const canary = 'CANARY_SECRET_PLAN_TEXT_should_never_appear_in_prompt'
    c.notes = canary
    c.eli10 = `${canary}_eli10`
    const out = await renderAuditDispatch('spec-abc123', 'Rate limiting', c, undefined, 'claude')
    expect(out).not.toContain(canary)
    expect(out).not.toContain('```json')
  })

  it('instructs every selected reviewer to read the spec from prjct by id', async () => {
    const c = emptySpecContent('Add auth to the API endpoint with a DB schema migration')
    const out = await renderAuditDispatch('spec-abc123', 'X', c, undefined, 'claude')
    const occurrences = out.split('prjct spec show spec-abc123 --md').length - 1
    expect(occurrences).toBeGreaterThanOrEqual(3)
    expect(out).toContain('it is NOT in this prompt')
  })

  it('honors an explicit lens override (fewer lenses → fewer reviewers)', async () => {
    const out = await renderAuditDispatch(
      'spec-x',
      'X',
      emptySpecContent('g'),
      ['architecture'],
      'claude'
    )
    expect(out).toContain('Reviewer A — architecture')
    expect(out).not.toContain('Reviewer B')
    expect(out).toContain('Selected lenses for this spec: **architecture**')
  })

  it('still hands reviewers codebase PATHS (pointers, not pasted source)', async () => {
    const c = emptySpecContent('g')
    c.scope = ['core/auth/limiter.ts — the limiter']
    const out = await renderAuditDispatch('spec-x', 'X', c, undefined, 'claude')
    expect(out).toContain('core/auth/limiter.ts')
    expect(out).toContain('Read tool')
  })

  it('names no model on a Claude rig', async () => {
    const out = await renderAuditDispatch('spec-x', 'X', emptySpecContent('g'), undefined, 'claude')
    expect(out).toContain('Do not set `model:` on any reviewer')
    expect(out).not.toContain('model: "sonnet"')
    expect(out).not.toContain("NOT the parent's max model")
    expect(out).toContain('via the Agent tool') // native subagent dispatch
  })

  it('emulates the fan-out on a non-Claude rig, still naming no model', async () => {
    const c = emptySpecContent('Add auth to the API endpoint with a DB schema migration')
    const out = await renderAuditDispatch('spec-g', 'X', c, undefined, 'gemini')
    expect(out).toContain('no native subagent tool')
    expect(out).toContain('EMULATE the fan-out')
    expect(out).not.toContain('2.5-flash') // no rig model is prescribed
    expect(out).not.toContain('via the Agent tool')
    // Still never embeds the spec — points at prjct by id.
    expect(out).toContain('prjct spec show spec-g --md')
  })
})
