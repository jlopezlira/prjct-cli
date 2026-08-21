/**
 * L0 quality guards.
 *
 * Everything here rides in front of the user's prompt on every session, so a
 * mangled or degenerate entry is not merely useless — it spends the reader's
 * attention and invites guessing. These pin the three ways the digest used to
 * corrupt what it carried.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { formatMemoryDigestLine } from '../../memory/format'

const entry = (content: string, id = 'mem_1') => ({ id, type: 'gotcha', content }) as never

describe('digest lines never cut mid-word', () => {
  // The teaser was `slice(0, maxTeaser - 1)`, a hard character cut. The
  // operative half of a rule was routinely the half that got dropped:
  // "Node exec() pipes stdin, so bun test …".
  it('clips at a word boundary, not inside a word', () => {
    const body =
      'Stop-Slop verify: bun test must run via runProc because Node exec pipes stdin and the process group is tree-killed on timeout'
    const line = formatMemoryDigestLine(entry(body), { minTeaser: 24, maxTeaser: 90 })
    const teaser = line.slice(line.indexOf('—') + 1, line.lastIndexOf('`mem_1`')).trim()
    const withoutMarker = teaser.replace(/…$/, '').trimEnd()
    // The clipped text must end on a complete word from the source.
    expect(body).toContain(withoutMarker)
    expect(withoutMarker.endsWith(' ')).toBe(false)
    const lastWord = withoutMarker.split(' ').at(-1) ?? ''
    expect(body.split(/\s+/)).toContain(lastWord)
  })

  it('leaves short bodies untouched', () => {
    const body = 'Prefer runProc over exec for anything reading stdin.'
    const line = formatMemoryDigestLine(entry(body), { minTeaser: 4, maxTeaser: 400 })
    expect(line).not.toContain('…')
  })

  // The title already absorbs the first sentence, so the preference applies to
  // a sentence boundary that falls inside the teaser window.
  it('ends the teaser on a sentence boundary rather than mid-filler', () => {
    const sentence = 'The lexer must strip heredoc bodies before tokenizing the command line here.'
    const body = `Guard. ${sentence} ${'x'.repeat(300)}`
    const line = formatMemoryDigestLine(entry(body), { minTeaser: 10, maxTeaser: 120 })
    expect(line).toContain(sentence)
    expect(line).not.toContain('xx')
  })
})

describe('auto-detected signals stay out of the L0 knowledge sections', () => {
  // Git telemetry ("Hot file: x.ts — 8 touches in the last 7 days") was
  // persisted as `learning`, so it competed with real learnings for the
  // handful of lines every session carries — 44 of them in this corpus.
  it('pattern-detector writes system-event, never learning', () => {
    const src = readFileSync(
      path.join(__dirname, '..', '..', 'services', 'pattern-detector.ts'),
      'utf-8'
    )
    expect(src).toContain("const AUTO_SIGNAL_TYPE = 'system-event'")
    expect(src).not.toContain("type: 'learning'")
  })
})
