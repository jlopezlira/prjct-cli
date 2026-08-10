/**
 * Question preferences storage — set / get / list / check / clear.
 *
 * Mirrors gstack's gstack-question-preference behavior, persisted in
 * SQLite kv_store under a single doc key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import prjctDb from '../../storage/database'
import {
  isValidPreference,
  isValidQuestionId,
  preferencesStorage,
} from '../../storage/preferences-storage'

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
  // Close *all* cached DB connections so a stale projectId from a prior
  // test can't be served from the singleton's connection map. The
  // connections persist across tests because prjctDb is a module-level
  // singleton; closing here is the only reliable isolation.
  prjctDb.close()
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-prefs-test-'))
  fixture.projectId = `test-prefs-${crypto.randomUUID()}`
  pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
  pathManager.getStoragePath = (id: string, filename: string) =>
    path.join(fixture.tmpRoot, id, 'storage', filename)
})

afterEach(async () => {
  // Close any DB connection the singleton cached during this test so the
  // next beforeEach starts truly fresh — without this, an old projectId
  // can reappear on cache lookups when prjctDb's MAX_DB_CONNECTIONS LRU
  // hasn't evicted it yet, and its data leaks across tests.
  prjctDb.close(fixture.projectId)
  pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
  pathManager.getStoragePath = originalGetStoragePath
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe('preferencesStorage validation', () => {
  it('accepts ids that are alphanumeric + hyphen + underscore', () => {
    expect(isValidQuestionId('commit-style')).toBe(true)
    expect(isValidQuestionId('ship_from_main')).toBe(true)
    expect(isValidQuestionId('CamelCase42')).toBe(true)
  })

  it('rejects empty, oversize, or special-char ids (poisoning surface)', () => {
    expect(isValidQuestionId('')).toBe(false)
    expect(isValidQuestionId('a'.repeat(81))).toBe(false)
    // Shell metachars and spaces — would be a profile-poisoning vector.
    expect(isValidQuestionId('rm -rf')).toBe(false)
    expect(isValidQuestionId('a;b')).toBe(false)
    expect(isValidQuestionId('a$b')).toBe(false)
    expect(isValidQuestionId('a/b')).toBe(false)
  })

  it('accepts the three known preference values only', () => {
    expect(isValidPreference('always-ask')).toBe(true)
    expect(isValidPreference('never-ask')).toBe(true)
    expect(isValidPreference('auto-decide')).toBe(true)
    expect(isValidPreference('whatever')).toBe(false)
    expect(isValidPreference('')).toBe(false)
  })
})

describe('preferencesStorage CRUD', () => {
  it('returns null for unknown question and ASK_NORMALLY for check', () => {
    expect(preferencesStorage.get(fixture.projectId, 'never-set')).toBeNull()
    expect(preferencesStorage.check(fixture.projectId, 'never-set')).toBe('ASK_NORMALLY')
  })

  it('persists a preference and round-trips through get/check', () => {
    const entry = preferencesStorage.set(fixture.projectId, {
      questionId: 'commit-style',
      preference: 'auto-decide',
      reason: 'always use feat: prefix',
    })
    expect(entry.questionId).toBe('commit-style')
    expect(entry.preference).toBe('auto-decide')
    expect(entry.reason).toBe('always use feat: prefix')
    expect(entry.setAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    expect(preferencesStorage.get(fixture.projectId, 'commit-style')?.preference).toBe(
      'auto-decide'
    )
    expect(preferencesStorage.check(fixture.projectId, 'commit-style')).toBe('AUTO_DECIDE')
  })

  it('maps never-ask to NEVER_ASK and always-ask to ASK_NORMALLY', () => {
    preferencesStorage.set(fixture.projectId, { questionId: 'q1', preference: 'never-ask' })
    preferencesStorage.set(fixture.projectId, { questionId: 'q2', preference: 'always-ask' })
    expect(preferencesStorage.check(fixture.projectId, 'q1')).toBe('NEVER_ASK')
    expect(preferencesStorage.check(fixture.projectId, 'q2')).toBe('ASK_NORMALLY')
  })

  it('overwrites existing preference on re-set with newer setAt', async () => {
    preferencesStorage.set(fixture.projectId, {
      questionId: 'router',
      preference: 'auto-decide',
      reason: 'first take',
    })
    await new Promise((r) => setTimeout(r, 5))
    preferencesStorage.set(fixture.projectId, {
      questionId: 'router',
      preference: 'always-ask',
      reason: 'changed my mind',
    })
    const entry = preferencesStorage.get(fixture.projectId, 'router')
    expect(entry?.preference).toBe('always-ask')
    expect(entry?.reason).toBe('changed my mind')
  })

  it('list() returns all entries sorted newest-first', async () => {
    preferencesStorage.set(fixture.projectId, { questionId: 'a', preference: 'never-ask' })
    await new Promise((r) => setTimeout(r, 5))
    preferencesStorage.set(fixture.projectId, { questionId: 'b', preference: 'auto-decide' })
    const list = preferencesStorage.list(fixture.projectId)
    expect(list.map((e) => e.questionId)).toEqual(['b', 'a'])
  })

  it('clear(id) removes a single entry, clear() wipes all', () => {
    preferencesStorage.set(fixture.projectId, { questionId: 'x', preference: 'never-ask' })
    preferencesStorage.set(fixture.projectId, { questionId: 'y', preference: 'auto-decide' })

    expect(preferencesStorage.clear(fixture.projectId, 'x')).toBe(1)
    expect(preferencesStorage.get(fixture.projectId, 'x')).toBeNull()
    expect(preferencesStorage.get(fixture.projectId, 'y')?.preference).toBe('auto-decide')

    expect(preferencesStorage.clear(fixture.projectId)).toBe(1)
    expect(preferencesStorage.list(fixture.projectId)).toEqual([])
  })

  it('clear(unknown) is a no-op that returns 0', () => {
    expect(preferencesStorage.clear(fixture.projectId, 'never-was-set')).toBe(0)
  })

  it('rejects an invalid question id at set time', () => {
    expect(() =>
      preferencesStorage.set(fixture.projectId, { questionId: 'a;b', preference: 'auto-decide' })
    ).toThrow(/Invalid questionId/)
  })

  it('strips whitespace-only reasons to undefined', () => {
    const entry = preferencesStorage.set(fixture.projectId, {
      questionId: 'q',
      preference: 'auto-decide',
      reason: '   ',
    })
    expect(entry.reason).toBeUndefined()
  })
})
