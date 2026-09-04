/**
 * UserPromptSubmit delta emission for non-caching hosts (Kimi/Codex).
 *
 * These hosts re-pay every injected byte on every API call, so the state
 * block re-emits only on MATERIAL change; per-edit count noise dedupes.
 * Claude keeps the whole-payload path byte-identical — its Anthropic prompt
 * cache wants stable prefixes, not suppression.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DAEMON_PATHS } from '../../daemon/protocol'
import { indexProject } from '../../domain/bm25'
import type { HookHost } from '../../hooks/_shared'
import {
  _resetGitSnapshotCacheForTests,
  packRequiredPromptSection,
  runPromptHook,
} from '../../hooks/prompt'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { PRIVATE_SKILL_ASSET_ROOT } from '../../services/private-skill-router'
import { persistProjectStyleSnapshot } from '../../services/project-style-evolution'
import { buildProjectStyleSnapshot } from '../../services/project-style-profile'
import prjctDb from '../../storage/database'
import { stateStorage } from '../../storage/state-storage'
import { execFileAsync } from '../../utils/exec'

const fixture: { projectPath: string; projectId: string } = { projectPath: '', projectId: '' }

it('reserves prompt budget for required private guidance before optional state', () => {
  const required =
    'Private guidance (auto; read on demand): workflow:diagnosing-bugs=`/pkg/diagnose.md`'
  const packed = packRequiredPromptSection('state '.repeat(160), required, 300)
  expect(packed.length).toBeLessThanOrEqual(300)
  expect(packed).toContain(required)
  expect(packed).not.toContain('state')
})

async function git(args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: fixture.projectPath })
}

async function freshProject(): Promise<void> {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-prompt-delta-test-'))
  fixture.projectId = `prompt-delta-${crypto.randomUUID()}`
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.email', 't@example.com'])
  await git(['config', 'user.name', 'Tester'])
  await git(['config', 'commit.gpgsign', 'false'])
  await fs.writeFile(path.join(fixture.projectPath, 'app.ts'), 'export const app = 1\n')
  await git(['add', '.'])
  await git(['commit', '-q', '-m', 'seed'])
  await stateStorage.startTask(fixture.projectId, {
    id: 'delta-task',
    description: 'improve api error handling',
    startedAt: new Date().toISOString(),
    sessionId: 'delta-session',
  } as Parameters<typeof stateStorage.startTask>[1])
}

beforeEach(async () => {
  prjctDb.close()
  _resetGitSnapshotCacheForTests()
  await freshProject()
})

afterEach(async () => {
  await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  prjctDb.close()
})

/** Run one prompt through the hook and return the model-visible content. */
async function runTurn(
  host: HookHost,
  prompt: string,
  sessionId = 'delta-session'
): Promise<string> {
  _resetGitSnapshotCacheForTests()
  const captured: string[] = []
  const afterEmits: Array<() => Promise<void>> = []
  await runPromptHook(fixture.projectPath, {
    input: { prompt, session_id: sessionId },
    hookHost: host,
    sink: (chunk) => captured.push(chunk),
    detachAfterEmit: (fn) => afterEmits.push(fn),
  })
  for (const fn of afterEmits) await fn().catch(() => undefined)
  const line = captured.join('').trim()
  if (!line || line === '{}') return ''
  if (!line.startsWith('{')) return line
  const parsed = JSON.parse(line) as {
    additional_context?: string
    hookSpecificOutput?: { additionalContext?: string; additional_context?: string }
    systemMessage?: string
  }
  return (
    parsed.hookSpecificOutput?.additionalContext ??
    parsed.hookSpecificOutput?.additional_context ??
    parsed.additional_context ??
    parsed.systemMessage ??
    ''
  )
}

