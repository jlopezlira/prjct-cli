/**
 * Custom Workflow Storage Tests
 *
 * Tests for user-defined workflows with agentic auto-configuration:
 * - CRUD operations (create, read, update, delete)
 * - Built-in workflow protection
 * - Workflow name validation
 * - Soft delete behavior
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { customWorkflowStorage } from '../../storage/custom-workflow-storage'
import { prjctDb } from '../../storage/database'

// Test Setup

const fixture: {
  tmpRoot: string
  testProjectId: string
} = {
  tmpRoot: '',
  testProjectId: '',
}

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

describe('Custom Workflow Storage', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-workflow-test-'))
    fixture.testProjectId = 'test-workflow-project'

    pathManager.getGlobalProjectPath = (projectId: string) => path.join(fixture.tmpRoot, projectId)

    // Ensure required dirs exist
    await fs.mkdir(path.join(fixture.tmpRoot, fixture.testProjectId), { recursive: true })

    // Initialize the database (triggers migration v4 which seeds built-in workflows)
    prjctDb.getDb(fixture.testProjectId)
  })

  afterEach(async () => {
    prjctDb.close()
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath

    if (fixture.tmpRoot) {
      await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
    }
  })

  // Built-in Workflows

  describe('built-in workflows', () => {
    it('should seed 4 built-in workflows on first migration', () => {
      const workflows = customWorkflowStorage.getAllWorkflows(fixture.testProjectId)
      const builtins = workflows.filter((w) => w.isBuiltin)

      expect(builtins).toHaveLength(4)
      expect(builtins.map((w) => w.name).sort()).toEqual(['done', 'ship', 'sync', 'task'])
    })

    it('should mark built-in workflows with isBuiltin=true', () => {
      const task = customWorkflowStorage.getWorkflow(fixture.testProjectId, 'task')
      expect(task).toBeTruthy()
      expect(task?.isBuiltin).toBe(true)
    })

    it('should prevent deletion of built-in workflows', () => {
      expect(() => {
        customWorkflowStorage.deleteWorkflow(fixture.testProjectId, 'ship')
      }).toThrow('Cannot delete built-in workflow')
    })

    it('should allow soft-disable of built-in workflows', () => {
      const updated = customWorkflowStorage.updateWorkflow(fixture.testProjectId, 'ship', {
        enabled: false,
      })
      expect(updated).toBe(true)

      const workflow = customWorkflowStorage.getWorkflow(fixture.testProjectId, 'ship')
      expect(workflow?.enabled).toBe(false)
    })
  })

  // Custom Workflow CRUD

  describe('create custom workflow', () => {
    it('should create a new custom workflow', () => {
      const id = customWorkflowStorage.createWorkflow(fixture.testProjectId, {
        name: 'qa',
        description: 'Quality assurance checks',
      })

      expect(id).toBeGreaterThan(0)

      const workflow = customWorkflowStorage.getWorkflow(fixture.testProjectId, 'qa')
      expect(workflow).toBeTruthy()
      expect(workflow?.name).toBe('qa')
      expect(workflow?.description).toBe('Quality assurance checks')
      expect(workflow?.isBuiltin).toBe(false)
      expect(workflow?.enabled).toBe(true)
    })

    it('should create workflow with metadata', () => {
      const _id = customWorkflowStorage.createWorkflow(fixture.testProjectId, {
        name: 'deploy',
        description: 'Deploy to production',
        metadata: { environment: 'production', requiresApproval: true },
      })

      const workflow = customWorkflowStorage.getWorkflow(fixture.testProjectId, 'deploy')
      expect(workflow?.metadata).toEqual({ environment: 'production', requiresApproval: true })
    })

    it('should validate workflow name format', () => {
      expect(customWorkflowStorage.isValidName('qa')).toBe(true)
      expect(customWorkflowStorage.isValidName('deploy-prod')).toBe(true)
      expect(customWorkflowStorage.isValidName('e2e-tests')).toBe(true)

      // Invalid names
      expect(customWorkflowStorage.isValidName('QA')).toBe(false) // uppercase
      expect(customWorkflowStorage.isValidName('qa_test')).toBe(false) // underscore
      expect(customWorkflowStorage.isValidName('qa test')).toBe(false) // space
      expect(customWorkflowStorage.isValidName('qa!')).toBe(false) // special char
    })

    it('should check for reserved names', () => {
      // Built-in workflows
      expect(customWorkflowStorage.isReservedName('task')).toBe(true)
      expect(customWorkflowStorage.isReservedName('done')).toBe(true)
      expect(customWorkflowStorage.isReservedName('ship')).toBe(true)
      expect(customWorkflowStorage.isReservedName('sync')).toBe(true)

      // Command verbs
      expect(customWorkflowStorage.isReservedName('add')).toBe(true)
      expect(customWorkflowStorage.isReservedName('rm')).toBe(true)
      expect(customWorkflowStorage.isReservedName('create')).toBe(true)
      expect(customWorkflowStorage.isReservedName('delete')).toBe(true)

      // Non-reserved
      expect(customWorkflowStorage.isReservedName('qa')).toBe(false)
      expect(customWorkflowStorage.isReservedName('deploy')).toBe(false)
    })
  })

  describe('read workflows', () => {
    beforeEach(() => {
      customWorkflowStorage.createWorkflow(fixture.testProjectId, {
        name: 'qa',
        description: 'QA checks',
      })
      customWorkflowStorage.createWorkflow(fixture.testProjectId, {
        name: 'deploy',
        description: 'Deploy',
      })
    })

    it('should get workflow by name', () => {
      const workflow = customWorkflowStorage.getWorkflow(fixture.testProjectId, 'qa')
      expect(workflow).toBeTruthy()
      expect(workflow?.name).toBe('qa')
    })

    it('should return null for non-existent workflow', () => {
      const workflow = customWorkflowStorage.getWorkflow(fixture.testProjectId, 'nonexistent')
      expect(workflow).toBeNull()
    })

    it('should list all workflows (built-in + custom)', () => {
      const workflows = customWorkflowStorage.getAllWorkflows(fixture.testProjectId)
      expect(workflows.length).toBeGreaterThanOrEqual(6) // 4 built-in + 2 custom

      const names = workflows.map((w) => w.name)
      expect(names).toContain('task')
      expect(names).toContain('done')
      expect(names).toContain('ship')
      expect(names).toContain('sync')
      expect(names).toContain('qa')
      expect(names).toContain('deploy')
    })

    it('should exclude disabled workflows by default', () => {
      // Disable the qa workflow
      customWorkflowStorage.updateWorkflow(fixture.testProjectId, 'qa', { enabled: false })

      const workflows = customWorkflowStorage.getAllWorkflows(fixture.testProjectId)
      const names = workflows.map((w) => w.name)
      expect(names).not.toContain('qa')
    })

    it('should include disabled workflows when includeDisabled=true', () => {
      // Disable the qa workflow
      customWorkflowStorage.updateWorkflow(fixture.testProjectId, 'qa', { enabled: false })

      const workflows = customWorkflowStorage.getAllWorkflows(fixture.testProjectId, true)
      const names = workflows.map((w) => w.name)
      expect(names).toContain('qa')

      const qa = workflows.find((w) => w.name === 'qa')
      expect(qa?.enabled).toBe(false)
    })
  })

  describe('update workflow', () => {
    beforeEach(() => {
      customWorkflowStorage.createWorkflow(fixture.testProjectId, {
        name: 'qa',
        description: 'QA checks',
      })
    })

    it('should update workflow description', () => {
      const updated = customWorkflowStorage.updateWorkflow(fixture.testProjectId, 'qa', {
        description: 'Quality Assurance',
      })
      expect(updated).toBe(true)

      const workflow = customWorkflowStorage.getWorkflow(fixture.testProjectId, 'qa')
      expect(workflow?.description).toBe('Quality Assurance')
    })

    it('should update workflow metadata', () => {
      const updated = customWorkflowStorage.updateWorkflow(fixture.testProjectId, 'qa', {
        metadata: { autoRun: true },
      })
      expect(updated).toBe(true)

      const workflow = customWorkflowStorage.getWorkflow(fixture.testProjectId, 'qa')
      expect(workflow?.metadata).toEqual({ autoRun: true })
    })

    it('should disable workflow', () => {
      const updated = customWorkflowStorage.updateWorkflow(fixture.testProjectId, 'qa', {
        enabled: false,
      })
      expect(updated).toBe(true)

      const workflow = customWorkflowStorage.getWorkflow(fixture.testProjectId, 'qa')
      expect(workflow?.enabled).toBe(false)
    })

    it('should return false for non-existent workflow', () => {
      const updated = customWorkflowStorage.updateWorkflow(fixture.testProjectId, 'nonexistent', {
        description: 'test',
      })
      expect(updated).toBe(false)
    })
  })

  describe('delete workflow', () => {
    beforeEach(() => {
      customWorkflowStorage.createWorkflow(fixture.testProjectId, {
        name: 'qa',
        description: 'QA checks',
      })
    })

    it('should soft-delete custom workflow', () => {
      const deleted = customWorkflowStorage.deleteWorkflow(fixture.testProjectId, 'qa')
      expect(deleted).toBe(true)

      // Workflow should not appear in default list
      const workflows = customWorkflowStorage.getAllWorkflows(fixture.testProjectId)
      const names = workflows.map((w) => w.name)
      expect(names).not.toContain('qa')

      // But should still exist when includeDisabled=true
      const allWorkflows = customWorkflowStorage.getAllWorkflows(fixture.testProjectId, true)
      const qa = allWorkflows.find((w) => w.name === 'qa')
      expect(qa).toBeTruthy()
      expect(qa?.enabled).toBe(false)
    })

    it('should return false for non-existent workflow', () => {
      const deleted = customWorkflowStorage.deleteWorkflow(fixture.testProjectId, 'nonexistent')
      expect(deleted).toBe(false)
    })
  })

  // Utility Methods

  describe('utility methods', () => {
    it('should check if workflow is built-in', () => {
      expect(customWorkflowStorage.isBuiltin(fixture.testProjectId, 'task')).toBe(true)
      expect(customWorkflowStorage.isBuiltin(fixture.testProjectId, 'ship')).toBe(true)

      customWorkflowStorage.createWorkflow(fixture.testProjectId, {
        name: 'qa',
        description: 'QA',
      })
      expect(customWorkflowStorage.isBuiltin(fixture.testProjectId, 'qa')).toBe(false)
    })

    it('should return false for non-existent workflow in isBuiltin', () => {
      expect(customWorkflowStorage.isBuiltin(fixture.testProjectId, 'nonexistent')).toBe(false)
    })
  })
})
