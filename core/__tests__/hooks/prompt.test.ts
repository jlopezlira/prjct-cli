/**
 * UserPromptSubmit hook — project state injection.
 *
 * The state block is the LLM's per-turn anchor for intent
 * disambiguation. These tests pin the contract:
 *   1. No project config → null (no injection).
 *   2. With a fresh project → at least one fact emitted.
 *   3. Active work → surfaces work description + relative time.
 *   4. Git working tree → surfaces branch + dirty/clean state.
 *   5. Inbox entries → surfaces count.
 *   6. Empty repo (no HEAD) doesn't break the hook.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { indexProject } from '../../domain/bm25'
import {
  _resetGitSnapshotCacheForTests,
  buildProjectState,
  buildTopicalCue,
} from '../../hooks/prompt'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { buildIndexedFileCue } from '../../services/file-cue'
import prjctDb from '../../storage/database'
import { stateStorage } from '../../storage/state-storage'
import { execFileAsync } from '../../utils/exec'

const fixture: {
  projectPath: string
  projectId: string
} = {
  projectPath: '',
  projectId: '',
}

async function freshProject(): Promise<void> {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-prompt-state-test-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `prompt-state-${crypto.randomUUID()}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)

  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: fixture.projectPath })
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], {
    cwd: fixture.projectPath,
  })
  await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: fixture.projectPath })
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: fixture.projectPath })
}

beforeEach(async () => {
  prjctDb.close()
  _resetGitSnapshotCacheForTests()
})

afterEach(async () => {
  if (fixture.projectPath) {
    await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  }
  prjctDb.close()
})

describe('UserPromptSubmit — project state', () => {
  it('returns null when there is no prjct config', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-prompt-noconfig-'))
    const r = await buildProjectState(dir)
    expect(r).toBeNull()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('emits a state block with branch + working tree info on a fresh repo', async () => {
    await freshProject()
    const r = await buildProjectState(fixture.projectPath)
    expect(r).not.toBeNull()
    expect(r).toContain('# prjct: project state')
    // Fresh repo always has exactly one untracked entry (.prjct/) — the
    // "clean" wording no longer exists (suppressed as token noise), so
    // pin the only branch this regex can take.
    expect(r).toMatch(/Branch: main — working tree \d+ untracked/)
  })

  it('surfaces an active work cycle when one exists', async () => {
    await freshProject()
    await stateStorage.startTask(fixture.projectId, {
      id: `t-${Date.now()}`,
      description: 'fix auth race condition',
      startedAt: new Date().toISOString(),
      sessionId: 's',
    } as Parameters<typeof stateStorage.startTask>[1])
    const r = await buildProjectState(fixture.projectPath)
    expect(r).toContain('Active work cycle: "fix auth race condition"')
    // Goal discipline injected with the cycle — keeps a weaker rig on the goal
    // and out of loops (the agentic capability the harness gives the model).
    expect(r).toContain('Stay on this goal')
    expect(r).toContain('Do not loop')
  })

  it('escalates from goal-discipline to stop-looping once a cycle grinds past the threshold', async () => {
    await freshProject()
    await stateStorage.startTask(fixture.projectId, {
      id: `t-${Date.now()}`,
      description: 'refactor the parser',
      startedAt: new Date().toISOString(),
      sessionId: 's',
      turnCount: 20, // already well past STUCK_TURN_THRESHOLD
    } as Parameters<typeof stateStorage.startTask>[1])
    const r = await buildProjectState(fixture.projectPath)
    expect(r).toContain('turns on this cycle')
    expect(r).toContain('STOP looping')
    // The escalation REPLACES the calm discipline line — not both.
    expect(r).not.toContain('Stay on this goal')
  })

  it('bumpTurnCount increments the active cycle from zero', async () => {
    await freshProject()
    await stateStorage.startTask(fixture.projectId, {
      id: `t-${Date.now()}`,
      description: 'first cycle',
      startedAt: new Date().toISOString(),
      sessionId: 's',
    } as Parameters<typeof stateStorage.startTask>[1])
    expect((await stateStorage.bumpTurnCount(fixture.projectId)).count).toBe(1)
    expect((await stateStorage.bumpTurnCount(fixture.projectId)).count).toBe(2)
    const third = await stateStorage.bumpTurnCount(fixture.projectId)
    expect(third.count).toBe(3)
    expect(third.task?.turnCount).toBe(3)
  })

  it('surfaces dirty working tree counts', async () => {
    await freshProject()
    await fs.writeFile(path.join(fixture.projectPath, 'a.txt'), 'hi')
    const r = await buildProjectState(fixture.projectPath)
    expect(r).toMatch(/working tree.*untracked/)
  })

  it('surfaces inbox count when entries exist', async () => {
    await freshProject()
    // Write inbox entries directly via the events table (memoryService.log
    // would require a project-id round-trip we already handled in the
    // freshProject() init).
    for (const i of Array.from({ length: 3 }, (_, index) => index)) {
      prjctDb.appendEvent(fixture.projectId, 'memory.remember.inbox', {
        content: `note ${i}`,
        tags: {},
        provenance: 'declared',
      })
    }
    const r = await buildProjectState(fixture.projectPath)
    expect(r).toContain('Inbox: 3 items pending')
  })

  it('does not throw on an empty repo with no HEAD', async () => {
    await freshProject()
    // No commits yet — captureGit's `git rev-list @{u}..HEAD` will fail.
    const r = await buildProjectState(fixture.projectPath)
    expect(r).not.toBeNull()
    expect(r).toContain('# prjct: project state')
  })

  it('serves the git snapshot from a short TTL cache within a burst', async () => {
    await freshProject()
    // Fresh repo has exactly one untracked entry (.prjct/).
    const first = await buildProjectState(fixture.projectPath)
    expect(first).toMatch(/working tree 1 untracked/)

    // Mutate git state. Within the TTL the hook must NOT re-fork git —
    // the line stays the cached snapshot (agentic-burst behavior).
    await fs.writeFile(path.join(fixture.projectPath, 'b.txt'), 'hi')
    const cached = await buildProjectState(fixture.projectPath)
    expect(cached).toMatch(/working tree 1 untracked/)

    // After the cache resets (TTL expiry stand-in) the change is seen.
    _resetGitSnapshotCacheForTests()
    const fresh = await buildProjectState(fixture.projectPath)
    expect(fresh).toMatch(/working tree 2 untracked/)
  })
})

describe('UserPromptSubmit — topical trap cue', () => {
  function seedMirror(id: string, type: string, content: string): void {
    // Single-source: searchFts/recall read memory_entries (FTS trigger indexes).
    const createdMs = Date.now()
    prjctDb.run(
      fixture.projectId,
      `INSERT OR REPLACE INTO memory_entries
         (id, project_id, type, title, content, provenance, content_hash,
          user_triggered, revision_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'declared', ?, 0, 0, ?, ?)`,
      id,
      fixture.projectId,
      type,
      content.slice(0, 80),
      content,
      `hash_${id}`,
      createdMs,
      createdMs
    )
  }

  it('surfaces ONE gotcha when prompt keywords match', async () => {
    await freshProject()
    seedMirror('mem_1', 'gotcha', 'the daemon caches stale hook code until restarted')
    seedMirror('mem_2', 'gotcha', 'embeddings clear also wipes the keychain key')
    const cue = buildTopicalCue(fixture.projectId, 'why is the daemon serving stale responses?')
    expect(cue).not.toBeNull()
    // Terminal tip channel: gotcha is SoT — agent must relay to user in chat.
    expect(cue).toContain('Tip→user (SoT)')
    expect(cue).toContain('mem_1')
    expect(cue).not.toContain('mem_2')
  })

  it('ignores non-tip types even when they match', async () => {
    await freshProject()
    // learning is not SoT/suggest in topical cue ranking — only decision/gotcha/fact
    // and pattern/anti-pattern surface as tip→user.
    seedMirror('mem_3', 'learning', 'we chose a daemon architecture for warm starts')
    const cue = buildTopicalCue(fixture.projectId, 'tell me about the daemon architecture')
    expect(cue).toBeNull()
  })

  it('returns null when nothing matches', async () => {
    await freshProject()
    seedMirror('mem_4', 'gotcha', 'biome resolves zero files inside a git worktree')
    const cue = buildTopicalCue(fixture.projectId, 'completely unrelated cooking recipe question')
    expect(cue).toBeNull()
  })
})

describe('UserPromptSubmit — indexed file cue', () => {
  it('returns null before the project has a file index', async () => {
    await freshProject()
    const cue = buildIndexedFileCue(fixture.projectId, 'map headless API endpoints')
    expect(cue).toBeNull()
  })

  it('surfaces likely files from the sync-built BM25 index', async () => {
    await freshProject()
    await fs.mkdir(path.join(fixture.projectPath, 'core', 'server'), { recursive: true })
    await fs.mkdir(path.join(fixture.projectPath, 'core', 'hooks'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.projectPath, 'core', 'server', 'headless-api.ts'),
      'export function mapHeadlessApiEndpoints() { return [] }'
    )
    await fs.writeFile(
      path.join(fixture.projectPath, 'core', 'hooks', 'prompt.ts'),
      'export function promptHook() { return null }'
    )

    await indexProject(fixture.projectPath, fixture.projectId)

    const cue = buildIndexedFileCue(fixture.projectId, 'map headless API endpoints')
    expect(cue).not.toBeNull()
    expect(cue).toContain('Work scope')
    expect(cue).toContain('Grep/Glob')
    expect(cue).toContain('core/server/headless-api.ts')
    expect(cue).toContain('bm25')
  })
})
