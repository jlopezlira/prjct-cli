/**
 * `prjct skill-adherence [window]` — read-only harness #16 QA surface.
 *
 * Pins: window grammar (mirrors retro), empty-state is success, a
 * miss + its `resolves:skill-miss` resolution produce a non-zero
 * adherence ratio, and `--md` emits valid markdown.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SkillAdherenceCommands } from '../../commands/skill-adherence'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import prjctDb from '../../storage/database'

const fixture: {
  dir: string
  projectId: string
} = {
  dir: '',
  projectId: '',
}

const cmd = new SkillAdherenceCommands()

function logMiss(relates: string): void {
  prjctDb.appendEvent(fixture.projectId, 'memory.remember.improvement-signal', {
    content: `[skill-miss] Unused project knowledge (decision, ${relates}): "x"`,
    tags: { source: 'skill-miss-detector', category: 'skill-miss', relates, key: `k-${relates}` },
    provenance: 'extracted',
  })
}

function logResolution(relates: string): void {
  prjctDb.appendEvent(fixture.projectId, 'memory.remember.decision', {
    content: 'addressed it',
    tags: { resolves: 'skill-miss', relates },
    provenance: 'declared',
  })
}

beforeEach(async () => {
  prjctDb.close()
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-skilladh-test-'))
  await fs.mkdir(path.join(fixture.dir, '.prjct'), { recursive: true })
  fixture.projectId = `skilladh-${crypto.randomUUID()}`
  await configManager.writeConfig(fixture.dir, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.dir, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
  prjctDb.close()
})

describe('prjct skill-adherence', () => {
  it('rejects an invalid window', async () => {
    const r = await cmd.skillAdherence('not-a-window', fixture.dir, { md: true })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Invalid window/)
  })

  it('is a clean success when no skill-misses exist', async () => {
    const r = await cmd.skillAdherence('7d', fixture.dir, { md: true })
    expect(r.success).toBe(true)
    expect(r.misses).toBe(0)
    expect(r.adherence).toBe(1)
  })

  it('computes the resolved ratio from resolves:skill-miss decisions', async () => {
    logMiss('mem_1')
    logMiss('mem_2')
    logResolution('mem_1')
    const r = await cmd.skillAdherence('7d', fixture.dir, { md: true })
    expect(r.success).toBe(true)
    expect(r.misses).toBe(2)
    expect(r.resolved).toBe(1)
    expect(r.adherence).toBe(0.5)
  })

  it('emits markdown under --md', async () => {
    logMiss('mem_9')
    const out: string[] = []
    const orig = console.log
    console.log = (m?: unknown) => {
      out.push(String(m))
    }
    try {
      await cmd.skillAdherence('30d', fixture.dir, { md: true })
    } finally {
      console.log = orig
    }
    const text = out.join('\n')
    expect(text).toContain('## Skill adherence — last 30d')
    expect(text).toContain('| State | Memory | File | Signal |')
  })
})
