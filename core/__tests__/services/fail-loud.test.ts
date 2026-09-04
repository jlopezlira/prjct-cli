/**
 * Two gates with one rule: never silently accept something already known to be
 * wrong. Both come from real incidents in this repo, not hypotheticals.
 */

import { describe, expect, it } from 'bun:test'
import { unknownConfigKeys, unknownConfigKeysMessage } from '../../services/config-validation'
import {
  CONTRADICTION_SIM,
  findContradiction,
  isNegated,
  polarityDiffers,
} from '../../services/memory-contradiction'

// The exact pair that occurred: a corrected fact re-asserted in its old form,
// which then won the binding tip slot over the correction.
const BELIEVED_CONTENT =
  'prjct upgrade regenerates the Claude skill as of v4.6.0 (PR #625). The cleanup phase in core/commands/update.ts now calls skillGenerator.generateAndInstall(), so SKILL.md and workflows.md are rewritten on every upgrade.'
const BELIEVED = {
  id: 'mem_17549',
  type: 'decision',
  content:
    'prjct upgrade regenerates the Claude skill as of v4.6.0 (PR #625). The cleanup phase in core/commands/update.ts now calls skillGenerator.generateAndInstall(), so SKILL.md and workflows.md are rewritten on every upgrade.',
} as never
const STALE =
  'prjct upgrade does NOT regenerate the Claude skill. generateAndInstall (which writes ~/.claude/skills/prjct/SKILL.md AND workflows.md) is only called from sync-service.ts and doctor-heal.ts — never from upgrade or install.'

describe('polarity is judged on the leading claim', () => {
  // Counting negations over the whole text misses the real case: the stale
  // claim carries two ("does NOT", "never") and the correction none — same
  // parity, opposite meaning. The trailing clause reinforces, it does not flip.
  it('reads the claim, not the supporting clauses', () => {
    expect(isNegated(STALE)).toBe(true)
    expect(isNegated(BELIEVED_CONTENT)).toBe(false)
    expect(polarityDiffers(STALE, BELIEVED_CONTENT)).toBe(true)
  })

  it('ignores negations that live outside the claim', () => {
    const a = 'prjct upgrade regenerates the skill. It is never skipped.'
    const b = 'prjct upgrade regenerates the skill on every run.'
    expect(polarityDiffers(a, b)).toBe(false)
  })

  // Substrings must not count — but a hyphen IS a word boundary, so
  // "none-such" legitimately contains the standalone word "none".
  it('does not trip on words that merely contain a negation as a substring', () => {
    expect(isNegated('Another note about nostalgia in notation and nonce values')).toBe(false)
    expect(isNegated('none-such naming')).toBe(true)
  })
})

describe('a contradicting memory is refused', () => {
  it('catches the contradiction that actually happened', () => {
    const hit = findContradiction(STALE, 'gotcha', [BELIEVED])
    expect(hit).not.toBeNull()
    expect(hit?.id).toBe('mem_17549')
    expect(hit?.similarity).toBeGreaterThanOrEqual(CONTRADICTION_SIM)
    expect(hit?.message).toContain('contradicts a memory already in force')
    // The refusal must be actionable, naming the entry and the way through.
    expect(hit?.message).toContain('supersedes:mem_17549')
  })

  it('stays quiet on a refinement — same claim, same polarity', () => {
    const refinement =
      'prjct upgrade regenerates the Claude skill on every run, including workflows.md.'
    expect(findContradiction(refinement, 'decision', [BELIEVED])).toBeNull()
  })

  it('stays quiet on a different subject, however similar the shape', () => {
    const other = 'prjct sync regenerates the Claude skill and rebuilds the L0 index.'
    expect(findContradiction(other, 'decision', [BELIEVED])).toBeNull()
  })

  it('stays quiet on unrelated content and on negated-but-unrelated content', () => {
    expect(
      findContradiction('Biome check runs lint and format together.', 'gotcha', [BELIEVED])
    ).toBeNull()
    expect(
      findContradiction('Do not hand-edit generated SKILL.md as source of truth.', 'gotcha', [
        BELIEVED,
      ])
    ).toBeNull()
  })

  it('only guards high-confidence types', () => {
    const lowStakes = {
      ...(BELIEVED as unknown as Record<string, unknown>),
      type: 'context',
    } as never
    expect(findContradiction(STALE, 'gotcha', [lowStakes])).toBeNull()
  })
})

describe('a config key prjct ignores is reported', () => {
  // A typo parses fine, is dropped, and the feature it was meant to enable
  // never runs — indistinguishable from the feature being broken.
  it('names the near-miss', () => {
    const [hit, ...rest] = unknownConfigKeys({ projectId: 'x', maxTokenPerCycle: 100 })
    expect(rest).toHaveLength(0)
    expect(hit?.key).toBe('maxTokenPerCycle')
    expect(hit?.didYouMean).toBe('maxTokensPerCycle')
  })

  it('accepts every documented key', () => {
    expect(
      unknownConfigKeys({
        projectId: 'x',
        dataPath: '/tmp',
        maxTokensPerCycle: 1,
        contextPressure: {},
        sdd: {},
        qa: {},
        cloud: {},
      })
    ).toEqual([])
  })

  it('tolerates comment-style annotations', () => {
    expect(unknownConfigKeys({ projectId: 'x', '//note': 'why', $schema: 'url' })).toEqual([])
  })

  it('offers no suggestion when nothing is close', () => {
    const [hit] = unknownConfigKeys({ zzzzTotallyUnrelated: 1 })
    expect(hit?.didYouMean).toBeNull()
  })

  it('renders an actionable message, or null when clean', () => {
    expect(unknownConfigKeysMessage({ projectId: 'x' })).toBeNull()
    const msg = unknownConfigKeysMessage({ tddd: {} }) ?? ''
    expect(msg).toContain('tddd')
    expect(msg).toContain('did you mean `tdd`')
    expect(msg).toContain("prjct's global project settings")
    expect(msg).toContain('client locator is not configuration')
  })
})
