/**
 * Workflow engine step types (alpha.10).
 *
 * Covers the three action-prefix routers added this alpha:
 *   - `script:<path>` → runs `.prjct/workflows/<path>` with context env
 *   - `mcp:<server>:<tool>[:<args>]` → emits a structured instruction
 *   - `persona:context` → emits a persona-summary instruction
 *
 * Tests touch real tmp projects + SQLite so the rule lifecycle and
 * storage layer are exercised together, not mocked.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { customWorkflowStorage } from '../../storage/custom-workflow-storage'
import { workflowRuleStorage } from '../../storage/workflow-rule-storage'
import { executeWorkflowRules } from '../../workflow-engine/workflow-engine'

async function freshProject(): Promise<{ projectPath: string; projectId: string }> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-step-types-test-'))
  await fs.mkdir(path.join(projectPath, '.prjct'), { recursive: true })
  const projectId = `test-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(projectPath, {
    projectId,
    dataPath: path.join(projectPath, '.prjct-data'),
  })
  await pathManager.ensureProjectStructure(projectId)
  // Register a dummy workflow so rules can attach to it.
  customWorkflowStorage.createWorkflow(projectId, {
    name: 'test-wf',
    description: 'Test workflow',
  })
  return { projectPath, projectId }
}

describe('workflow step types (alpha.10)', () => {
  const fixture: {
    projectPath: string
    projectId: string
  } = {
    projectPath: '',
    projectId: '',
  }

  beforeEach(async () => {
    ;({ projectPath: fixture.projectPath, projectId: fixture.projectId } = await freshProject())
  })

  afterEach(async () => {
    if (fixture.projectPath) await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  describe('script: action', () => {
    test('executes a script under .prjct/workflows/', async () => {
      const scriptDir = path.join(fixture.projectPath, '.prjct/workflows')
      await fs.mkdir(scriptDir, { recursive: true })
      const outFile = path.join(fixture.projectPath, 'script-ran.txt')
      await fs.writeFile(
        path.join(scriptDir, 'greet.sh'),
        `#!/usr/bin/env bash\necho "hello" > ${JSON.stringify(outFile)}\n`,
        { mode: 0o755 }
      )

      workflowRuleStorage.addRule(fixture.projectId, {
        type: 'step',
        command: 'test-wf',
        position: 'before',
        action: 'script:greet.sh',
        description: 'greet',
        enabled: true,
        timeoutMs: 30000,
        createdAt: new Date().toISOString(),
        sortOrder: 0,
      })

      const result = await executeWorkflowRules(fixture.projectId, 'test-wf', 'before', {
        projectPath: fixture.projectPath,
      })
      expect(result.success).toBe(true)
      expect(result.stepsRun).toContain('greet')

      const wrote = await fs.readFile(outFile, 'utf-8')
      expect(wrote.trim()).toBe('hello')
    })

    test('refuses script paths that escape the workflows dir', async () => {
      // No file needed — the path resolver should block before exec.
      workflowRuleStorage.addRule(fixture.projectId, {
        type: 'step',
        command: 'test-wf',
        position: 'before',
        action: 'script:../../etc/passwd',
        description: null,
        enabled: true,
        timeoutMs: 30000,
        createdAt: new Date().toISOString(),
        sortOrder: 0,
      })

      const result = await executeWorkflowRules(fixture.projectId, 'test-wf', 'before', {
        projectPath: fixture.projectPath,
      })
      expect(result.success).toBe(false)
      expect(result.output).toMatch(/escapes workflows dir|not found/i)
    })

    test('refuses imported (untrusted) script rules', async () => {
      const scriptDir = path.join(fixture.projectPath, '.prjct/workflows')
      await fs.mkdir(scriptDir, { recursive: true })
      await fs.writeFile(path.join(scriptDir, 'x.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

      workflowRuleStorage.addRule(fixture.projectId, {
        type: 'step',
        command: 'test-wf',
        position: 'before',
        action: 'script:x.sh',
        trustSource: 'imported',
        description: null,
        enabled: true,
        timeoutMs: 30000,
        createdAt: new Date().toISOString(),
        sortOrder: 0,
      })

      const result = await executeWorkflowRules(fixture.projectId, 'test-wf', 'before', {
        projectPath: fixture.projectPath,
      })
      expect(result.success).toBe(false)
      expect(result.output).toMatch(/imported/i)
    })
  })

  describe('mcp: action', () => {
    test('emits a structured instruction instead of trying to call MCP', async () => {
      workflowRuleStorage.addRule(fixture.projectId, {
        type: 'instruction',
        command: 'test-wf',
        position: 'before',
        action: 'mcp:linear:list_issues:{"state":"open"}',
        description: 'pull open Linear issues',
        enabled: true,
        timeoutMs: 30000,
        createdAt: new Date().toISOString(),
        sortOrder: 0,
      })
      // Instructions fire as-is from their rule, but the mcp router
      // only kicks in for other rule types. Test with a hook so we
      // go through runRuleAction.
      workflowRuleStorage.addRule(fixture.projectId, {
        type: 'hook',
        command: 'test-wf',
        position: 'after',
        action: 'mcp:posthog:track',
        description: null,
        enabled: true,
        timeoutMs: 30000,
        createdAt: new Date().toISOString(),
        sortOrder: 0,
      })

      const result = await executeWorkflowRules(fixture.projectId, 'test-wf', 'after', {
        projectPath: fixture.projectPath,
      })
      expect(result.success).toBe(true)
      const hookInstruction = result.instructions.find((i) => i.includes('posthog.track'))
      expect(hookInstruction).toBeDefined()
      expect(hookInstruction).toMatch(/Call MCP `posthog.track`/)
    })

    test('parses server + tool + json args', async () => {
      workflowRuleStorage.addRule(fixture.projectId, {
        type: 'hook',
        command: 'test-wf',
        position: 'before',
        action: 'mcp:linear:update_issue:{"id":"LIN-1","state":"done"}',
        description: 'mark LIN-1 done',
        enabled: true,
        timeoutMs: 30000,
        createdAt: new Date().toISOString(),
        sortOrder: 0,
      })
      const result = await executeWorkflowRules(fixture.projectId, 'test-wf', 'before', {
        projectPath: fixture.projectPath,
      })
      const instruction = result.instructions.find((i) => i.includes('linear.update_issue'))
      expect(instruction).toBeDefined()
      expect(instruction).toContain('{"id":"LIN-1","state":"done"}')
      expect(instruction).toContain('mark LIN-1 done')
    })
  })

  describe('persona:context action', () => {
    test('emits persona summary when config declares one', async () => {
      const config = await configManager.readConfig(fixture.projectPath)
      await configManager.writeConfig(fixture.projectPath, {
        ...config!,
        persona: {
          role: 'Founder',
          focus: 'fundraising',
          mcps: ['gmail', 'linear'],
          packs: ['founder'],
        },
      })

      workflowRuleStorage.addRule(fixture.projectId, {
        type: 'hook',
        command: 'test-wf',
        position: 'before',
        action: 'persona:context',
        description: null,
        enabled: true,
        timeoutMs: 30000,
        createdAt: new Date().toISOString(),
        sortOrder: 0,
      })

      const result = await executeWorkflowRules(fixture.projectId, 'test-wf', 'before', {
        projectPath: fixture.projectPath,
      })
      expect(result.instructions.length).toBeGreaterThan(0)
      const personaNote = result.instructions[0]
      expect(personaNote).toContain('Founder')
      expect(personaNote).toContain('fundraising')
      expect(personaNote).toContain('gmail, linear')
    })

    test('falls back gracefully when no persona configured', async () => {
      workflowRuleStorage.addRule(fixture.projectId, {
        type: 'hook',
        command: 'test-wf',
        position: 'before',
        action: 'persona:context',
        description: null,
        enabled: true,
        timeoutMs: 30000,
        createdAt: new Date().toISOString(),
        sortOrder: 0,
      })

      const result = await executeWorkflowRules(fixture.projectId, 'test-wf', 'before', {
        projectPath: fixture.projectPath,
      })
      expect(result.instructions.length).toBeGreaterThan(0)
      expect(result.instructions[0]).toMatch(/no persona/i)
    })
  })
})
