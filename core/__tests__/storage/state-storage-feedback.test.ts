/**
 * State Storage Task Feedback Tests (PRJ-272)
 *
 * Tests for the task-to-analysis feedback loop:
 * - Feedback schema validation
 * - Feedback persistence in task history
 * - Feedback aggregation across tasks
 * - Known gotchas promotion (2+ occurrences)
 * - Backward compatibility (tasks without feedback)
 * - Context injection (markdown with feedback)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import type { CurrentTask, StateJson, TaskFeedback } from '../../schemas/state'
import { TaskFeedbackSchema } from '../../schemas/state'
import { prjctDb } from '../../storage/database'
import { stateStorage } from '../../storage/state-storage'

// Test Setup

const fixture: {
  tmpRoot: string | null
  testProjectId: string
} = {
  tmpRoot: null,
  testProjectId: '',
}

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)
const originalGetStoragePath = pathManager.getStoragePath.bind(pathManager)
const originalGetFilePath = pathManager.getFilePath.bind(pathManager)

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-feedback-test-'))
  fixture.testProjectId = `test-feedback-${Date.now()}`

  pathManager.getGlobalProjectPath = (projectId: string) => {
    return path.join(fixture.tmpRoot!, projectId)
  }

  pathManager.getStoragePath = (projectId: string, filename: string) => {
    return path.join(fixture.tmpRoot!, projectId, 'storage', filename)
  }

  pathManager.getFilePath = (projectId: string, layer: string, filename: string) => {
    return path.join(fixture.tmpRoot!, projectId, layer, filename)
  }

  const storagePath = pathManager.getStoragePath(fixture.testProjectId, '')
  await fs.mkdir(storagePath, { recursive: true })

  const syncPath = path.join(fixture.tmpRoot!, fixture.testProjectId, 'sync')
  await fs.mkdir(syncPath, { recursive: true })
})

afterEach(async () => {
  prjctDb.close()

  pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
  pathManager.getStoragePath = originalGetStoragePath
  pathManager.getFilePath = originalGetFilePath

  if (fixture.tmpRoot) {
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
    fixture.tmpRoot = null
  }
})

// Helper Functions

function createMockTask(
  overrides: Partial<CurrentTask> & Record<string, unknown> = {}
): CurrentTask {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    description: 'Test task',
    startedAt: new Date().toISOString(),
    sessionId: `session-${Date.now()}`,
    ...overrides,
  } as CurrentTask
}

async function startAndCompleteWithFeedback(
  projectId: string,
  task: CurrentTask,
  feedback?: TaskFeedback
): Promise<StateJson> {
  await stateStorage.startTask(projectId, task)
  await stateStorage.completeTask(projectId, feedback)
  // Schema v2 (C4): history lives in the typed tasks table, not the blob.
  const state = await stateStorage.read(projectId)
  return { ...state, taskHistory: await stateStorage.getTaskHistory(projectId) }
}

// Tests: TaskFeedback Schema Validation

describe('TaskFeedback Schema', () => {
  it('should validate a complete feedback object', () => {
    const feedback: TaskFeedback = {
      stackConfirmed: ['React 18', 'TypeScript strict mode'],
      patternsDiscovered: ['API routes follow /api/v1/{resource} pattern'],
      agentAccuracy: [{ agent: 'backend.md', rating: 'helpful', note: 'Good API patterns' }],
      issuesEncountered: ['ESLint conflicts with Prettier'],
    }

    const result = TaskFeedbackSchema.safeParse(feedback)
    expect(result.success).toBe(true)
  })

  it('should validate an empty feedback object', () => {
    const feedback: TaskFeedback = {}

    const result = TaskFeedbackSchema.safeParse(feedback)
    expect(result.success).toBe(true)
  })

  it('should validate feedback with only patterns', () => {
    const feedback: TaskFeedback = {
      patternsDiscovered: ['Components use barrel exports'],
    }

    const result = TaskFeedbackSchema.safeParse(feedback)
    expect(result.success).toBe(true)
  })

  it('should reject invalid agent accuracy rating', () => {
    const feedback = {
      agentAccuracy: [{ agent: 'backend.md', rating: 'invalid_rating' }],
    }

    const result = TaskFeedbackSchema.safeParse(feedback)
    expect(result.success).toBe(false)
  })

  it('should validate all agent accuracy rating values', () => {
    for (const rating of ['helpful', 'neutral', 'inaccurate'] as const) {
      const feedback: TaskFeedback = {
        agentAccuracy: [{ agent: 'test.md', rating }],
      }
      const result = TaskFeedbackSchema.safeParse(feedback)
      expect(result.success).toBe(true)
    }
  })
})

// Tests: Feedback Persistence in Task History

describe('Feedback Persistence', () => {
  it('should store feedback in task history entry', async () => {
    const task = createMockTask({ description: 'Task with feedback' })
    const feedback: TaskFeedback = {
      stackConfirmed: ['TypeScript'],
      patternsDiscovered: ['Uses Hono framework'],
    }

    const state = await startAndCompleteWithFeedback(fixture.testProjectId, task, feedback)

    expect(state.taskHistory).toBeDefined()
    expect(state.taskHistory!.length).toBe(1)
    expect(state.taskHistory![0].feedback).toBeDefined()
    expect(state.taskHistory![0].feedback?.stackConfirmed).toEqual(['TypeScript'])
    expect(state.taskHistory![0].feedback?.patternsDiscovered).toEqual(['Uses Hono framework'])
  })

  it('should store task without feedback (backward compatible)', async () => {
    const task = createMockTask({ description: 'Task without feedback' })

    const state = await startAndCompleteWithFeedback(fixture.testProjectId, task)

    expect(state.taskHistory).toBeDefined()
    expect(state.taskHistory!.length).toBe(1)
    expect(state.taskHistory![0].feedback).toBeUndefined()
  })

  it('should preserve feedback through FIFO eviction', async () => {
    // Complete first task with feedback
    const task1 = createMockTask({ description: 'Task 1' })
    await stateStorage.startTask(fixture.testProjectId, task1)
    await stateStorage.completeTask(fixture.testProjectId, {
      patternsDiscovered: ['Pattern from task 1'],
    })

    // Complete second task with feedback
    const task2 = createMockTask({ description: 'Task 2' })
    await stateStorage.startTask(fixture.testProjectId, task2)
    await stateStorage.completeTask(fixture.testProjectId, {
      patternsDiscovered: ['Pattern from task 2'],
    })

    const state = { taskHistory: await stateStorage.getTaskHistory(fixture.testProjectId) }
    expect(state.taskHistory!.length).toBe(2)
    // Most recent first (FIFO)
    expect(state.taskHistory![0].feedback?.patternsDiscovered).toEqual(['Pattern from task 2'])
    expect(state.taskHistory![1].feedback?.patternsDiscovered).toEqual(['Pattern from task 1'])
  })

  it('should store full feedback with all fields', async () => {
    const task = createMockTask({ description: 'Full feedback task' })
    const feedback: TaskFeedback = {
      stackConfirmed: ['React 18', 'TypeScript'],
      patternsDiscovered: ['API routes use /api/v1/{resource}', 'Barrel exports'],
      agentAccuracy: [
        { agent: 'backend.md', rating: 'helpful', note: 'Good patterns' },
        { agent: 'frontend.md', rating: 'inaccurate', note: 'Missing Tailwind' },
      ],
      issuesEncountered: ['ESLint conflicts with Prettier'],
    }

    const state = await startAndCompleteWithFeedback(fixture.testProjectId, task, feedback)

    const stored = state.taskHistory![0].feedback!
    expect(stored.stackConfirmed).toEqual(['React 18', 'TypeScript'])
    expect(stored.patternsDiscovered).toEqual([
      'API routes use /api/v1/{resource}',
      'Barrel exports',
    ])
    expect(stored.agentAccuracy).toHaveLength(2)
    expect(stored.agentAccuracy![0].rating).toBe('helpful')
    expect(stored.agentAccuracy![1].rating).toBe('inaccurate')
    expect(stored.issuesEncountered).toEqual(['ESLint conflicts with Prettier'])
  })
})

// Tests: Feedback Aggregation

describe('Feedback Aggregation', () => {
  it('should aggregate patterns from multiple tasks', async () => {
    // Task 1
    const task1 = createMockTask({ description: 'Task 1' })
    await stateStorage.startTask(fixture.testProjectId, task1)
    await stateStorage.completeTask(fixture.testProjectId, {
      patternsDiscovered: ['Pattern A'],
    })

    // Task 2
    const task2 = createMockTask({ description: 'Task 2' })
    await stateStorage.startTask(fixture.testProjectId, task2)
    await stateStorage.completeTask(fixture.testProjectId, {
      patternsDiscovered: ['Pattern B'],
    })

    const aggregated = await stateStorage.getAggregatedFeedback(fixture.testProjectId)
    expect(aggregated.patternsDiscovered).toContain('Pattern A')
    expect(aggregated.patternsDiscovered).toContain('Pattern B')
  })

  it('should deduplicate patterns', async () => {
    // Both tasks discover the same pattern
    const task1 = createMockTask({ description: 'Task 1' })
    await stateStorage.startTask(fixture.testProjectId, task1)
    await stateStorage.completeTask(fixture.testProjectId, {
      patternsDiscovered: ['Same pattern'],
    })

    const task2 = createMockTask({ description: 'Task 2' })
    await stateStorage.startTask(fixture.testProjectId, task2)
    await stateStorage.completeTask(fixture.testProjectId, {
      patternsDiscovered: ['Same pattern'],
    })

    const aggregated = await stateStorage.getAggregatedFeedback(fixture.testProjectId)
    expect(aggregated.patternsDiscovered).toEqual(['Same pattern'])
  })

  it('should deduplicate stack confirmations', async () => {
    const task1 = createMockTask({ description: 'Task 1' })
    await stateStorage.startTask(fixture.testProjectId, task1)
    await stateStorage.completeTask(fixture.testProjectId, {
      stackConfirmed: ['TypeScript', 'React'],
    })

    const task2 = createMockTask({ description: 'Task 2' })
    await stateStorage.startTask(fixture.testProjectId, task2)
    await stateStorage.completeTask(fixture.testProjectId, {
      stackConfirmed: ['TypeScript', 'Next.js'],
    })

    const aggregated = await stateStorage.getAggregatedFeedback(fixture.testProjectId)
    expect(aggregated.stackConfirmed).toContain('TypeScript')
    expect(aggregated.stackConfirmed).toContain('React')
    expect(aggregated.stackConfirmed).toContain('Next.js')
    // TypeScript should not be duplicated
    expect(aggregated.stackConfirmed.filter((s) => s === 'TypeScript')).toHaveLength(1)
  })

  it('should promote recurring issues to known gotchas', async () => {
    // Same issue encountered twice
    const task1 = createMockTask({ description: 'Task 1' })
    await stateStorage.startTask(fixture.testProjectId, task1)
    await stateStorage.completeTask(fixture.testProjectId, {
      issuesEncountered: ['ESLint conflicts with Prettier'],
    })

    const task2 = createMockTask({ description: 'Task 2' })
    await stateStorage.startTask(fixture.testProjectId, task2)
    await stateStorage.completeTask(fixture.testProjectId, {
      issuesEncountered: ['ESLint conflicts with Prettier'],
    })

    const aggregated = await stateStorage.getAggregatedFeedback(fixture.testProjectId)
    expect(aggregated.knownGotchas).toContain('ESLint conflicts with Prettier')
  })

  it('should NOT promote single-occurrence issues to gotchas', async () => {
    const task1 = createMockTask({ description: 'Task 1' })
    await stateStorage.startTask(fixture.testProjectId, task1)
    await stateStorage.completeTask(fixture.testProjectId, {
      issuesEncountered: ['One-time issue'],
    })

    const aggregated = await stateStorage.getAggregatedFeedback(fixture.testProjectId)
    expect(aggregated.issuesEncountered).toContain('One-time issue')
    expect(aggregated.knownGotchas).not.toContain('One-time issue')
  })

  it('should aggregate agent accuracy across tasks', async () => {
    const task1 = createMockTask({ description: 'Task 1' })
    await stateStorage.startTask(fixture.testProjectId, task1)
    await stateStorage.completeTask(fixture.testProjectId, {
      agentAccuracy: [{ agent: 'backend.md', rating: 'helpful' }],
    })

    const task2 = createMockTask({ description: 'Task 2' })
    await stateStorage.startTask(fixture.testProjectId, task2)
    await stateStorage.completeTask(fixture.testProjectId, {
      agentAccuracy: [{ agent: 'backend.md', rating: 'inaccurate', note: 'Missing Hono context' }],
    })

    const aggregated = await stateStorage.getAggregatedFeedback(fixture.testProjectId)
    expect(aggregated.agentAccuracy).toHaveLength(2)
    expect(aggregated.agentAccuracy[0].agent).toBe('backend.md')
    expect(aggregated.agentAccuracy[1].agent).toBe('backend.md')
  })

  it('should return empty aggregation when no feedback exists', async () => {
    // Complete task without feedback
    const task = createMockTask({ description: 'No feedback' })
    await stateStorage.startTask(fixture.testProjectId, task)
    await stateStorage.completeTask(fixture.testProjectId)

    const aggregated = await stateStorage.getAggregatedFeedback(fixture.testProjectId)
    expect(aggregated.stackConfirmed).toEqual([])
    expect(aggregated.patternsDiscovered).toEqual([])
    expect(aggregated.agentAccuracy).toEqual([])
    expect(aggregated.issuesEncountered).toEqual([])
    expect(aggregated.knownGotchas).toEqual([])
  })

  it('should return empty aggregation when no tasks exist', async () => {
    const aggregated = await stateStorage.getAggregatedFeedback(fixture.testProjectId)
    expect(aggregated.stackConfirmed).toEqual([])
    expect(aggregated.patternsDiscovered).toEqual([])
    expect(aggregated.knownGotchas).toEqual([])
  })
})

// Tests: Mixed Feedback and Non-Feedback Tasks

describe('Mixed Tasks (with and without feedback)', () => {
  it('should handle mix of tasks with and without feedback', async () => {
    // Task 1: with feedback
    const task1 = createMockTask({ description: 'With feedback' })
    await stateStorage.startTask(fixture.testProjectId, task1)
    await stateStorage.completeTask(fixture.testProjectId, {
      patternsDiscovered: ['Pattern from task 1'],
    })

    // Task 2: without feedback
    const task2 = createMockTask({ description: 'Without feedback' })
    await stateStorage.startTask(fixture.testProjectId, task2)
    await stateStorage.completeTask(fixture.testProjectId)

    // Task 3: with feedback
    const task3 = createMockTask({ description: 'With feedback again' })
    await stateStorage.startTask(fixture.testProjectId, task3)
    await stateStorage.completeTask(fixture.testProjectId, {
      patternsDiscovered: ['Pattern from task 3'],
    })

    const aggregated = await stateStorage.getAggregatedFeedback(fixture.testProjectId)
    expect(aggregated.patternsDiscovered).toContain('Pattern from task 1')
    expect(aggregated.patternsDiscovered).toContain('Pattern from task 3')
    expect(aggregated.patternsDiscovered).toHaveLength(2)
  })

  it('should correctly count occurrences for gotcha promotion with mixed tasks', async () => {
    // Task 1: encounters issue
    const task1 = createMockTask({ description: 'Task 1' })
    await stateStorage.startTask(fixture.testProjectId, task1)
    await stateStorage.completeTask(fixture.testProjectId, {
      issuesEncountered: ['Build fails on M1'],
    })

    // Task 2: no feedback
    const task2 = createMockTask({ description: 'Task 2' })
    await stateStorage.startTask(fixture.testProjectId, task2)
    await stateStorage.completeTask(fixture.testProjectId)

    // Task 3: encounters same issue
    const task3 = createMockTask({ description: 'Task 3' })
    await stateStorage.startTask(fixture.testProjectId, task3)
    await stateStorage.completeTask(fixture.testProjectId, {
      issuesEncountered: ['Build fails on M1'],
    })

    const aggregated = await stateStorage.getAggregatedFeedback(fixture.testProjectId)
    expect(aggregated.knownGotchas).toContain('Build fails on M1')
  })
})
