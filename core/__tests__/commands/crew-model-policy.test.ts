/**
 * Crew agents carry NO model pin (harness pillar 3).
 *
 * Installs used to stamp `model:` per role (leader=haiku, reviewer=sonnet,
 * implementer=opus), which capped every role below the model the user chose to
 * run. The pin is now stripped at install time so each crew agent inherits the
 * session model. See `core/schemas/model.ts`.
 */

import { describe, expect, it } from 'bun:test'
import { stripCrewModelPin } from '../../commands/crew'

const FRONTMATTER = '---\nname: x\nmodel: sonnet\ncolor: blue\n---\n\nbody\n'

describe('crew install strips the model pin', () => {
  const roles = ['leader', 'implementer', 'reviewer'] as const

  for (const role of roles) {
    it(`removes the model: line from the ${role} template`, () => {
      const out = stripCrewModelPin(FRONTMATTER, role)
      expect(out).not.toContain('model:')
      // Everything else in the frontmatter survives.
      expect(out).toContain('name: x')
      expect(out).toContain('color: blue')
      expect(out).toContain('body')
      expect(out).toBe('---\nname: x\ncolor: blue\n---\n\nbody\n')
    })
  }

  it('is a no-op for a template with no model: line', () => {
    const tpl = '---\nname: leader\n---\n'
    expect(stripCrewModelPin(tpl, 'leader')).toBe(tpl)
  })

  it('leaves a name mapped to no crew role untouched', () => {
    const tpl = '---\nmodel: keep\n---\n'
    expect(stripCrewModelPin(tpl, 'other')).toBe(tpl)
  })
})
