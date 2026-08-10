/**
 * Regression: prjct must NOT seed legacy write-through stub files
 * (core/*.md, progress/*.md, planning/*.md, memory/patterns.json,
 * config/wizard.json) into the global project folder. Nothing read
 * them back, so they orphaned as garbage with no DB record — the whole
 * point of "all state in SQLite".
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'

const exists = async (p: string): Promise<boolean> =>
  fs
    .stat(p)
    .then(() => true)
    .catch(() => false)

describe('ensureProjectStructure — no orphaned plan files outside prjct', () => {
  const fixture: {
    tmpRoot: string
    prevBaseDir: string
  } = {
    tmpRoot: '',
    prevBaseDir: '',
  }

  const projectId = 'proj-orphan-test'

  beforeAll(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-structure-test-'))
    // path-manager is a singleton; snapshot + restore so we don't leak.
    fixture.prevBaseDir = pathManager.globalBaseDir
    pathManager.setGlobalBaseDir(fixture.tmpRoot)
    await pathManager.ensureProjectStructure(projectId)
  })

  afterAll(async () => {
    pathManager.setGlobalBaseDir(fixture.prevBaseDir)
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
  })

  it('does NOT create the legacy plan dirs', async () => {
    const base = pathManager.getGlobalProjectPath(projectId)
    for (const legacy of ['core', 'progress', 'planning']) {
      expect(await exists(path.join(base, legacy))).toBe(false)
    }
  })

  it('still creates the dirs with real consumers', async () => {
    const base = pathManager.getGlobalProjectPath(projectId)
    for (const live of ['analysis', 'memory', 'sessions']) {
      expect(await exists(path.join(base, live))).toBe(true)
    }
  })

  it('writes none of the legacy stub plan files', async () => {
    const base = pathManager.getGlobalProjectPath(projectId)
    for (const orphan of [
      'core/now.md',
      'core/next.md',
      'core/context.md',
      'progress/shipped.md',
      'progress/metrics.md',
      'planning/ideas.md',
      'planning/roadmap.md',
      'planning/architect-session.md',
      'memory/patterns.json',
      'memory/context.jsonl',
      'config/wizard.json',
    ]) {
      expect(await exists(path.join(base, orphan))).toBe(false)
    }
  })
})
