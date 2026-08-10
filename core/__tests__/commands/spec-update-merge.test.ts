/**
 * `prjct spec update --json` — PATCH semantics test.
 *
 * The bug being fixed: previously, --json did a full-replace via Zod's
 * default-filling parser, which silently wiped reviews / linked_tasks /
 * acceptance_criteria when the caller sent a partial payload (e.g.
 * updating just `goal`). Dogfood reality (Claude iterating on a spec
 * mid-audit) means partial patches must preserve untouched fields.
 *
 * These tests pin the new contract: shallow merge over existing content,
 * fields you provide replace, fields you omit preserve.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SpecCommands } from '../../commands/spec'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { specService } from '../../services/spec-service'
import prjctDb from '../../storage/database'

const fixture: {
  projectPath: string
  projectId: string
  originalProjectsDir: string | undefined
  cmd: SpecCommands
} = {
  projectPath: '',
  projectId: '',
  originalProjectsDir: undefined as unknown as string | undefined,
  cmd: undefined as unknown as SpecCommands,
}

async function freshProject(): Promise<void> {
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-update-merge-pd-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir

  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-update-merge-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
}

beforeEach(async () => {
  prjctDb.close()
  await freshProject()
  fixture.cmd = new SpecCommands()
})

afterEach(async () => {
  if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
  if (fixture.projectPath)
    await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  prjctDb.close()
})

describe('spec update --json shallow-merge', () => {
  test('partial patch preserves omitted fields (the wipe bug)', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'rate limit auth',
      content: {
        goal: 'limit /auth to 10/min',
        acceptance_criteria: ['returns 429 after 10 in 60s', 'X-RateLimit-* headers'],
        scope: ['auth/middleware.ts'],
      },
      autoContext: false,
    })
    // Pre-record a review so we can prove it survives a content patch.
    await specService.recordReview(fixture.projectPath, created.id, 'strategic', {
      verdict: 'pass',
      notes: 'scope is right',
    })

    const result = await fixture.cmd.update(created.id, fixture.projectPath, {
      json: JSON.stringify({ goal: 'limit /auth to 5/min — tightened after audit' }),
      md: true,
    })
    expect(result.success).toBe(true)

    const refreshed = await specService.get(fixture.projectPath, created.id)
    expect(refreshed?.content.goal).toBe('limit /auth to 5/min — tightened after audit')
    // Omitted fields must be preserved verbatim:
    expect(refreshed?.content.acceptance_criteria).toEqual([
      'returns 429 after 10 in 60s',
      'X-RateLimit-* headers',
    ])
    expect(refreshed?.content.scope).toEqual(['auth/middleware.ts'])
    // C1: goal is part of the frozen audit candidate — body drift clears
    // lens results (fail-closed admission). Omitted fields (ACs/scope) still
    // must survive the shallow merge.
    expect(refreshed?.content.reviews?.strategic).toBeUndefined()
  })

  test('explicit field in patch replaces existing value (not merged into array)', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'replacement test',
      content: {
        goal: 'g',
        acceptance_criteria: ['old AC 1', 'old AC 2'],
      },
      autoContext: false,
    })

    const result = await fixture.cmd.update(created.id, fixture.projectPath, {
      json: JSON.stringify({ acceptance_criteria: ['new AC only'] }),
      md: true,
    })
    expect(result.success).toBe(true)

    const refreshed = await specService.get(fixture.projectPath, created.id)
    expect(refreshed?.content.acceptance_criteria).toEqual(['new AC only'])
    // goal preserved (not in patch):
    expect(refreshed?.content.goal).toBe('g')
  })

  test('linked_tasks survive content patch (the originally-bitten case)', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'linked tasks survival',
      content: { goal: 'g', acceptance_criteria: ['AC 1'] },
      autoContext: false,
    })
    await specService.linkTask(fixture.projectPath, created.id, 'task-uuid-foo')
    await specService.linkTask(fixture.projectPath, created.id, 'task-uuid-bar')

    await fixture.cmd.update(created.id, fixture.projectPath, {
      json: JSON.stringify({ goal: 'updated goal' }),
      md: true,
    })

    const refreshed = await specService.get(fixture.projectPath, created.id)
    expect(refreshed?.content.linked_tasks).toEqual(['task-uuid-foo', 'task-uuid-bar'])
    expect(refreshed?.content.goal).toBe('updated goal')
  })

  test('explicit empty array DOES replace (caller can intentionally clear)', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'explicit clear',
      content: { goal: 'g', acceptance_criteria: ['old'] },
      autoContext: false,
    })

    await fixture.cmd.update(created.id, fixture.projectPath, {
      json: JSON.stringify({ acceptance_criteria: [] }),
      md: true,
    })

    const refreshed = await specService.get(fixture.projectPath, created.id)
    expect(refreshed?.content.acceptance_criteria).toEqual([])
  })

  test('non-object JSON payloads fail clean (no spec mutation)', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'guard payload type',
      content: { goal: 'pristine' },
      autoContext: false,
    })

    const arrayPayload = await fixture.cmd.update(created.id, fixture.projectPath, {
      json: '["not an object"]',
      md: true,
    })
    expect(arrayPayload.success).toBe(false)

    const nullPayload = await fixture.cmd.update(created.id, fixture.projectPath, {
      json: 'null',
      md: true,
    })
    expect(nullPayload.success).toBe(false)

    const refreshed = await specService.get(fixture.projectPath, created.id)
    expect(refreshed?.content.goal).toBe('pristine')
  })

  test('unknown spec id returns clean failure', async () => {
    const result = await fixture.cmd.update(
      '00000000-0000-0000-0000-000000000000',
      fixture.projectPath,
      {
        json: JSON.stringify({ goal: 'whatever' }),
        md: true,
      }
    )
    expect(result.success).toBe(false)
  })
})
