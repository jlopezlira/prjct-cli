import { afterEach, beforeEach, describe, expect, it, type spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { projectMemory } from '../../memory/project-memory'
import {
  evaluateContextQuality,
  repairContextQuality,
} from '../../services/context-quality-service'
import { prjctDb } from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: {
  tmpRoot: string
  projectRoot: string
  projectId: string
  spies: Array<ReturnType<typeof spyOn>>
} = {
  tmpRoot: '',
  projectRoot: '',
  projectId: '',
  spies: undefined as unknown as Array<ReturnType<typeof spyOn>>,
}

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-context-quality-'))
  fixture.projectRoot = path.join(fixture.tmpRoot, 'repo')
  fixture.projectId = `context-quality-${Date.now()}`
  fixture.spies = []
  patchPathManager(fixture.tmpRoot)
  await fs.mkdir(path.join(fixture.projectRoot, '.prjct'), { recursive: true })
  await fs.writeFile(
    path.join(fixture.projectRoot, '.prjct', 'prjct.config.json'),
    JSON.stringify({ projectId: fixture.projectId, dataPath: '' }, null, 2)
  )
  await fs.mkdir(path.join(fixture.tmpRoot, fixture.projectId), { recursive: true })
  prjctDb.getDb(fixture.projectId)
})

afterEach(async () => {
  prjctDb.close()
  for (const s of fixture.spies) s.mockRestore()
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
})

function appendMemory(
  type: string,
  content: string,
  tags: Record<string, string> = {},
  provenance = 'declared'
): void {
  prjctDb.appendEvent(fixture.projectId, `memory.remember.${type}`, {
    content,
    tags,
    provenance,
  })
}

describe('context quality cleanup', () => {
  it('hard-removes generated garbage and creates living-v2 repair context', async () => {
    appendMemory('improvement-signal', 'skill-miss: agent ignored prjct memory', {
      source: 'skill-miss-detector',
    })
    appendMemory('learning', 'Hot file: `core/a.ts` changed 9 times.', {
      source: 'pattern-detector-auto',
      file: 'core/a.ts',
    })
    appendMemory('context', 'short raw legacy snippet')
    appendMemory('decision', 'Use SQLite as the durable source of truth for project memory.')

    const before = evaluateContextQuality(fixture.projectId)
    expect(before.score).toBeLessThan(before.threshold)

    const repaired = await repairContextQuality(fixture.projectRoot, fixture.projectId)

    expect(repaired.passed).toBe(true)
    expect(repaired.irrelevantRemoved).toBe(3)
    expect(repaired.repairEntriesCreated).toBe(1)
    const active = projectMemory.allEntriesForIndex(fixture.projectId)
    expect(active.some((e) => e.type === 'improvement-signal')).toBe(false)
    expect(active.some((e) => e.tags.source === 'pattern-detector-auto')).toBe(false)
    expect(active.some((e) => e.content === 'short raw legacy snippet')).toBe(false)
    expect(active.some((e) => e.type === 'decision')).toBe(true)
    expect(active.some((e) => e.type === 'context' && e.tags.context_schema === 'living-v2')).toBe(
      true
    )
  })

  it('does not delete user-declared decisions even when quality is low', async () => {
    appendMemory('decision', 'Keep payments gating server-side only.')

    const repaired = await repairContextQuality(fixture.projectRoot, fixture.projectId)

    expect(repaired.irrelevantRemoved).toBe(0)
    const active = projectMemory.allEntriesForIndex(fixture.projectId)
    expect(active.some((e) => e.content === 'Keep payments gating server-side only.')).toBe(true)
  })
})
