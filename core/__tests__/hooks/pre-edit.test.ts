/**
 * PreToolUse(Edit|Write) `pre-edit` hook — the apply-loop push.
 *
 * Pins that when Claude is about to edit a file, the file's preventive memory
 * (gotchas/anti-patterns tagged to it) is surfaced as additionalContext — the
 * push that closes the loop pull-only `guard` left to the agent's instinct.
 * And that it stays SILENT (no harness) when there's nothing tagged to the
 * target file, so it never becomes noise.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runPreEditHook } from '../../hooks/pre-edit'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { projectMemory } from '../../memory/project-memory'
import { stateStorage } from '../../storage/state-storage'

const fixture: {
  projectPath: string
  projectId: string
} = {
  projectPath: '',
  projectId: '',
}

async function freshProject(): Promise<void> {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-pre-edit-test-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `test-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
}

/**
 * Drive the hook with a captured-IO bridge (the same shape the daemon uses)
 * and return the emitted stdout payload.
 */
async function runWith(toolInput: Record<string, unknown>): Promise<string> {
  const chunks: string[] = []
  await runPreEditHook(fixture.projectPath, {
    input: { tool_name: 'Edit', tool_input: toolInput },
    sink: (chunk: string) => {
      chunks.push(chunk)
    },
    detachAfterEmit: () => {},
  })
  return chunks.join('')
}

beforeEach(freshProject)
afterEach(async () => {
  if (fixture.projectPath) {
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
    fixture.projectPath = ''
  }
})

describe('pre-edit hook', () => {
  test('default off: classic heads-up for a gotcha (no CONFLICT spam)', async () => {
    await projectMemory.remember(fixture.projectPath, {
      type: 'gotcha',
      content: 'this module mutates shared state — clone before writing',
      tags: { file: 'core/state.ts' },
    })
    const out = await runWith({ file_path: '/abs/repo/core/state.ts' })
    // Quiet default — pack-gated conflict only.
    expect(out).toContain('heads-up before editing')
    expect(out).toContain('clone before writing')
    expect(out).not.toContain('CONFLICT')
    expect(out).not.toContain('"permissionDecision":"deny"')
  })

  test('conflictMode advisory: CONFLICT warn without deny', async () => {
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
      judgment: { conflictMode: 'advisory' },
    } as Parameters<typeof configManager.writeConfig>[1])
    await projectMemory.remember(fixture.projectPath, {
      type: 'gotcha',
      content: 'this module mutates shared state — clone before writing',
      tags: { file: 'core/state.ts' },
    })
    const out = await runWith({ file_path: '/abs/repo/core/state.ts' })
    expect(out).toContain('CONFLICT')
    expect(out).toContain('clone before writing')
    expect(out).not.toContain('"permissionDecision":"deny"')
  })

  test('conflictMode off: classic heads-up nudge (no CONFLICT gate)', async () => {
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
      judgment: { conflictMode: 'off' },
    } as Parameters<typeof configManager.writeConfig>[1])
    await projectMemory.remember(fixture.projectPath, {
      type: 'gotcha',
      content: 'this module mutates shared state — clone before writing',
      tags: { file: 'core/state.ts' },
    })
    const out = await runWith({ file_path: '/abs/repo/core/state.ts' })
    expect(out).toContain('heads-up before editing')
    expect(out).toContain('clone before writing')
    expect(out).not.toContain('CONFLICT')
  })

  test('conflictMode strict: DENIES high-confidence gotcha via PreToolUse deny', async () => {
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
      judgment: { conflictMode: 'strict' },
    } as Parameters<typeof configManager.writeConfig>[1])
    await projectMemory.remember(fixture.projectPath, {
      type: 'gotcha',
      content: 'this module mutates shared state — clone before writing',
      tags: { file: 'core/state.ts' },
    })
    const out = await runWith({ file_path: '/abs/repo/core/state.ts' })
    expect(out).toContain('permissionDecision')
    expect(out).toContain('deny')
    expect(out).toContain('conflict deny')
    expect(out).toContain('clone before writing')
  })

  test('matches by basename when the tagged path is relative', async () => {
    await projectMemory.remember(fixture.projectPath, {
      type: 'anti-pattern',
      content: 'do not call fetchAll() here, it N+1s',
      tags: { file: 'state.ts' },
    })
    const out = await runWith({ file_path: '/some/other/root/core/state.ts' })
    expect(out).toContain('fetchAll')
  })

  test('stays silent (emits {}) when nothing is tagged to the file', async () => {
    await projectMemory.remember(fixture.projectPath, {
      type: 'gotcha',
      content: 'unrelated trap in another file',
      tags: { file: 'core/other.ts' },
    })
    const out = await runWith({ file_path: '/abs/repo/core/state.ts' })
    expect(out.trim()).toBe('{}')
  })

  test('stays silent when no file_path is provided', async () => {
    const out = await runWith({})
    expect(out.trim()).toBe('{}')
  })

  test('does NOT surface non-preventive memory (decisions) for the file', async () => {
    await projectMemory.remember(fixture.projectPath, {
      type: 'decision',
      content: 'we chose this file as the entrypoint',
      tags: { file: 'core/state.ts' },
    })
    const out = await runWith({ file_path: '/abs/repo/core/state.ts' })
    expect(out.trim()).toBe('{}')
  })

  test('does NOT surface file history (context entries) — push carries only traps', async () => {
    await projectMemory.remember(fixture.projectPath, {
      type: 'context',
      content: 'this file was refactored during the token-efficiency work cycle',
      tags: { files: 'core/state.ts' },
    })
    const out = await runWith({ file_path: '/abs/repo/core/state.ts' })
    expect(out.trim()).toBe('{}')
  })
})

describe('pre-edit hook — hard loop guard (GAP 3)', () => {
  const withLimit = async (limit: number) =>
    configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
      maxTurnsPerCycle: limit,
    } as Parameters<typeof configManager.writeConfig>[1])

  const startCycle = async (over: Record<string, unknown>) =>
    stateStorage.startTask(fixture.projectId, {
      id: 't',
      description: 'grind',
      startedAt: new Date().toISOString(),
      sessionId: 's',
      ...over,
    } as Parameters<typeof stateStorage.startTask>[1])

  test('DENIES the edit once the cycle exceeds maxTurnsPerCycle', async () => {
    await withLimit(3)
    await startCycle({ turnCount: 5 })
    const out = await runWith({ file_path: '/abs/repo/x.ts' })
    expect(out).toContain('permissionDecision')
    expect(out).toContain('deny')
    expect(out).toContain('hard stop')
  })

  test('does NOT deny once the cycle is acknowledged (--extend)', async () => {
    await withLimit(3)
    await startCycle({ turnCount: 9, turnLimitAcknowledgedAt: new Date().toISOString() })
    const out = await runWith({ file_path: '/abs/repo/x.ts' })
    expect(out).not.toContain('deny')
  })

  test('does NOT deny under the limit', async () => {
    await withLimit(10)
    await startCycle({ turnCount: 2 })
    const out = await runWith({ file_path: '/abs/repo/x.ts' })
    expect(out).not.toContain('deny')
  })

  test('does NOT deny when the limit is unset (opt-in, behavior-preserving)', async () => {
    await startCycle({ turnCount: 99 })
    const out = await runWith({ file_path: '/abs/repo/x.ts' })
    expect(out).not.toContain('deny')
  })
})
