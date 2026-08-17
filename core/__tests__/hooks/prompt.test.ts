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
  buildDeliveryGuidance,
  buildProjectState,
  buildSelectiveGuidance,
  buildTopicalCue,
  classifyDeliveryIntent,
  runPromptHook,
} from '../../hooks/prompt'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { BASE_MEMORY_TYPES } from '../../memory/entries'
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
    // Zero per-turn prescription: the land reminder moved to SessionStart
    // (buildLandCue, once per session) and the loop paragraph is now a
    // cadenced cue — neither ships at turn 0.
    expect(r).not.toContain('Before session end')
    expect(r).not.toContain('Stay on this goal')
    expect(r).not.toContain('on this cycle —')
  })

  it('shows the loop-discipline cue only every LOOP_CUE_INTERVAL turns', async () => {
    await freshProject()
    await stateStorage.startTask(fixture.projectId, {
      id: `t-${Date.now()}`,
      description: 'cadenced loop cue',
      startedAt: new Date().toISOString(),
      sessionId: 's',
      turnCount: 9,
    } as Parameters<typeof stateStorage.startTask>[1])
    const nine = await buildProjectState(fixture.projectPath)
    expect(nine).not.toContain('on this cycle —')

    const task = await stateStorage.getCurrentTask(fixture.projectId)
    expect(task).not.toBeNull()
    await stateStorage.bumpTurnCount(fixture.projectId)
    const ten = await buildProjectState(fixture.projectPath)
    expect(ten).toContain('Turn 10 on this cycle — still advancing the goal?')
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
    // The escalation REPLACES the cadenced cue — not both.
    expect(r).not.toContain('Stay on this goal')
    expect(r).not.toContain('on this cycle — still advancing')
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

  it('emits once, dedupes an unchanged payload, and bumps turns only after emit', async () => {
    await freshProject()
    await stateStorage.startTask(fixture.projectId, {
      id: `t-${Date.now()}`,
      description: 'dedupe prompt state',
      startedAt: new Date().toISOString(),
      sessionId: 's',
    } as Parameters<typeof stateStorage.startTask>[1])

    const invoke = async (): Promise<{ output: string; pending: Array<() => Promise<void>> }> => {
      const chunks: string[] = []
      const pending: Array<() => Promise<void>> = []
      await runPromptHook(fixture.projectPath, {
        input: { prompt: 'continue the current work' },
        sink: (chunk) => chunks.push(chunk),
        detachAfterEmit: (fn) => pending.push(fn),
      })
      return { output: chunks.join(''), pending }
    }

    const first = await invoke()
    expect(first.output).toContain('dedupe prompt state')
    expect((await stateStorage.getCurrentTask(fixture.projectId))?.turnCount ?? 0).toBe(0)
    expect(first.pending).toHaveLength(1)
    await first.pending[0]!()
    expect((await stateStorage.getCurrentTask(fixture.projectId))?.turnCount).toBe(1)

    const second = await invoke()
    expect(second.output).toBe('{}\n')
    // Dedupe suppresses tokens, not accounting: the turn still increments.
    await second.pending[0]!()
    expect((await stateStorage.getCurrentTask(fixture.projectId))?.turnCount).toBe(2)
  })

  it('cold-path afterEmit worker replays the persisted record instead of recomputing', async () => {
    await freshProject()
    await stateStorage.startTask(fixture.projectId, {
      id: `t-${Date.now()}`,
      description: 'cold afterEmit replay',
      startedAt: new Date().toISOString(),
      sessionId: 's',
    } as Parameters<typeof stateStorage.startTask>[1])

    // Parent process: builds + emits, persists the afterEmit record, and (as
    // in cold-entry) does NOT run afterEmit itself — the detached worker does.
    const parentChunks: string[] = []
    await runPromptHook(fixture.projectPath, {
      input: { prompt: 'continue the current work' },
      sink: (chunk) => parentChunks.push(chunk),
      detachAfterEmit: () => {},
    })
    expect(parentChunks.join('')).toContain('cold afterEmit replay')
    expect((await stateStorage.getCurrentTask(fixture.projectId))?.turnCount ?? 0).toBe(0)

    // Detached worker: afterEmitOnly with a FRESH input object — the WeakMap
    // cache is empty in this "process", so the persisted record must be used.
    const workerPending: Array<() => Promise<void>> = []
    await runPromptHook(fixture.projectPath, {
      afterEmitOnly: true,
      input: { prompt: 'continue the current work' },
      sink: () => {},
      detachAfterEmit: (fn) => workerPending.push(fn),
    })
    expect(workerPending).toHaveLength(1)
    await workerPending[0]!()
    expect((await stateStorage.getCurrentTask(fixture.projectId))?.turnCount).toBe(1)
  })

  it('cold-path afterEmit falls back to recompute when the record is stale', async () => {
    await freshProject()
    await stateStorage.startTask(fixture.projectId, {
      id: `t-${Date.now()}`,
      description: 'cold afterEmit fallback',
      startedAt: new Date().toISOString(),
      sessionId: 's',
    } as Parameters<typeof stateStorage.startTask>[1])

    // Emit once so the payload-hash stamp exists, then delete the record file
    // — the worker must still do its accounting via the recompute fallback.
    await runPromptHook(fixture.projectPath, {
      input: { prompt: 'continue the current work' },
      sink: () => {},
      detachAfterEmit: () => {},
    })
    const { DAEMON_PATHS } = await import('../../daemon/protocol')
    const runDir = DAEMON_PATHS.runDir()
    for (const name of await fs.readdir(runDir).catch(() => [] as string[])) {
      if (name.startsWith('prompt-afteremit-')) {
        await fs.rm(path.join(runDir, name), { force: true })
      }
    }

    const workerPending: Array<() => Promise<void>> = []
    await runPromptHook(fixture.projectPath, {
      afterEmitOnly: true,
      input: { prompt: 'continue the current work' },
      sink: () => {},
      detachAfterEmit: (fn) => workerPending.push(fn),
    })
    await workerPending[0]!()
    expect((await stateStorage.getCurrentTask(fixture.projectId))?.turnCount).toBe(1)
  })
})

