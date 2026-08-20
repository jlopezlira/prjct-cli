/**
 * Developer profile synthesis — the "know the developer" half of the model.
 */

import { describe, expect, it } from 'bun:test'
import type { MemoryEntry } from '../../memory/entries'
import { buildDeveloperProfile, extractDeveloperRules } from '../../services/developer-profile'

function entry(
  id: string,
  type: string,
  content: string,
  tags: Record<string, string> = {}
): MemoryEntry {
  return {
    id,
    type,
    content,
    tags,
    rememberedAt: '2026-05-31T00:00:00Z',
    provenance: 'declared',
  } as MemoryEntry
}

describe('buildDeveloperProfile', () => {
  it('returns null with no feedback and no friction', () => {
    expect(buildDeveloperProfile([entry('mem_1', 'decision', 'use sqlite')])).toBeNull()
  })

  it('synthesizes preferences from feedback and friction from pushback signals', () => {
    const out = buildDeveloperProfile([
      entry('mem_1', 'feedback', 'Author memory in English regardless of conversation language.'),
      entry(
        'mem_2',
        'improvement-signal',
        [
          '[negation] Lesson: Confirm dependency constraints before adding packages.',
          'What happened: The user pushed back after the assistant response.',
          'Why it mattered: The assistant moved toward native dependencies without confirming the project constraint.',
          'Pattern: User rejects a workflow or implementation assumption.',
          'Anti-pattern: Treating a convenience dependency as acceptable without checking repo constraints.',
          'Next action: Check existing dependency policy and choose a no-native-deps path.',
        ].join('\n'),
        {
          source: 'friction-detector',
        }
      ),
      entry('mem_3', 'decision', 'unrelated decision'),
    ])
    expect(out).not.toBeNull()
    expect(out).toContain('# Developer profile')
    expect(out).toContain('## Act as this developer')
    expect(out).toContain('## Preferences & guidance')
    expect(out).toContain('English')
    expect(out).toContain('## Working principles')
    expect(out).toContain('Check existing dependency policy')
    expect(out).toContain('## Friction history')
    expect(out).toContain('Confirm dependency constraints before adding packages.')
    expect(out).toContain('`mem_1`')
    expect(out).not.toContain('unrelated decision')
  })

  it('keeps legacy raw friction entries readable as fallback', () => {
    const out = buildDeveloperProfile([
      entry('mem_2', 'improvement-signal', '[negation] User pushback: "no native deps"', {
        source: 'friction-detector',
      }),
    ])
    expect(out).toContain('## Friction history')
    expect(out).toContain('User pushback')
    expect(out).toContain('no native deps')
  })

  it('omits the friction section when there is no friction signal', () => {
    const out = buildDeveloperProfile([entry('mem_1', 'feedback', 'ship as minor')])
    expect(out).toContain('## Preferences & guidance')
    expect(out).toContain('## Act as this developer')
    expect(out).not.toContain('## Friction history')
    expect(out).not.toContain('## Working principles')
  })

  it('ignores improvement-signals that are not from the friction detector', () => {
    const out = buildDeveloperProfile([
      entry('mem_1', 'feedback', 'a standing preference rule here'),
      entry('mem_2', 'improvement-signal', 'skill-miss noise', { source: 'skill-miss-detector' }),
    ])
    expect(out).not.toContain('## Friction history')
    expect(out).not.toContain('skill-miss noise')
  })

  it('reapplies adaptive output discipline as a developer rule', () => {
    const signal = entry(
      'mem_output',
      'improvement-signal',
      [
        '[output-slop] Adaptive output signal.',
        'Observed: Assistant response repeated substantial content.',
        'Expected: State each result once.',
        'Next action: Answer at the smallest useful profile and lead with the outcome.',
      ].join('\n'),
      { source: 'output-slop-detector' }
    )

    const rules = extractDeveloperRules([signal])
    expect(rules).toHaveLength(1)
    expect(rules[0]?.kind).toBe('adaptive')
    expect(rules[0]?.rule).toContain('smallest useful profile')
    const profile = buildDeveloperProfile([signal])
    expect(profile).toContain('smallest useful profile')
    expect(profile).toContain('heuristic, not user pushback')
    expect(profile).not.toContain('## Friction history')
  })
})

describe('extractDeveloperRules', () => {
  it('prefers explicit feedback over friction, dedupes, and caps', () => {
    const rules = extractDeveloperRules(
      [
        entry('mem_1', 'feedback', 'Always author memory content in English.'),
        entry('mem_2', 'feedback', 'Always author memory content in English.'),
        entry(
          'mem_3',
          'improvement-signal',
          '[negation] Lesson: Stop adding features without a quality gate.\nNext action: Deepen existing loops before shipping new surface.',
          { source: 'friction-detector' }
        ),
        entry('mem_4', 'decision', 'ignore me'),
      ],
      4
    )
    expect(rules.length).toBe(2)
    expect(rules[0]!.kind).toBe('preference')
    expect(rules[0]!.rule).toContain('English')
    expect(rules[1]!.kind).toBe('friction')
    expect(rules[1]!.rule).toContain('Deepen existing loops')
  })

  it('returns empty when nothing is distillable', () => {
    expect(extractDeveloperRules([entry('mem_1', 'decision', 'sqlite only')])).toEqual([])
  })
})