describe('prompt guidance and delta emission across hook hosts', () => {
  for (const host of ['claude', 'gemini', 'codex', 'cursor', 'kimi'] as const) {
    it(`enforces repository alignment for an unclassified turn on ${host}`, async () => {
      const first = await runTurn(host, 'continue')

      expect(first).toContain('# prjct: repository alignment (MUST before edit)')
      expect(first).toContain('Reuse existing abstractions and patterns')
      expect(first).toContain('No indexed hit')
    })
  }

  it('requires source discovery for code work when indexes are cold', async () => {
    const first = await runTurn('codex', 'Fix a regression in the app')

    expect(first).toContain('diagnosing-bugs.md')
    expect(first).toContain('# prjct: repository alignment (MUST before edit)')
    expect(first).toContain('No indexed hit')
    expect(first).toContain('prjct_relevant_files')
  })

  it('keeps repository alignment beside an auto-routed private workflow', async () => {
    await indexProject(fixture.projectPath, fixture.projectId)

    const first = await runTurn('codex', 'Diagnose a flaky regression in the app')

    expect(first).toContain('diagnosing-bugs.md')
    expect(first).toContain('# prjct: repository alignment (MUST before edit)')
    expect(first).toContain('Reuse existing abstractions and patterns')
    expect(first).toContain('Do not duplicate logic inline')
    expect(first).toContain('app.ts')
    expect(first.length).toBeLessThanOrEqual(700)
  })

  it('injects only task-relevant synced patterns with canonical evidence', async () => {
    const snapshot = buildProjectStyleSnapshot({
      stats: {
        fileCount: 1,
        version: '1.0.0',
        name: 'prompt-pattern-test',
        ecosystem: 'JavaScript',
        projectType: 'simple',
        languages: ['TypeScript'],
        frameworks: [],
      },
      stack: {
        hasFrontend: false,
        hasBackend: true,
        hasDatabase: false,
        hasDocker: false,
        hasTesting: true,
        frontendType: null,
        frameworks: [],
      },
    })
    snapshot.payload.patterns = [
      {
        key: 'result-boundary',
        name: 'Result boundary',
        description: 'API commands return CommandResult and delegate error normalization.',
        locations: ['app.ts'],
        category: 'error-handling',
      },
      {
        key: 'unrelated-ui',
        name: 'UI composition',
        description: 'Compose visual panels from view components.',
        locations: ['src/components'],
        category: 'frontend',
      },
    ]
    snapshot.patternCount = snapshot.payload.patterns.length
    persistProjectStyleSnapshot(fixture.projectId, snapshot)

    const first = await runTurn('codex', 'continue')

    expect(first).toContain('Synced patterns relevant to this task')
    expect(first).toContain('Result boundary')
    expect(first).toContain('app.ts')
    expect(first).not.toContain('UI composition')
    expect(first.length).toBeLessThanOrEqual(700)

    const nextMessage = await runTurn('codex', 'Now adjust the visual component composition')
    expect(nextMessage).not.toContain('# prjct: repository alignment')
    expect(nextMessage).not.toContain('Synced patterns relevant to this task')
    expect(nextMessage).not.toContain('UI composition')

    const updated = structuredClone(snapshot)
    updated.id = `${snapshot.id}-updated`
    updated.capturedAt = '2026-08-27T06:00:00.000Z'
    updated.payload.patterns[0]!.description =
      'UPDATED: API commands return CommandResult through the shared boundary.'
    persistProjectStyleSnapshot(fixture.projectId, updated)

    const afterSyncChange = await runTurn('codex', 'continue')
    expect(afterSyncChange).toContain('UPDATED: API commands return CommandResult')
  })

  it('re-emits whole state omitted for required guidance instead of stamping it delivered', async () => {
    await stateStorage.completeTask(fixture.projectId)
    // Prime session-start context so the routed turn uses the normal 700-char budget.
    await runTurn('codex', 'status')
    await stateStorage.startTask(fixture.projectId, {
      id: 'large-state-task',
      description: `large cycle ${'scope '.repeat(75)}TAIL_SENTINEL`,
      startedAt: new Date().toISOString(),
      sessionId: 'delta-session',
    } as Parameters<typeof stateStorage.startTask>[1])

    const first = await runTurn('codex', 'Diagnose a flaky regression')
    expect(first).toContain('diagnosing-bugs.md')
    expect(first).not.toContain('large cycle')

    const second = await runTurn('codex', 'continue')
    expect(second).toContain('large cycle')
    expect(second).toContain('TAIL_SENTINEL')
  })

  it('packs an auto-route as one exact-path section and dedupes it by session', async () => {
    await stateStorage.completeTask(fixture.projectId)
    await stateStorage.startTask(fixture.projectId, {
      id: 'route-budget-task',
      description: `route budget ${'scope '.repeat(75)}TAIL_SENTINEL`,
      startedAt: new Date().toISOString(),
      sessionId: 'delta-session',
    } as Parameters<typeof stateStorage.startTask>[1])
    const prompt = 'Diagnose a flaky regression in AGENTS.md'
    const first = await runTurn('codex', prompt)
    expect(first).toContain(path.join(PRIVATE_SKILL_ASSET_ROOT, 'diagnosing-bugs.md'))
    expect(first).toContain(path.join(PRIVATE_SKILL_ASSET_ROOT, 'writing-for-agents.md'))
    expect(first).not.toContain('Output: standard')
    expect(first).not.toContain('TAIL_SENTINEL')

    const followUp = await runTurn('codex', 'continue')
    expect(followUp).toContain('# prjct: project state')
    expect(followUp).toContain('TAIL_SENTINEL')
    expect(followUp).not.toContain('# prjct: repository alignment (MUST before edit)')
    expect(await runTurn('codex', 'continue')).toBe('')
    expect(await runTurn('codex', prompt)).toBe('')
  })

  it('turn 2 with only count-noise changes emits nothing', async () => {
    // Dirty BEFORE turn 1 — the clean→dirty transition is material by design;
    // this test pins that dirty→more-dirty (count noise) is NOT.
    await fs.appendFile(path.join(fixture.projectPath, 'app.ts'), '// warm\n')
    const first = await runTurn('kimi', 'continue')
    expect(first).toContain('# prjct: project state')
    expect(first).not.toContain('Output: compact')

    await fs.appendFile(path.join(fixture.projectPath, 'app.ts'), '// edit\n')
    await fs.writeFile(path.join(fixture.projectPath, 'extra.ts'), 'export {}\n')
    const second = await runTurn('kimi', 'continue')
    expect(second).toBe('')
  })

  it('a branch switch is material and re-emits the full state', async () => {
    await runTurn('codex', 'continue')
    await git(['checkout', '-q', '-b', 'feat/delta'])
    const afterBranch = await runTurn('codex', 'continue')
    expect(afterBranch).toContain('# prjct: project state')
    expect(afterBranch).toContain('feat/delta')
  })

  it('suppressed turns keep the whole-payload stamp in sync for the cold-path worker', async () => {
    await fs.appendFile(path.join(fixture.projectPath, 'app.ts'), '// warm\n')
    await runTurn('kimi', 'continue')
    await runTurn('kimi', 'continue') // suppressed — emits nothing

    // readPersistedPromptAfterEmit validates the persisted record's hash
    // against the prompt-state stamp; both must describe the EMITTED payload
    // ('' on a suppressed turn) or every cold afterEmit rebuilds from scratch.
    const cwd = createHash('sha1')
      .update(path.resolve(fixture.projectPath))
      .digest('hex')
      .slice(0, 12)
    const key = `${fixture.projectId.replace(/[^a-zA-Z0-9._-]/g, '_')}-${cwd}`
    const runDir = DAEMON_PATHS.runDir()
    const stamp = (await fs.readFile(path.join(runDir, `prompt-state-${key}.hash`), 'utf-8')).trim()
    const persisted = JSON.parse(
      await fs.readFile(path.join(runDir, `prompt-afteremit-${key}.json`), 'utf-8')
    ) as { hash?: string; record?: { surfacedIds?: string[]; guidanceRuleId?: string | null } }
    expect(persisted.hash).toBe(stamp)
    expect(stamp).toBe(createHash('sha256').update('').digest('hex'))
    // A turn that surfaced nothing must not credit memories as surfaced.
    expect(persisted.record?.surfacedIds).toEqual([])
    expect(persisted.record?.guidanceRuleId).toBeNull()
  })

  it('a fresh session re-emits the full state (new stamp scope)', async () => {
    await runTurn('kimi', 'continue')
    _resetGitSnapshotCacheForTests()
    const captured: string[] = []
    await runPromptHook(fixture.projectPath, {
      input: { prompt: 'continue', session_id: 'delta-session-2' },
      hookHost: 'kimi',
      sink: (chunk) => captured.push(chunk),
      detachAfterEmit: () => undefined,
    })
    expect(captured.join('')).toContain('# prjct: project state')
  })

  it('emits stable rollover thresholds once without per-turn prompt churn', async () => {
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
      maxTurnsPerSession: 5,
    } as Parameters<typeof configManager.writeConfig>[1])
    const sessionId = `rollover-${crypto.randomUUID()}`

    await runTurn('codex', 'continue', sessionId)
    await runTurn('codex', 'continue', sessionId)
    await runTurn('codex', 'continue', sessionId)
    const warning = await runTurn('codex', 'continue', sessionId)
    const stopped = await runTurn('codex', 'continue', sessionId)
    const unchanged = await runTurn('codex', 'continue', sessionId)

    expect(warning).toContain('session rollover approaching')
    expect(warning).toContain('80%')
    expect(stopped).toContain('SESSION ROLLOVER REQUIRED')
    expect(unchanged).not.toContain('SESSION ROLLOVER REQUIRED')
  })
})

describe('claude parity (whole-payload path untouched)', () => {
  it('claude still emits the full state block when the payload changes', async () => {
    const first = await runTurn('claude', 'continue')
    expect(first).toContain('# prjct: project state')

    // Count noise changes the payload hash → claude re-emits the FULL block
    // (whole-payload dedup, not delta) — deliberate for its prompt cache.
    await fs.appendFile(path.join(fixture.projectPath, 'app.ts'), '// edit\n')
    const second = await runTurn('claude', 'continue')
    expect(second).toContain('# prjct: project state')
    expect(second).toContain('working tree')
  })
})
