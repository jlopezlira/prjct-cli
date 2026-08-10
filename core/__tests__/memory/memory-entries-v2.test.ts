/**
 * C1: authored memory is mirrored into the normalized v2 tables
 * (memory_entries + memory_entry_tags) on every remember — typed `file` column
 * and `is_machine` tag flag — and the backfill copies existing rows. Parity:
 * one v2 row per live memory, content matches, tags normalized.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { projectMemory } from '../../memory/project-memory'
import prjctDb from '../../storage/database'

const fixture: {
  tmpRoot: string
  projectRoot: string
} = {
  tmpRoot: '',
  projectRoot: '',
}

const projectId = 'mem-v2-test'
const spies: Array<ReturnType<typeof spyOn>> = []

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-mem-v2-'))
  fixture.projectRoot = path.join(fixture.tmpRoot, 'proj')
  await fs.mkdir(path.join(fixture.projectRoot, '.prjct'), { recursive: true })
  await fs.writeFile(
    path.join(fixture.projectRoot, '.prjct', 'prjct.config.json'),
    JSON.stringify({ projectId, dataPath: '' }, null, 2)
  )
  spies.push(
    spyOn(pathManager, 'getGlobalProjectPath').mockImplementation((pid: string) =>
      path.join(fixture.tmpRoot, 'globals', pid)
    )
  )
  await fs.mkdir(path.join(fixture.tmpRoot, 'globals', projectId), { recursive: true })
  prjctDb.getDb(projectId)
})

afterEach(async () => {
  prjctDb.close()
  for (const s of spies) s.mockRestore()
  spies.length = 0
  ;(configManager as { clearCache?: () => void }).clearCache?.()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
})

describe('memory_entries dual-write (C1)', () => {
  it('mirrors a remembered entry into memory_entries with typed file + is_machine tags', async () => {
    await projectMemory.remember(fixture.projectRoot, {
      type: 'gotcha',
      content: 'Watch the cache.\nFix: take the max, not the sum.',
      tags: { file: 'core/x.ts', source: 'friction-detector', domain: 'telemetry' },
      projectId,
    })

    const rows = prjctDb.query<{
      id: string
      type: string
      content: string
      file: string | null
    }>(projectId, 'SELECT id, type, content, file FROM memory_entries')
    expect(rows.length).toBe(1)
    expect(rows[0].type).toBe('gotcha')
    expect(rows[0].content).toContain('Watch the cache')
    expect(rows[0].file).toBe('core/x.ts')

    const tags = prjctDb.query<{ key: string; value: string; is_machine: number }>(
      projectId,
      'SELECT key, value, is_machine FROM memory_entry_tags WHERE entry_id = ?',
      rows[0].id
    )
    const byKey = new Map(tags.map((t) => [t.key, t]))
    // `source` is a machine key; `domain` and `file` are authored.
    expect(byKey.get('source')?.is_machine).toBe(1)
    expect(byKey.get('domain')?.is_machine).toBe(0)
    expect(byKey.get('file')?.is_machine).toBe(0)
  })

  it('keeps one v2 row per live memory (parity with the memories mirror)', async () => {
    await projectMemory.remember(fixture.projectRoot, { type: 'decision', content: 'A', projectId })
    await projectMemory.remember(fixture.projectRoot, { type: 'learning', content: 'B', projectId })
    // Verbatim dup is deduped — still one row for A.
    await projectMemory.remember(fixture.projectRoot, { type: 'decision', content: 'A', projectId })

    // memory_entries is the single source; the verbatim dup (A) is deduped.
    const v2Count = prjctDb.query<{ n: number }>(
      projectId,
      'SELECT COUNT(*) AS n FROM memory_entries WHERE deleted_at IS NULL'
    )[0].n
    expect(v2Count).toBe(2)
  })
})
