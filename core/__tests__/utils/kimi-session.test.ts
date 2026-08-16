/**
 * Kimi session transcript resolution — locate the main agent's wire.jsonl
 * from a Stop payload's session_id (Kimi sends no transcript_path).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveKimiTranscriptPath } from '../../utils/kimi-session'

const fixture: { root: string } = { root: '' }

beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-kimi-session-test-'))
})

afterEach(async () => {
  await fs.rm(fixture.root, { recursive: true, force: true }).catch(() => {})
})

async function seedWire(sessionDir: string): Promise<string> {
  const wire = path.join(
    fixture.root,
    'wd_proj_deadbeef',
    sessionDir,
    'agents',
    'main',
    'wire.jsonl'
  )
  await fs.mkdir(path.dirname(wire), { recursive: true })
  await fs.writeFile(wire, '{"type":"metadata"}\n', 'utf-8')
  return wire
}

describe('resolveKimiTranscriptPath', () => {
  it('resolves a bare uuid to session_<uuid>/agents/main/wire.jsonl', async () => {
    const wire = await seedWire('session_abc-123')
    expect(await resolveKimiTranscriptPath('abc-123', fixture.root)).toBe(wire)
  })

  it('accepts an id that already carries the session_ prefix', async () => {
    const wire = await seedWire('session_abc-123')
    expect(await resolveKimiTranscriptPath('session_abc-123', fixture.root)).toBe(wire)
  })

  it('returns undefined when the session or wire file does not exist', async () => {
    await seedWire('session_abc-123')
    expect(await resolveKimiTranscriptPath('missing-id', fixture.root)).toBeUndefined()
    expect(
      await resolveKimiTranscriptPath('abc-123', path.join(fixture.root, 'nope'))
    ).toBeUndefined()
  })

  it('sanitizes traversal characters out of the session id', async () => {
    const wire = await seedWire('session_abcetc')
    // '../etc' strips to 'etc'… and still resolves only inside the root.
    expect(await resolveKimiTranscriptPath('../abc/etc', fixture.root)).toBe(wire)
    expect(await resolveKimiTranscriptPath('', fixture.root)).toBeUndefined()
  })
})
