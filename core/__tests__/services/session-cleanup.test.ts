/**
 * Session cleanup — runs at Stop hook, archives aged inbox entries,
 * prunes archives + checkpoints, rotates context7 cache.
 *
 * Tests pin: profile resolution, inbox age-out behavior, checkpoint
 * pruning by mtime, no-op behavior on a fresh project.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DAEMON_PATHS } from '../../daemon/protocol'
import pathManager from '../../infrastructure/path-manager'
import { projectMemory } from '../../memory/project-memory'
import {
  recordCleanupReport,
  resolveProfile,
  runSessionCleanup,
} from '../../services/session-cleanup'
import prjctDb from '../../storage/database'

const fixture: {
  tmpRoot: string
  projectId: string
} = {
  tmpRoot: '',
  projectId: '',
}

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)
const originalGetStoragePath = pathManager.getStoragePath.bind(pathManager)

beforeEach(async () => {
  prjctDb.close()
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-cleanup-test-'))
  fixture.projectId = `cleanup-${crypto.randomUUID()}`
  pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
  pathManager.getStoragePath = (id: string, filename: string) =>
    path.join(fixture.tmpRoot, id, 'storage', filename)
})

afterEach(async () => {
  pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
  pathManager.getStoragePath = originalGetStoragePath
  prjctDb.close()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe('resolveProfile', () => {
  it('defaults to standard when env var absent', () => {
    const p = resolveProfile({})
    expect(p.inboxDays).toBe(14)
    expect(p.archivesDays).toBe(90)
    expect(p.checkpointsDays).toBe(30)
  })

  it('switches to conservative when explicitly requested', () => {
    const p = resolveProfile({ PRJCT_CLEANUP_AGGRESSIVENESS: 'conservative' })
    expect(p.inboxDays).toBe(30)
    expect(p.checkpointsDays).toBeNull()
  })

  it('switches to aggressive when explicitly requested', () => {
    const p = resolveProfile({ PRJCT_CLEANUP_AGGRESSIVENESS: 'aggressive' })
    expect(p.inboxDays).toBe(7)
    expect(p.archivesDays).toBe(30)
  })

  it('falls back to standard for unknown values', () => {
    const p = resolveProfile({ PRJCT_CLEANUP_AGGRESSIVENESS: 'turbo' })
    expect(p.inboxDays).toBe(14)
  })
})

describe('runSessionCleanup', () => {
  it('returns a zero report on a fresh project', async () => {
    const r = await runSessionCleanup(fixture.projectId)
    expect(r.inboxArchived).toBe(0)
    expect(r.archivesPruned).toBe(0)
    expect(r.checkpointsRemoved).toBe(0)
    expect(r.stampsRemoved).toBe(0)
  })

  it('sweeps hook stamps older than 24h from the run dir', async () => {
    const runDir = DAEMON_PATHS.runDir()
    await fs.mkdir(runDir, { recursive: true })
    const staleStamp = path.join(runDir, 'prompt-state-staleproj-deadbeef.hash')
    const staleGit = path.join(runDir, 'prompt-git-deadbeef.json')
    const staleAfterEmit = path.join(runDir, 'prompt-afteremit-staleproj-deadbeef.json')
    const staleStop = path.join(runDir, 'stop-heavy-staleproj.stamp')
    const staleKimi = path.join(runDir, 'kimi-session-staleproj-nosession-kimi.pending')
    const staleSessionTurns = path.join(runDir, 'session-turns-staleproj-deadbeef.count')
    const freshStamp = path.join(runDir, 'prompt-state-freshproj-alive.hash')
    const notAStamp = path.join(runDir, 'daemon.pid')
    for (const file of [
      staleStamp,
      staleGit,
      staleAfterEmit,
      staleStop,
      staleKimi,
      staleSessionTurns,
      freshStamp,
      notAStamp,
    ]) {
      await fs.writeFile(file, 'x')
    }
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    for (const file of [
      staleStamp,
      staleGit,
      staleAfterEmit,
      staleStop,
      staleKimi,
      staleSessionTurns,
    ]) {
      await fs.utimes(file, old, old)
    }

    const r = await runSessionCleanup(fixture.projectId)
    expect(r.stampsRemoved).toBe(6)
    const remaining = await fs.readdir(runDir)
    expect(remaining).toContain('prompt-state-freshproj-alive.hash')
    expect(remaining).toContain('daemon.pid')
    expect(remaining).not.toContain('prompt-state-staleproj-deadbeef.hash')
    expect(remaining).not.toContain('kimi-session-staleproj-nosession-kimi.pending')
    expect(remaining).not.toContain('session-turns-staleproj-deadbeef.count')
  })

  it('archives inbox entries older than the threshold', async () => {
    // Insert one stale (>14d ago) and one fresh inbox entry by hand
    // so we don't depend on remembering with custom timestamps.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    prjctDb.run(
      fixture.projectId,
      "INSERT INTO events (type, data, timestamp) VALUES ('memory.remember.inbox', ?, ?)",
      JSON.stringify({ content: 'stale note', tags: {}, provenance: 'declared' }),
      old
    )
    prjctDb.appendEvent(fixture.projectId, 'memory.remember.inbox', {
      content: 'fresh note',
      tags: {},
      provenance: 'declared',
    })

    const r = await runSessionCleanup(fixture.projectId)
    expect(r.inboxArchived).toBe(1)

    // The fresh one is still recallable; the stale one is gone.
    const remaining = projectMemory.recall(fixture.projectId, { types: ['inbox'], limit: 50 })
    expect(remaining.length).toBe(1)
    expect(remaining[0]?.content).toBe('fresh note')
  })

  it('removes checkpoint files older than the threshold', async () => {
    const dir = path.join(pathManager.getGlobalProjectPath(fixture.projectId), 'checkpoints')
    await fs.mkdir(dir, { recursive: true })
    const oldFile = path.join(dir, '2025-01-01T00-00-00--ancient.json')
    const freshFile = path.join(dir, '2026-05-01T00-00-00--fresh.json')
    await fs.writeFile(oldFile, '{}')
    await fs.writeFile(freshFile, '{}')
    // Backdate the old file far past 30d.
    const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    await fs.utimes(oldFile, oldTime, oldTime)

    const r = await runSessionCleanup(fixture.projectId)
    expect(r.checkpointsRemoved).toBe(1)
    const remaining = await fs.readdir(dir)
    expect(remaining).toEqual(['2026-05-01T00-00-00--fresh.json'])
  })

  it('skips checkpoint pruning when profile says null', async () => {
    process.env.PRJCT_CLEANUP_AGGRESSIVENESS = 'conservative'
    const dir = path.join(pathManager.getGlobalProjectPath(fixture.projectId), 'checkpoints')
    await fs.mkdir(dir, { recursive: true })
    const oldFile = path.join(dir, 'ancient.json')
    await fs.writeFile(oldFile, '{}')
    const oldTime = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    await fs.utimes(oldFile, oldTime, oldTime)

    const r = await runSessionCleanup(fixture.projectId)
    expect(r.checkpointsRemoved).toBe(0)
    const remaining = await fs.readdir(dir)
    expect(remaining).toEqual(['ancient.json'])
    process.env.PRJCT_CLEANUP_AGGRESSIVENESS = ''
  })
})

describe('recordCleanupReport', () => {
  it('skips persisting when nothing was cleaned', async () => {
    await recordCleanupReport(fixture.projectId, {
      inboxArchived: 0,
      archivesPruned: 0,
      checkpointsRemoved: 0,
      context7CacheRotated: false,
      stampsRemoved: 0,
    })
    const events = prjctDb.query<{ type: string }>(
      fixture.projectId,
      "SELECT type FROM events WHERE type LIKE 'memory.remember.system-event'"
    )
    expect(events.length).toBe(0)
  })

  it('persists a system-event entry when something was cleaned', async () => {
    await recordCleanupReport(fixture.projectId, {
      inboxArchived: 3,
      archivesPruned: 1,
      checkpointsRemoved: 0,
      context7CacheRotated: false,
      stampsRemoved: 0,
    })
    const events = prjctDb.query<{ type: string; data: string }>(
      fixture.projectId,
      "SELECT type, data FROM events WHERE type = 'memory.remember.system-event'"
    )
    expect(events.length).toBe(1)
    const data = JSON.parse(events[0]!.data) as { content: string }
    expect(data.content).toContain('3 inbox archived')
    expect(data.content).toContain('1 archives pruned')
  })
})
