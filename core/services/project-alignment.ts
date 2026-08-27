/**
 * Project pattern supremacy — pure framing for work/review injects.
 *
 * Rule (user 2026-07): do not write code misaligned with the project.
 *   - sound house style → MATCH it (no foreign model taste)
 *   - shit house style → PROPOSE upgrade (anti-pattern), don't spread more shit
 *   - never make the client tutor basics already in the tree
 *
 * Not a linter: advisory cards + skill contract. Mechanical prefer-const
 * refute lives in precision-judgment.ts.
 */

export type AlignmentStance = 'match' | 'upgrade' | 'unknown'

export interface AlignmentBrief {
  stance: AlignmentStance
  /** One terminal / inject line */
  line: string
  md: string
}

/**
 * Build a short alignment brief from recalled patterns + anti-patterns.
 * Empty inputs → unknown (agent must open a neighbor file).
 */
export function buildAlignmentBrief(input: {
  patterns?: ReadonlyArray<{ title?: string; content?: string }>
  antiPatterns?: ReadonlyArray<{ title?: string; content?: string }>
  neighborHint?: string | null
}): AlignmentBrief {
  const patterns = input.patterns ?? []
  const antis = input.antiPatterns ?? []
  const neighbor = input.neighborHint?.trim() || null

  if (antis.length > 0 && patterns.length === 0) {
    const sample = summarize(antis[0]!)
    return {
      stance: 'upgrade',
      line: `Align: project has anti-patterns (${sample}) — propose upgrade, do not copy the shit.`,
      md: [
        '## Project alignment — UPGRADE',
        '',
        'Anti-patterns present without a compensating house pattern. Do **not** spread more of the same.',
        'Propose a better approach with why; get consent before rewriting style across the tree.',
        antis
          .slice(0, 3)
          .map((a) => `- anti: ${summarize(a)}`)
          .join('\n'),
        neighbor ? `\nNeighbor to read first: \`${neighbor}\`` : '',
        '',
      ].join('\n'),
    }
  }

  if (patterns.length > 0) {
    const sample = summarize(patterns[0]!)
    return {
      stance: 'match',
      line: `Align: match house patterns (${sample})${neighbor ? ` · open \`${neighbor}\`` : ''} — no foreign style.`,
      md: [
        '## Project alignment — MATCH',
        '',
        'House patterns exist and apply. **Match them.** Do not inject generic model defaults.',
        patterns
          .slice(0, 4)
          .map((p) => `- pattern: ${summarize(p)}`)
          .join('\n'),
        antis.length
          ? `\nAvoid:\n${antis
              .slice(0, 3)
              .map((a) => `- ${summarize(a)}`)
              .join('\n')}`
          : '',
        neighbor ? `\nNeighbor: \`${neighbor}\`` : '',
        '',
      ].join('\n'),
    }
  }

  return {
    stance: 'unknown',
    line: neighbor
      ? `Align: no stored patterns — open neighbor \`${neighbor}\` and match local idiom before writing.`
      : 'Align: no stored patterns — open a neighbor file in scope and match local idiom before writing.',
    md: [
      '## Project alignment — READ NEIGHBOR',
      '',
      'No durable patterns in memory. **Do not invent style.** Open a nearby file in the work scope and mirror its layering/naming/errors.',
      neighbor ? `Start with: \`${neighbor}\`` : 'Use Work scope / BM25 seeds from `prjct work`.',
      '',
    ].join('\n'),
  }
}

function summarize(e: { title?: string; content?: string }): string {
  const title = (e.title ?? '').replace(/\s+/g, ' ').trim()
  const content = (e.content ?? '').replace(/\s+/g, ' ').trim()
  const t =
    title && content && title.toLowerCase() !== content.toLowerCase()
      ? `${title} — ${content}`
      : title || content
  return t.length > 90 ? `${t.slice(0, 89)}…` : t || '(untitled)'
}
