/**
 * Service-level `specService.patch` semantics — the single shallow-merge
 * implementation behind BOTH `prjct spec update --json` (CLI) and
 * `prjct_spec_update` (MCP). Pins:
 *   - omitted fields are preserved (reviews / ACs / linked_tasks)
 *   - fields provided replace wholesale (explicit empty array clears)
 *   - patching a body field (goal) drifts the audit candidate → reviews
 *     are cleared and a reviewed spec demotes to draft (C1 fail-closed)
 *
 * Mirrors the fixture pattern of
 * `core/__tests__/commands/spec-update-merge.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { specService } from '../../services/spec-service'
import prjctDb from '../../storage/database'

const fixture: {
  projectPath: string
  projectId: string
  originalProjectsDir: string | undefined
} = {
  projectPath: '',
  projectId: '',
  originalProjectsDir: undefined as unknown as string | undefined,
}

async function freshProject(): Promise<void> {
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-spec-patch-pd-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir

  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-spec-patch-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `patch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
})

afterEach(async () => {
  if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
  if (fixture.projectPath)
    await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  prjctDb.close()
})

describe('specService.patch', () => {
  test('partial patch preserves reviews, ACs and linked_tasks', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'patch preservation',
      content: {
        goal: 'ship the thing',
        acceptance_criteria: ['AC 1', 'AC 2'],
        scope: ['src/thing.ts'],
      },
      autoContext: false,
    })
    await specService.linkTask(fixture.projectPath, created.id, 'task-uuid-1')
    await specService.recordReview(fixture.projectPath, created.id, 'architecture', {
      verdict: 'pass',
      notes: 'sound',
    })

    // `notes` is NOT part of the audit-candidate hash, so this patch must
    // not drift the body — reviews survive untouched.
    const updated = await specService.patch(fixture.projectPath, created.id, {
      notes: 'extra context',
    })
    expect(updated).not.toBeNull()

    const refreshed = await specService.get(fixture.projectPath, created.id)
    expect(refreshed?.content.notes).toBe('extra context')
    expect(refreshed?.content.goal).toBe('ship the thing')
    expect(refreshed?.content.acceptance_criteria).toEqual(['AC 1', 'AC 2'])
    expect(refreshed?.content.scope).toEqual(['src/thing.ts'])
    expect(refreshed?.content.linked_tasks).toEqual(['task-uuid-1'])
    expect(refreshed?.content.reviews?.architecture?.verdict).toBe('pass')
  })

  test('explicit empty array still clears the field', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'explicit clear via patch',
      content: { goal: 'g', acceptance_criteria: ['old AC'] },
      autoContext: false,
    })

    await specService.patch(fixture.projectPath, created.id, { acceptance_criteria: [] })

    const refreshed = await specService.get(fixture.projectPath, created.id)
    expect(refreshed?.content.acceptance_criteria).toEqual([])
    expect(refreshed?.content.goal).toBe('g')
  })

  test('patching goal drifts the body → reviews cleared, reviewed demotes to draft', async () => {
    const created = await specService.create(fixture.projectPath, {
      title: 'body drift clears reviews',
      content: { goal: 'original goal', acceptance_criteria: ['AC 1'] },
      autoContext: false,
    })
    await specService.recordReview(fixture.projectPath, created.id, 'architecture', {
      verdict: 'pass',
      notes: 'ok',
    })
    // Force the lifecycle state directly — the demote rule keys off status,
    // and this avoids dragging the auto-promote breakdown side effects in.
    await specService.setStatus(fixture.projectPath, created.id, 'reviewed')
    const reviewed = await specService.get(fixture.projectPath, created.id)
    expect(reviewed?.status).toBe('reviewed')
    expect(reviewed?.content.reviews?.architecture?.verdict).toBe('pass')

    await specService.patch(fixture.projectPath, created.id, { goal: 'changed goal' })

    const refreshed = await specService.get(fixture.projectPath, created.id)
    expect(refreshed?.content.goal).toBe('changed goal')
    // Body drift: reviews wiped, frozen hash cleared, demoted to draft.
    expect(refreshed?.content.reviews?.architecture).toBeUndefined()
    expect(refreshed?.content.audit_candidate_hash).toBeNull()
    expect(refreshed?.status).toBe('draft')
    // Omitted fields still survive the drift-clearing path.
    expect(refreshed?.content.acceptance_criteria).toEqual(['AC 1'])
  })

  test('unknown spec id returns null (no mutation)', async () => {
    const result = await specService.patch(
      fixture.projectPath,
      '00000000-0000-0000-0000-000000000000',
      { goal: 'whatever' }
    )
    expect(result).toBeNull()
  })
})