describe('UserPromptSubmit — topical trap cue', () => {
  function seedMirror(
    id: string,
    type: string,
    content: string,
    tags: Record<string, string> = {}
  ): void {
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
    for (const [key, value] of Object.entries(tags)) {
      prjctDb.run(
        fixture.projectId,
        `INSERT INTO memory_entry_tags (entry_id, key, value, is_machine)
         VALUES (?, ?, ?, 0)`,
        id,
        key,
        value
      )
    }
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

  it('makes example a first-class memory type', () => {
    expect(BASE_MEMORY_TYPES).toContain('example')
  })

  it('classifies explicit PR, review, CI-watch, and merge delivery intents', () => {
    expect(classifyDeliveryIntent('Open a PR for this change')).toBe('pr')
    expect(classifyDeliveryIntent('Address the review feedback')).toBe('review')
    expect(classifyDeliveryIntent('Watch CI until all checks pass')).toBe('ci-watch')
    expect(classifyDeliveryIntent('merge it')).toBe('merge')
    expect(classifyDeliveryIntent('review this local parser implementation')).toBeNull()
  })

  it('provides compact intent-specific delivery guidance', () => {
    const pr = buildDeliveryGuidance('Open a PR for this change')!
    expect(pr).toContain('human outcome')
    expect(pr).toContain('Problem/why first')
    expect(pr).toContain('Bad:')
    expect(pr).toContain('Good:')

    const review = buildDeliveryGuidance('Address the review feedback')!
    expect(review).toContain('original goal/spec')
    expect(review).toContain('--fromCurrent')

    const ci = buildDeliveryGuidance('Watch CI until all checks pass')!
    expect(ci).toContain('repository failure')
    expect(ci).toContain('infrastructure flake')

    const merge = buildDeliveryGuidance('merge it')!
    expect(merge).toContain('required checks')
    expect(merge).toContain('approval')
    for (const guidance of [pr, review, ci, merge]) {
      expect(guidance.length).toBeLessThanOrEqual(420)
    }
  })

  it('selects at most two distinctive guidance entries within 420 chars', async () => {
    await freshProject()
    seedMirror(
      'mem_voice',
      'voice',
      'For websocket compression reports, lead with the user-visible latency result.'
    )
    seedMirror('mem_good', 'example', 'Good: Cut websocket payload size by 70% with compression.', {
      domain: 'websocket',
      polarity: 'good',
    })
    seedMirror(
      'mem_bad',
      'example',
      'Bad: Refactor websocket transport implementation internals.',
      { domain: 'websocket', polarity: 'bad' }
    )

    const result = buildSelectiveGuidance(
      fixture.projectId,
      'Write the websocket compression PR description'
    )
    expect(result).not.toBeNull()
    expect(result!.memoryIds).toHaveLength(2)
    expect(result!.text.length).toBeLessThanOrEqual(420)
    expect(result!.text).toContain('selective guidance')
  })

  it('requires example domain/polarity tags and does not match generic prompts', async () => {
    await freshProject()
    seedMirror('mem_untagged', 'example', 'Good: explain database replication plainly.')
    seedMirror('mem_voice_generic', 'voice', 'Keep reports short and direct.')

    expect(buildSelectiveGuidance(fixture.projectId, 'continue the current work')).toBeNull()
    expect(
      buildSelectiveGuidance(fixture.projectId, 'explain database replication plainly')
    ).toBeNull()
  })

  it('injects delivery scope containment after state and requires separate capture', async () => {
    await freshProject()
    const chunks: string[] = []
    await runPromptHook(fixture.projectPath, {
      input: { prompt: 'Address the PR review feedback and watch CI' },
      sink: (chunk) => chunks.push(chunk),
      detachAfterEmit: () => {},
    })
    const output = chunks.join('')
    expect(output).toContain('delivery guidance')
    expect(output).toContain('original goal')
    expect(output).toContain('--fromCurrent')
    expect(output.indexOf('project state')).toBeLessThan(output.indexOf('delivery guidance'))
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
