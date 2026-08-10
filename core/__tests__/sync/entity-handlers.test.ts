/**
 * Entity-handler registry tests (Phase 1.5 follow-up refactor).
 *
 * The registry replaces the two switches (apply + delete) that
 * previously sat in `sync-manager.ts`. These tests:
 *   - confirm every supported entity_type maps to a handler
 *   - exercise upsert + delete on the ideas handler as a
 *     representative case (the others share the same shape)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import prjctDb from '../../storage/database'
import { ideasStorage } from '../../storage/ideas-storage'
import { entityHandlers, SUPPORTED_ENTITY_TYPES } from '../../sync/entity-handlers'

const fixture: {
  tempDir: string
  originalProjectsDir: string | undefined
  projectId: string
} = {
  tempDir: '',
  originalProjectsDir: undefined as unknown as string | undefined,
  projectId: '',
}

describe('entity-handlers registry', () => {
  beforeEach(async () => {
    fixture.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-handlers-'))
    fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
    process.env.PRJCT_PROJECTS_DIR = fixture.tempDir
    fixture.projectId = `handlers-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
  })

  afterEach(async () => {
    if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
    else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
    await fs.rm(fixture.tempDir, { recursive: true, force: true })
  })

  test('exposes the canonical entity_types as keys', () => {
    expect(SUPPORTED_ENTITY_TYPES.sort()).toEqual(
      [
        'archives',
        'custom_workflows',
        'ideas',
        'memories',
        'queue_tasks',
        'shipped_features',
        'shipped_items',
        'specs',
        'tasks',
        'workflow_rules',
      ].sort()
    )
    for (const type of SUPPORTED_ENTITY_TYPES) {
      expect(entityHandlers[type]).toBeDefined()
      expect(typeof entityHandlers[type].upsert).toBe('function')
      expect(typeof entityHandlers[type].delete).toBe('function')
    }
  })

  test('ideas handler upsert creates + updates by id (no duplication on re-apply)', async () => {
    const handler = entityHandlers.ideas
    const data = {
      id: 'idea-1',
      text: 'rate limit auth',
      priority: 'high',
      status: 'active',
    }

    await handler.upsert(fixture.projectId, data)
    const initialIdeas = await ideasStorage.getAll(fixture.projectId)
    expect(initialIdeas.length).toBe(1)
    expect(initialIdeas[0].id).toBe('idea-1')

    // Re-apply: same id → still 1 row, fields stay coherent.
    await handler.upsert(fixture.projectId, { ...data, text: 'rate limit auth (updated)' })
    const updatedIdeas = await ideasStorage.getAll(fixture.projectId)
    expect(updatedIdeas.length).toBe(1)
    expect(updatedIdeas[0].text).toBe('rate limit auth (updated)')
  })

  test('ideas handler delete is a no-op — local is never modified by a remote delete', async () => {
    const handler = entityHandlers.ideas
    await handler.upsert(fixture.projectId, { id: 'idea-2', text: 'keep me', status: 'active' })
    await handler.delete(fixture.projectId, { id: 'idea-2' })

    // The local idea stays exactly as it was — sync never touches it.
    const after = await ideasStorage.getById(fixture.projectId, 'idea-2')
    expect(after).toBeTruthy()
    expect(after?.status).toBe('pending')
  })

  test('shipped handler delete is a no-op (append-only history)', async () => {
    const handler = entityHandlers.shipped_items
    // delete on append-only entity must not throw and must not error.
    await expect(handler.delete(fixture.projectId, { id: 'whatever' })).resolves.toBeUndefined()
  })
})
