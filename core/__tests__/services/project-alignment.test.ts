/**
 * Project pattern supremacy brief.
 */

import { describe, expect, it } from 'bun:test'
import { buildAlignmentBrief } from '../../services/project-alignment'

describe('project-alignment', () => {
  it('MATCH when house patterns exist', () => {
    const b = buildAlignmentBrief({
      patterns: [
        {
          title: 'Process boundary',
          content: 'Use execFileAsync, never shell spawns. [canonical: core/utils/exec.ts]',
        },
      ],
      neighborHint: 'core/utils/exec.ts',
    })
    expect(b.stance).toBe('match')
    expect(b.line).toMatch(/match house patterns/i)
    expect(b.line).toContain('core/utils/exec.ts')
    expect(b.md).toContain('Use execFileAsync')
  })

  it('UPGRADE when only anti-patterns', () => {
    const b = buildAlignmentBrief({
      antiPatterns: [{ content: 'God objects in services/' }],
    })
    expect(b.stance).toBe('upgrade')
    expect(b.line).toMatch(/anti-pattern|upgrade|do not copy/i)
  })

  it('UNKNOWN → open neighbor', () => {
    const b = buildAlignmentBrief({ neighborHint: 'src/a.ts' })
    expect(b.stance).toBe('unknown')
    expect(b.line).toMatch(/neighbor/)
  })
})
