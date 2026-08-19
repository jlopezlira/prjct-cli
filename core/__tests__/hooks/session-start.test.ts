/**
 * SessionStart hook — context injection invariants.
 *
 * The hook output is reused by SubagentStart and CwdChanged, both of
 * which can fire mid-session. Lock down the cache-stability contract:
 * the body is **bytes-identical given the same persona**, no
 * memory-dependent variation. Earlier versions interpolated the last
 * 5 memory entries into the body, which busted Anthropic's prompt
 * cache every time the user captured/remembered/shipped between
 * sessions or cd'd between projects (~150–400 tokens of prefix
 * change → full system-prompt re-tokenization).
 *
 * Locked invariants:
 *   1. No projectId in config → returns null (skip injection).
 *   2. With projectId → always emit cwd project identity (L1; skill is
 *      portable L0 and must not carry project stamp).
 *   3. Persona present → injects persona section verbatim.
 *   4. Output is "describe state" — never "do this".
 *   5. Output bytes do NOT depend on memory state (cache stability).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildSessionContext } from '../../hooks/session-start'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import prjctDb from '../../storage/database'

const fixture: {
  projectPath: string
  projectId: string
} = {
  projectPath: '',
  projectId: '',
}

async function freshProject(persona?: Record<string, unknown>): Promise<void> {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-session-start-test-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `test-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
    ...(persona ? { persona } : {}),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
}

function insertMemory(type: string, content: string): void {
  prjctDb.run(
    fixture.projectId,
    "INSERT INTO events (type, data, timestamp) VALUES (?, ?, datetime('now'))",
    `memory.remember.${type}`,
    JSON.stringify({ content, tags: {}, provenance: 'declared' })
  )
}

afterEach(async () => {
  if (fixture.projectPath) {
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
    fixture.projectPath = ''
  }
})

describe('SessionStart hook — buildSessionContext', () => {
  test('returns null when config has no projectId', async () => {
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-no-id-'))
    await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.projectPath, '.prjct', 'prjct.config.json'),
      JSON.stringify({ dataPath: '' })
    )
    const ctx = await buildSessionContext(fixture.projectPath)
    expect(ctx).toBeNull()
  })

  test('emits cwd project identity even without persona (L1 isolation)', async () => {
    await freshProject()
    const ctx = await buildSessionContext(fixture.projectPath)
    expect(ctx).not.toBeNull()
    expect(ctx).toContain('## Project identity (cwd)')
    expect(ctx).toContain('Skill is portable L0')
    expect(ctx).not.toContain('Your role in this project')
  })

  test('without persona still omits memory content (cache stability)', async () => {
    // Prior versions injected a "Recent memory" section in this case.
    // That broke cache stability; UserPromptSubmit handles per-turn recall.
    await freshProject()
    insertMemory('decision', 'we picked SQLite for local-first')
    const ctx = await buildSessionContext(fixture.projectPath)
    expect(ctx).not.toBeNull()
    expect(ctx).toContain('## Project identity (cwd)')
    expect(ctx).not.toContain('SQLite for local-first')
    expect(ctx).not.toContain('## Recent memory')
  })

  test('injects persona block with role/focus/MCPs/packs', async () => {
    await freshProject({
      role: 'PM',
      focus: 'B2B onboarding',
      mcps: ['linear', 'posthog'],
      packs: ['pm', 'daily'],
    })
    const ctx = await buildSessionContext(fixture.projectPath)
    expect(ctx).not.toBeNull()
    expect(ctx).toContain('# prjct: project context')
    expect(ctx).toContain('## Project identity (cwd)')
    expect(ctx).toContain('Your role in this project: **PM**')
    expect(ctx).toContain('Focus: B2B onboarding')
    expect(ctx).toContain('Available MCPs this project expects: linear, posthog')
    expect(ctx).toContain('Active packs: pm, daily')
  })

  test('always emits the "state, not prescription" disclaimer', async () => {
    await freshProject({ role: 'DEV' })
    const ctx = await buildSessionContext(fixture.projectPath)
    expect(ctx).toContain('Exposed as state, not prescription')
  })

  test('does NOT repeat the recall verbs (they live in the skill — token diet R5)', async () => {
    await freshProject({ role: 'DEV' })
    const ctx = await buildSessionContext(fixture.projectPath)
    expect(ctx).not.toContain('prjct context memory')
  })

  test('NEVER includes memory entry content (cache-stability invariant)', async () => {
    await freshProject({ role: 'DEV' })
    insertMemory('decision', 'we picked SQLite for local-first')
    insertMemory('learning', 'JWT iat detects replay')
    const ctx = await buildSessionContext(fixture.projectPath)
    expect(ctx).not.toBeNull()
    expect(ctx).not.toContain('## Recent memory')
    expect(ctx).not.toContain('SQLite for local-first')
    expect(ctx).not.toContain('JWT iat detects replay')
    expect(ctx).not.toContain('### DECISION')
    expect(ctx).not.toContain('### LEARNING')
  })

  test('output is bytes-identical regardless of memory state (cache stability)', async () => {
    await freshProject({ role: 'DEV', focus: 'platform' })
    const before = await buildSessionContext(fixture.projectPath)

    // Add a bunch of memory entries — none should leak into the output.
    for (const i of Array.from({ length: 10 }, (_, index) => index)) {
      insertMemory('decision', `entry ${i}: ${'x'.repeat(50)}`)
    }
    const after = await buildSessionContext(fixture.projectPath)

    expect(after).toBe(before)
  })
})

describe('SessionStart hook — knowledge digest (cold-start only)', () => {
  test('digest OFF by default — the cache-safe path used by subagent/cwd reuse', async () => {
    await freshProject({ role: 'DEV' })
    insertMemory('gotcha', 'stale daemon caches old hook code; stop it before testing')
    const ctx = await buildSessionContext(fixture.projectPath)
    expect(ctx).not.toBeNull()
    expect(ctx).not.toContain('What this project already knows')
    expect(ctx).not.toContain('stale daemon')
  })

  test('digest ON surfaces top traps + decisions (cross-update grounding)', async () => {
    await freshProject({ role: 'DEV' })
    insertMemory('gotcha', 'stale daemon caches old hook code; stop it before testing')
    insertMemory('decision', 'we picked SQLite for local-first persistence')
    const ctx = await buildSessionContext(fixture.projectPath, null, { digest: true })
    expect(ctx).not.toBeNull()
    expect(ctx).toContain('What this project already knows')
    expect(ctx).toContain('Traps to avoid')
    expect(ctx).toContain('Decisions in force')
    expect(ctx).toContain('survived even if your conversation context did not')
  })

  test('digest ON works even without a persona (knowledge alone is enough)', async () => {
    await freshProject()
    insertMemory('gotcha', 'never edit the generated vault by hand — fix the pipeline')
    const ctx = await buildSessionContext(fixture.projectPath, null, { digest: true })
    expect(ctx).not.toBeNull()
    expect(ctx).toContain('What this project already knows')
  })

  test('digest ON with no memory and no persona → identity only (no digest noise)', async () => {
    await freshProject()
    const ctx = await buildSessionContext(fixture.projectPath, null, { digest: true })
    expect(ctx).not.toBeNull()
    expect(ctx).toContain('## Project identity (cwd)')
    expect(ctx).not.toContain('What this project already knows')
  })

  test('digest surfaces an entry skill-missed ≥2× (feedback loop read side)', async () => {
    await freshProject({ role: 'DEV' })
    insertMemory('learning', 'embeddings clear deletes the keychain key — use set to keep it')
    const row = prjctDb.get<{ id: number }>(fixture.projectId, 'SELECT MAX(id) AS id FROM events')
    const memId = `mem_${row?.id}`
    for (const i of Array.from({ length: 2 }, (_, index) => index)) {
      prjctDb.run(
        fixture.projectId,
        "INSERT INTO events (type, data, timestamp) VALUES (?, ?, datetime('now'))",
        'memory.remember.improvement-signal',
        JSON.stringify({
          content: `[skill-miss] Unused project knowledge (learning, ${memId})`,
          tags: {
            kind: 'skill-miss',
            source: 'skill-miss-detector',
            relates: memId,
            key: `k${i}`,
          },
          provenance: 'extracted',
        })
      )
    }
    const ctx = await buildSessionContext(fixture.projectPath, null, { digest: true })
    expect(ctx).toContain('Keeps being missed')
    expect(ctx).toContain(memId)
    expect(ctx).toContain('2×')
  })

  test('a single skill-miss does NOT earn a digest slot (threshold is 2)', async () => {
    await freshProject({ role: 'DEV' })
    insertMemory('learning', 'embeddings clear deletes the keychain key — use set to keep it')
    const row = prjctDb.get<{ id: number }>(fixture.projectId, 'SELECT MAX(id) AS id FROM events')
    prjctDb.run(
      fixture.projectId,
      "INSERT INTO events (type, data, timestamp) VALUES (?, ?, datetime('now'))",
      'memory.remember.improvement-signal',
      JSON.stringify({
        content: '[skill-miss] Unused project knowledge',
        tags: {
          kind: 'skill-miss',
          source: 'skill-miss-detector',
          relates: `mem_${row?.id}`,
          key: 'k0',
        },
        provenance: 'extracted',
      })
    )
    const ctx = await buildSessionContext(fixture.projectPath, null, { digest: true })
    expect(ctx ?? '').not.toContain('Keeps being missed')
  })

  test('digest references prjct_developer and id-resolution path', async () => {
    await freshProject({ role: 'DEV' })
    insertMemory('decision', 'ship as minor when the squash title starts with feat:')
    const ctx = await buildSessionContext(fixture.projectPath, null, { digest: true })
    expect(ctx).toContain('prjct_developer')
    expect(ctx).toContain('prjct search')
  })

  test('digest pushes developer rules so cold-start acts as the developer', async () => {
    await freshProject({ role: 'DEV' })
    insertMemory(
      'feedback',
      'Memory content MUST be authored in English, regardless of conversation language.'
    )
    const ctx = await buildSessionContext(fixture.projectPath, null, { digest: true })
    expect(ctx).not.toBeNull()
    expect(ctx).toContain('How this developer works')
    expect(ctx).toContain('English')
    expect(ctx).toContain('prjct_developer')
  })
})

describe('SessionStart hook — digest slots are proven-first (usefulness rerank)', () => {
  test('a proven-useful old gotcha beats a newer unproven one for a digest slot', async () => {
    await freshProject({ role: 'DEV' })
    // 5 gotchas, oldest first. Pure recency would pick g4,g3 (2 diet slots).
    // The rerank BOOST caps the climb at 4 slots, so the proven oldest can
    // reach slot 2 from position 5 — the invariant under the pull-first diet.
    for (const i of Array.from({ length: 5 }, (_, index) => index))
      insertMemory('gotcha', `trap number ${i} in module-${i}`)

    // The OLDEST entry is the only one with usefulness signal — it should
    // climb into the 3 digest slots, displacing the 3rd-newest.
    const { usefulnessService } = await import('../../services/usefulness')
    const oldest = prjctDb.query<{ id: number }>(
      fixture.projectId,
      "SELECT id FROM events WHERE type = 'memory.remember.gotcha' ORDER BY id ASC LIMIT 1"
    )[0]
    // Five deliberate fetches (≈ a genuinely proven entry) — with the
    // pull-first diet the digest has only 2 slots per type, so the proven
    // entry must beat the SECOND-newest, not the third. A single fetch
    // (0.4) stays under the rerank's normalization floor of 1 by design —
    // weak signals shouldn't reshuffle the digest.
    for (const _ of Array.from({ length: 5 })) {
      usefulnessService.recordFetch(fixture.projectId, `mem_${oldest.id}`)
    }

    const ctx = await buildSessionContext(fixture.projectPath, null, { digest: true })
    expect(ctx).not.toBeNull()
    expect(ctx).toContain('trap number 0')
    expect(ctx).toContain('trap number 4')
    expect(ctx).not.toContain('trap number 3')
  })
})
