/**
 * Regression guards: prjct must NEVER pick a model for a subagent.
 *
 * This file used to enforce the opposite (PR #364): every crew role pinned a
 * `model:` and the skill reference shipped an opus/sonnet/haiku tier policy.
 * That capped 10 of 11 roles below the model the user chose to run and told
 * every non-implementer to "apply decent, not exhaustive, effort" — making the
 * harness systematically dumber than the brain being paid for, on every rig.
 *
 * The policy is gone (see `core/schemas/model.ts`). These guards keep it gone.
 *
 * Pure, deterministic checks (no build step): the generated SKILL.md is always
 * derived from buildPrjctSkill(), so protecting that function's output protects
 * the on-disk twin.
 */

import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildPrjctSkill,
  buildPrjctSkillReference,
} from '../../services/skill-generator/prjct-skill-body'

const CREW_AGENTS_DIR = path.join(__dirname, '../../../templates/crew/roles')

/** Pull `model:` out of the leading `---` frontmatter block. */
function frontmatterModel(md: string): string | null {
  const fm = md.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return null
  const line = fm[1].match(/^model:\s*(\S+)\s*$/m)
  return line ? line[1] : null
}

describe("crew agent frontmatter — no role pins a model (inherit the user's)", () => {
  const files = fs
    .readdirSync(CREW_AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()

  it('finds the expected crew agents', () => {
    expect(files).toEqual(['implementer.md', 'leader.md', 'reviewer.md'])
  })

  for (const file of files) {
    it(`${file} declares no model:`, () => {
      const md = fs.readFileSync(path.join(CREW_AGENTS_DIR, file), 'utf-8')
      expect(frontmatterModel(md)).toBeNull()
    })
  }

  it('no role template names a tier anywhere in its body', () => {
    for (const file of files) {
      const md = fs.readFileSync(path.join(CREW_AGENTS_DIR, file), 'utf-8')
      expect(md).not.toContain('model: "opus"')
      expect(md).not.toContain('model: "sonnet"')
      expect(md).not.toContain('model: "haiku"')
    }
  })
})

describe('skill generation invariants — the SSOT the SKILL.md twin is built from', () => {
  it('is deterministic (pure function, no hidden state)', () => {
    expect(buildPrjctSkill()).toBe(buildPrjctSkill())
    expect(buildPrjctSkillReference()).toBe(buildPrjctSkillReference())
  })

  // The heavy methodology (point-don't-carry, fan-out, crew reconciliation)
  // moved out of the always-in-context SKILL.md body into the pulled-on-demand
  // `workflows.md` reference (2.37 context-efficiency pivot). It still ships on
  // disk next to SKILL.md, so these guards now protect the reference twin.
  it('neither the skill nor its reference names a model or caps effort', () => {
    const forbidden = [
      'model: "opus"',
      'model: "sonnet"',
      'model: "haiku"',
      'Model policy',
      'max-tier',
      'mid-tier',
      'fast tier',
      'over-deliberate',
      'not exhaustive',
    ]
    for (const text of [buildPrjctSkill(), buildPrjctSkillReference()]) {
      for (const needle of forbidden) expect(text).not.toContain(needle)
    }
  })

  it('reference tells the reader to inherit the session model', () => {
    expect(buildPrjctSkillReference()).toContain('Do not pick models for subagents')
  })

  it('reference carries the point-dont-carry persistence MUST', () => {
    const ref = buildPrjctSkillReference()
    expect(ref).toContain("point, don't carry")
    expect(ref).toContain('prjct spec show <id> --md')
  })

  it('reference documents parallel implementer fan-out with disjoint scope', () => {
    const ref = buildPrjctSkillReference()
    expect(ref).toContain('Fan out implementers')
    expect(ref).toContain('DISJOINT files')
    // Sequential fallback must be present so the reader never parallelizes
    // two implementers onto the same file.
    expect(ref).toMatch(/do NOT parallelize/i)
  })

  it('reference reconciles crew mode so the leader, not the main session, owns code work', () => {
    const ref = buildPrjctSkillReference()
    expect(ref).toContain('Crew mode reconciliation')
    expect(ref).toContain('.claude/agents/leader.md')
  })

  it('the lean SKILL.md body points at the reference instead of inlining it', () => {
    const skill = buildPrjctSkill()
    expect(skill).toContain('workflows.md')
    // The heavy methodology must NOT sit in the always-in-context body.
    expect(skill).not.toContain('Crew mode reconciliation')
  })
})

describe('crew leader template — parallel executor fan-out', () => {
  const read = (f: string) => fs.readFileSync(path.join(CREW_AGENTS_DIR, f), 'utf-8')

  it('leader documents fanning out N implementers over disjoint scope', () => {
    const leader = read('leader.md')
    expect(leader).toContain('disjoint files')
    expect(leader).toContain('IN THE SAME MESSAGE')
    expect(leader).toMatch(/Partition rule/i)
  })

  it('leader keeps a sequential fallback when scopes cannot be partitioned', () => {
    const leader = read('leader.md')
    expect(leader).toMatch(/do NOT parallelize/i)
  })

  it('leader composes review SPECIALISTS over the combined diff (not a fixed single reviewer)', () => {
    const leader = read('leader.md')
    // Still one review pass-set over the whole batch, not per-implementer…
    expect(leader).toContain('combined')
    expect(leader).toMatch(/not a reviewer per implementer/i)
    // …but the review is the specialists the change raises, not one generic reviewer.
    expect(leader).toMatch(/compose the specialists/i)
    expect(leader).toContain('architecture') // floor lens
    expect(leader).toContain('security')
  })
})
