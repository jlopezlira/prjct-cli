/**
 * spec → tasks auto-breakdown tests.
 *
 * Pins the behavior the user pushed back on: when audit-spec promotes a
 * spec to `reviewed`, the acceptance_criteria materialize as queue tasks
 * automatically — no new verb to memorize.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { specService } from '../../services/spec-service'
import { breakdownSpecToTasks } from '../../services/spec-task-breakdown'
import prjctDb from '../../storage/database'
import { queueStorage } from '../../storage/queue-storage'
import { specStorage } from '../../storage/spec-storage'
import { emptySpecContent } from '../../types/spec'

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
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-bd-projects-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir

  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-bd-test-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `bd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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

describe('breakdownSpecToTasks', () => {
  test('one queue task per acceptance criterion, linked to the spec', async () => {
    const spec = specStorage.create(fixture.projectId, {
      title: 'rate limit auth',
      content: {
        ...emptySpecContent('limit /auth/* to 10 req/min/IP'),
        acceptance_criteria: [
          'returns 429 after 10 requests in 60s window',
          'rate limit headers (X-RateLimit-*) present on every /auth response',
          'whitelisted IPs bypass the limit',
        ],
      },
    })

    const result = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, spec)
    expect(result.taskIds).toHaveLength(3)
    expect(result.skippedReason).toBeUndefined()

    const queue = await queueStorage.getTasks(fixture.projectId)
    expect(queue).toHaveLength(3)
    for (const task of queue) {
      expect(task.featureId).toBe(spec.id)
      expect(task.groupId).toBe(spec.id)
      expect(task.groupName).toBe('rate limit auth')
      expect(task.section).toBe('backlog')
      expect(task.priority).toBe('medium')
    }

    const refetched = specStorage.get(fixture.projectId, spec.id)
    expect(refetched?.content.linked_tasks).toHaveLength(3)
    expect(refetched?.content.linked_tasks).toEqual(result.taskIds)
  })

  test('skips when acceptance_criteria is empty', async () => {
    const spec = specStorage.create(fixture.projectId, {
      title: 'empty spec',
      content: emptySpecContent('nothing yet'),
    })

    const result = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, spec)
    expect(result.taskIds).toHaveLength(0)
    expect(result.skippedReason).toBe('no_acceptance_criteria')

    const queue = await queueStorage.getTasks(fixture.projectId)
    expect(queue).toHaveLength(0)
  })

  test('idempotent: skips when linked_tasks already populated (re-audit case)', async () => {
    const spec = specStorage.create(fixture.projectId, {
      title: 'idempotent',
      content: {
        ...emptySpecContent('test re-audit'),
        acceptance_criteria: ['AC one', 'AC two'],
      },
    })

    const first = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, spec)
    expect(first.taskIds).toHaveLength(2)

    const after = specStorage.get(fixture.projectId, spec.id)
    expect(after).toBeTruthy()
    if (!after) return
    const second = await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, after)
    expect(second.taskIds).toHaveLength(0)
    expect(second.skippedReason).toBe('already_broken_down')

    const queue = await queueStorage.getTasks(fixture.projectId)
    expect(queue).toHaveLength(2) // not 4
  })

  test('long AC truncates description but preserves full text in body', async () => {
    const longAc =
      'when an authenticated user uploads a file larger than 50 MB, the server must reject with HTTP 413 and a Problem Details body that includes the maxBytes constant from config so the client can surface it correctly without hard-coding'
    const spec = specStorage.create(fixture.projectId, {
      title: 'upload limits',
      content: {
        ...emptySpecContent('cap upload size'),
        acceptance_criteria: [longAc],
      },
    })

    await breakdownSpecToTasks(fixture.projectId, fixture.projectPath, spec)
    const [task] = await queueStorage.getTasks(fixture.projectId)
    expect(task).toBeTruthy()
    if (!task) return
    expect(task.description.length).toBeLessThanOrEqual(140)
    expect(task.description.endsWith('…')).toBe(true)
    expect(task.body).toBe(longAc)
  })
})

describe('spec-service.recordReview → auto-breakdown', () => {
  test('all three reviewers passing triggers breakdown automatically', async () => {
    const spec = await specService.create(fixture.projectPath, {
      title: 'auto-breakdown via review',
      content: {
        goal: 'prove the SDD chain wires up end-to-end',
        acceptance_criteria: ['ac alpha', 'ac beta'],
      },
      autoContext: false,
    })

    await specService.recordReview(fixture.projectPath, spec.id, 'strategic', {
      verdict: 'pass',
      notes: 'looks aligned',
    })
    await specService.recordReview(fixture.projectPath, spec.id, 'architecture', {
      verdict: 'pass',
      notes: 'no concerns',
    })
    const final = await specService.recordReview(fixture.projectPath, spec.id, 'design', {
      verdict: 'pass',
      notes: 'fine',
    })

    expect(final?.status).toBe('reviewed')
    expect(final?.content.linked_tasks).toHaveLength(2)

    const queue = await queueStorage.getTasks(fixture.projectId)
    expect(queue).toHaveLength(2)
    expect(queue.every((t) => t.featureId === spec.id)).toBe(true)
  })

  test('partial reviews leave spec in draft and DO NOT create tasks', async () => {
    const spec = await specService.create(fixture.projectPath, {
      title: 'partial review',
      content: {
        goal: 'only two reviewers pass — should stay draft',
        acceptance_criteria: ['ac one'],
      },
      autoContext: false,
    })

    await specService.recordReview(fixture.projectPath, spec.id, 'strategic', {
      verdict: 'pass',
      notes: '',
    })
    const after = await specService.recordReview(fixture.projectPath, spec.id, 'architecture', {
      verdict: 'pass',
      notes: '',
    })

    expect(after?.status).toBe('draft')
    expect(after?.content.linked_tasks).toHaveLength(0)
    const queue = await queueStorage.getTasks(fixture.projectId)
    expect(queue).toHaveLength(0)
  })
})
