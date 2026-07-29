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

let projectPath: string
let projectId: string
let originalProjectsDir: string | undefined
let cmd: SpecCommands

async function freshProject(): Promise<void> {
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-update-merge-pd-'))
  originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir

  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-update-merge-'))
  await fs.mkdir(path.join(projectPath, '.prjct'), { recursive: true })
  projectId = `merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await configManager.writeConfig(projectPath, {
    projectId,
    dataPath: path.join(projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(projectId)
  prjctDb.run(projectId, 'SELECT 1 WHERE 1=0')
}

beforeEach(async () => {
  prjctDb.close()
  await freshProject()
  cmd = new SpecCommands()
})

afterEach(async () => {
  if (originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = originalProjectsDir
  if (projectPath) await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {})
  prjctDb.close()
})

describe('spec update --json shallow-merge', () => {
  test('partial patch preserves omitted fields (the wipe bug)', async () => {
    const created = await specService.create(projectPath, {
      title: 'rate limit auth',
      content: {
        goal: 'limit /auth to 10/min',
        acceptance_criteria: ['returns 429 after 10 in 60s', 'X-RateLimit-* headers'],
        scope: ['auth/middleware.ts'],
      },
      autoContext: false,
    })
    // Pre-record a review so we can prove it survives a content patch.
    await specService.recordReview(projectPath, created.id, 'strategic', {
      verdict: 'pass',
      notes: 'scope is right',
    })

    const result = await cmd.update(created.id, projectPath, {
      json: JSON.stringify({ goal: 'limit /auth to 5/min — tightened after audit' }),
      md: true,
    })
    expect(result.success).toBe(true)

    const refreshed = await specService.get(projectPath, created.id)
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
    const created = await specService.create(projectPath, {
      title: 'replacement test',
      content: {
        goal: 'g',
        acceptance_criteria: ['old AC 1', 'old AC 2'],
      },
      autoContext: false,
    })

    const result = await cmd.update(created.id, projectPath, {
      json: JSON.stringify({ acceptance_criteria: ['new AC only'] }),
      md: true,
    })
    expect(result.success).toBe(true)

    const refreshed = await specService.get(projectPath, created.id)
    expect(refreshed?.content.acceptance_criteria).toEqual(['new AC only'])
    // goal preserved (not in patch):
    expect(refreshed?.content.goal).toBe('g')
  })

  test('linked_tasks survive content patch (the originally-bitten case)', async () => {
    const created = await specService.create(projectPath, {
      title: 'linked tasks survival',
      content: { goal: 'g', acceptance_criteria: ['AC 1'] },
      autoContext: false,
    })
    await specService.linkTask(projectPath, created.id, 'task-uuid-foo')
    await specService.linkTask(projectPath, created.id, 'task-uuid-bar')

    await cmd.update(created.id, projectPath, {
      json: JSON.stringify({ goal: 'updated goal' }),
      md: true,
    })

    const refreshed = await specService.get(projectPath, created.id)
    expect(refreshed?.content.linked_tasks).toEqual(['task-uuid-foo', 'task-uuid-bar'])
    expect(refreshed?.content.goal).toBe('updated goal')
  })

  test('explicit empty array DOES replace (caller can intentionally clear)', async () => {
    const created = await specService.create(projectPath, {
      title: 'explicit clear',
      content: { goal: 'g', acceptance_criteria: ['old'] },
      autoContext: false,
    })

    await cmd.update(created.id, projectPath, {
      json: JSON.stringify({ acceptance_criteria: [] }),
      md: true,
    })

    const refreshed = await specService.get(projectPath, created.id)
    expect(refreshed?.content.acceptance_criteria).toEqual([])
  })

  test('non-object JSON payloads fail clean (no spec mutation)', async () => {
    const created = await specService.create(projectPath, {
      title: 'guard payload type',
      content: { goal: 'pristine' },
      autoContext: false,
    })

    const arrayPayload = await cmd.update(created.id, projectPath, {
      json: '["not an object"]',
      md: true,
    })
    expect(arrayPayload.success).toBe(false)

    const nullPayload = await cmd.update(created.id, projectPath, {
      json: 'null',
      md: true,
    })
    expect(nullPayload.success).toBe(false)

    const refreshed = await specService.get(projectPath, created.id)
    expect(refreshed?.content.goal).toBe('pristine')
  })

  test('unknown spec id returns clean failure', async () => {
    const result = await cmd.update('00000000-0000-0000-0000-000000000000', projectPath, {
      json: JSON.stringify({ goal: 'whatever' }),
      md: true,
    })
    expect(result.success).toBe(false)
  })
})
