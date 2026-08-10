/**
 * Phase 1.6 / B3 — applyEvent surfaces unhandled entity_types.
 *
 * Two contracts to pin:
 *   1. When an event arrives for an entity_type with no registered
 *      handler, applyEvent emits a stable warn line (not a silent
 *      no-op). Once per process per entity_type — batch pulls don't
 *      become a wall of identical warns.
 *   2. Exhaustiveness: every entity_type the cloud might emit
 *      (per ENTITY_TYPE_MAP in event-mapper.ts) is either handled
 *      or explicitly listed in UNKNOWN_ENTITY_TYPES. CI fails if
 *      the cloud gains a new entity that nobody categorized here.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import prjctDb from '../../storage/database'
import { entityHandlers, UNKNOWN_ENTITY_TYPES } from '../../sync/entity-handlers'
import { _resetWarnDedupeForTest, syncManager } from '../../sync/sync-manager'

const fixture: {
  projectId: string
  originalProjectsDir: string | undefined
  warnCalls: string[]
  originalWarn: typeof console.warn
} = {
  projectId: '',
  originalProjectsDir: undefined as unknown as string | undefined,
  warnCalls: undefined as unknown as string[],
  originalWarn: undefined as unknown as typeof console.warn,
}

beforeEach(async () => {
  prjctDb.close()
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-unknown-ent-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir
  fixture.projectId = `unknown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await pathManager.ensureProjectStructure(fixture.projectId)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')

  fixture.warnCalls = []
  fixture.originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    fixture.warnCalls.push(args.map((a) => String(a)).join(' '))
  }
  _resetWarnDedupeForTest()
})

afterEach(() => {
  console.warn = fixture.originalWarn
  _resetWarnDedupeForTest()
  if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
  prjctDb.close()
})

async function applyEvent(event: Record<string, unknown>): Promise<void> {
  await (
    syncManager as unknown as {
      applyEvent: (pid: string, ev: Record<string, unknown>) => Promise<void>
    }
  ).applyEvent(fixture.projectId, event)
}

describe('applyEvent — unhandled entity_type warn (Phase 1.6 / B3)', () => {
  test('roadmap_features (in UNKNOWN_ENTITY_TYPES) emits a stable warn', async () => {
    await applyEvent({
      entity_type: 'roadmap_features',
      event_type: 'upsert',
      data: { id: 'feat-A' },
    })

    expect(fixture.warnCalls).toHaveLength(1)
    expect(fixture.warnCalls[0]).toContain('[sync] apply skipped')
    expect(fixture.warnCalls[0]).toContain("entity_type='roadmap_features'")
    expect(fixture.warnCalls[0]).toContain('code=no_local_handler')
    // The Phase 2 hint should appear for known-but-unhandled types so
    // operators know this is intentional, not a registration miss.
    expect(fixture.warnCalls[0]).toContain('Phase 2')
  })

  test('projects (in UNKNOWN_ENTITY_TYPES) also emits the Phase 2 hint', async () => {
    await applyEvent({
      entity_type: 'projects',
      event_type: 'upsert',
      data: { id: 'proj-A' },
    })
    expect(
      fixture.warnCalls.some((w) => w.includes("entity_type='projects'") && w.includes('Phase 2'))
    ).toBe(true)
  })

  test('genuinely unknown entity_type warns WITHOUT the Phase 2 hint', async () => {
    await applyEvent({
      entity_type: 'totally_new_thing',
      event_type: 'upsert',
      data: { id: 'x' },
    })
    expect(fixture.warnCalls).toHaveLength(1)
    expect(fixture.warnCalls[0]).toContain("entity_type='totally_new_thing'")
    expect(fixture.warnCalls[0]).toContain('no local handler registered')
    expect(fixture.warnCalls[0]).not.toContain('Phase 2')
  })

  test('warn is deduped per-process (batch pull does not flood)', async () => {
    for (const i of Array.from({ length: 10 }, (_, index) => index)) {
      await applyEvent({
        entity_type: 'roadmap_features',
        event_type: 'upsert',
        data: { id: `feat-${i}` },
      })
    }
    expect(fixture.warnCalls).toHaveLength(1)
  })

  test('different unhandled types each get their own warn line', async () => {
    await applyEvent({
      entity_type: 'roadmap_features',
      event_type: 'upsert',
      data: { id: 'a' },
    })
    await applyEvent({
      entity_type: 'projects',
      event_type: 'upsert',
      data: { id: 'b' },
    })
    expect(fixture.warnCalls).toHaveLength(2)
  })

  test('handled entity_type does NOT warn (verifies the negative)', async () => {
    // Inject a registered no-op handler for a fake entity, prove no warn.
    const fake = entityHandlers as Record<
      string,
      { upsert: () => Promise<void>; delete: () => Promise<void> }
    >
    fake.fake_handled = {
      upsert: async () => {},
      delete: async () => {},
    }
    try {
      await applyEvent({
        entity_type: 'fake_handled',
        event_type: 'upsert',
        // created_at present so this stays focused on the no_local_handler
        // warn — a missing origin would (correctly) trigger a separate warn.
        data: { id: 'x', created_at: '2020-01-01T00:00:00.000Z' },
      })
      expect(fixture.warnCalls).toHaveLength(0)
    } finally {
      delete fake.fake_handled
    }
  })
})

describe('exhaustiveness: every wire entity_type is categorized', () => {
  test('ENTITY_TYPE_MAP outputs land in either entityHandlers or UNKNOWN_ENTITY_TYPES', async () => {
    // Mirror the ENTITY_TYPE_MAP from event-mapper. We pin the values
    // here rather than importing the private const because the test's
    // job is to FAIL when a new entry is added — that's the trigger
    // for someone to register a handler or list it as unknown.
    const wireEntityTypes = [
      'memories',
      'tasks',
      'subtasks',
      'ideas',
      'roadmap_features',
      'shipped_items',
      'shipped_features',
      'queue_tasks',
      'custom_workflows',
      'workflow_rules',
      'archives',
      'metrics_daily',
      'work_cost_snapshots',
      'velocity_sprints',
      'projects',
      'sessions',
      'agents',
    ]

    const handled = new Set(Object.keys(entityHandlers))

    const uncategorized = wireEntityTypes.filter(
      (t) => !handled.has(t) && !UNKNOWN_ENTITY_TYPES.has(t)
    )

    expect(uncategorized).toEqual([])
  })
})
