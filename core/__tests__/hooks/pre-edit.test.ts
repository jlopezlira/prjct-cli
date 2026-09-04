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
import { GuardCommands } from '../../commands/guard'
import { runPostReadHook } from '../../hooks/post-read'
import { runPreEditHook } from '../../hooks/pre-edit'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { projectMemory } from '../../memory/project-memory'
import { _resetDeliveredLedgerForTests } from '../../services/session-context-cache'
import {
  markSourceInspected,
  repoRelativeFile,
  sourceInspectionToken,
} from '../../services/source-first-gate'
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
async function runWith(toolInput: unknown, sessionId?: string): Promise<string> {
  const chunks: string[] = []
  await runPreEditHook(fixture.projectPath, {
    input: { tool_name: 'Edit', tool_input: toolInput, session_id: sessionId },
    sink: (chunk: string) => {
      chunks.push(chunk)
    },
    detachAfterEmit: () => {},
  })
  return chunks.join('')
}

async function runRead(toolInput: Record<string, unknown>, sessionId: string): Promise<void> {
  await runPostReadHook(fixture.projectPath, {
    input: { tool_name: 'Read', tool_input: toolInput, session_id: sessionId },
    sink: () => {},
    detachAfterEmit: () => {
      throw new Error('post-read inspection must not be detached')
    },
  })
}

/**
 * The gate fails open past its budget (300ms by default). Under a loaded
 * full-suite run this recall took 852ms, so the deny never fired — the test
 * was measuring the machine, not the contract. Give it room, and RESTORE the
 * original afterwards: bun shares one process across files, so leaving the
 * variable set silently rewrites the budget for every later suite.
 */
const ROOMY_BUDGET = '30000'
const ORIGINAL_BUDGET = process.env.PRJCT_CONFLICT_HARD_CAP_MS

beforeEach(freshProject)
beforeEach(() => {
  process.env.PRJCT_CONFLICT_HARD_CAP_MS = ROOMY_BUDGET
})
afterEach(() => {
  if (ORIGINAL_BUDGET === undefined) delete process.env.PRJCT_CONFLICT_HARD_CAP_MS
  else process.env.PRJCT_CONFLICT_HARD_CAP_MS = ORIGINAL_BUDGET
})
afterEach(async () => {
  if (fixture.projectPath) {
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
    fixture.projectPath = ''
  }
})

describe('pre-edit hook', () => {
  test('canonicalizes filesystem aliases before deciding whether a target is in-repo', async () => {
    if (process.platform === 'win32') return
    const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-real-root-'))
    const aliasRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-alias-root-'))
    const alias = path.join(aliasRoot, 'repo-link')
    try {
      await fs.mkdir(path.join(realRoot, 'src'), { recursive: true })
      await fs.symlink(realRoot, alias, 'dir')

      expect(repoRelativeFile(realRoot, path.join(alias, 'src', 'new-file.ts'))).toBe(
        'src/new-file.ts'
      )
    } finally {
      await fs.rm(realRoot, { recursive: true, force: true })
      await fs.rm(aliasRoot, { recursive: true, force: true })
    }
  })

  test('blocks Edit until the exact repo file is inspected', async () => {
    const file = path.join(fixture.projectPath, 'core', 'state.ts')
    const first = await runWith({ file_path: file }, 'source-session')
    expect(first).toContain('source-first gate')
    expect(first).toContain('permissionDecision')
    expect(first).toContain('prjct guard')

    const stillBlocked = await runWith({ file_path: file }, 'source-session')
    expect(stillBlocked).toContain('source-first gate')

    await markSourceInspected({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      sessionId: 'source-session',
      filePath: file,
    })
    expect((await runWith({ file_path: file }, 'source-session')).trim()).toBe('{}')
  })

  test('accepts filePath/path host payload variants and a successful Read handshake', async () => {
    const file = path.join(fixture.projectPath, 'core', 'state.ts')
    expect(await runWith({ filePath: file }, 'variant-session')).toContain('source-first gate')
    await runRead({ path: file }, 'variant-session')
    expect((await runWith({ path: file }, 'variant-session')).trim()).toBe('{}')
  })

  test('blocks a multi-file apply_patch until every target was inspected', async () => {
    const first = path.join(fixture.projectPath, 'core', 'first.ts')
    const second = path.join(fixture.projectPath, 'core', 'second.ts')
    await markSourceInspected({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      sessionId: 'patch-session',
      filePath: first,
    })
    const patch = [
      '*** Begin Patch',
      `*** Update File: ${first}`,
      '@@',
      '-old',
      '+new',
      `*** Add File: ${second}`,
      '+export const second = true',
      '*** End Patch',
    ].join('\n')
    const blocked = await runWith({ patch }, 'patch-session')
    expect(blocked).toContain('source-first gate')
    expect(blocked).toContain('core/second.ts')

    await markSourceInspected({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      sessionId: 'patch-session',
      filePath: second,
    })
    expect((await runWith({ patch }, 'patch-session')).trim()).toBe('{}')
  })

  test('parses Codex freeform apply_patch input and nested host arguments', async () => {
    const rawFile = path.join(fixture.projectPath, 'core', 'raw.ts')
    const rawPatch = `*** Begin Patch\n*** Update File: ${rawFile}\n@@\n-old\n+new\n*** End Patch`
    expect(await runWith(rawPatch, 'raw-patch-session')).toContain('core/raw.ts')

    const nestedFile = path.join(fixture.projectPath, 'core', 'nested.ts')
    const nestedPatch = `*** Begin Patch\n*** Update File: ${nestedFile}\n@@\n-old\n+new\n*** End Patch`
    expect(await runWith({ args: { input: nestedPatch } }, 'nested-patch-session')).toContain(
      'core/nested.ts'
    )
  })

  test('prjct guard is the source-inspection handshake for shell-first hosts', async () => {
    const file = path.join(fixture.projectPath, 'core', 'state.ts')
    expect(await runWith({ file_path: file }, 'guard-session')).toContain('source-first gate')
    const token = sourceInspectionToken({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      sessionId: 'guard-session',
      filePath: file,
    })
    expect(token).not.toBeNull()
    const result = await new GuardCommands().guard('core/state.ts', fixture.projectPath, {
      md: true,
      sourceInspectionToken: token!,
    })
    expect(result.success).toBe(true)
    expect((await runWith({ file_path: file }, 'guard-session')).trim()).toBe('{}')
  })

  test('sessionless hosts use a durable guard handshake instead of bricking or failing open', async () => {
    const file = path.join(fixture.projectPath, 'core', 'sessionless.ts')
    expect(await runWith({ file_path: file })).toContain('source-first gate')
    expect(await runWith({ file_path: file })).toContain('source-first gate')

    const sessionEnv = ['CLAUDE_SESSION_ID', 'CODEX_SESSION_ID', 'PRJCT_SESSION_ID'] as const
    const previous = new Map(sessionEnv.map((key) => [key, process.env[key]]))
    for (const key of sessionEnv) delete process.env[key]
    try {
      const result = await new GuardCommands().guard('core/sessionless.ts', fixture.projectPath, {
        md: true,
      })
      expect(result.success).toBe(true)
      // Simulate the next hook process: its in-memory cache starts empty, but
      // the short-lived disk stamp from guard must still unlock the edit.
      _resetDeliveredLedgerForTests()
      expect((await runWith({ file_path: file })).trim()).toBe('{}')
    } finally {
      for (const key of sessionEnv) {
        const value = previous.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test('runs the credential guard before edit memory decisions', async () => {
    const syntheticKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz'].join('-')
    const out = await runWith({
      file_path: '/abs/repo/.env',
      content: `OPENAI_API_KEY=${syntheticKey}`,
    })
    expect(out).toContain('permissionDecision')
    expect(out).toContain('deny')
    expect(out).toContain('credential guard')
  })

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

  // Fail-open is correct — a slow recall must never block an edit. Fail-open
  // SILENTLY is not: someone who chose 'strict' asked for a hard gate, and a
  // quiet pass lets them edit over a decision in force believing it cleared.
  test('conflictMode strict: reports a skipped gate as context, never a deny', async () => {
    process.env.PRJCT_CONFLICT_HARD_CAP_MS = '0'
    try {
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
      expect(out).toContain('conflict gate skipped')
      expect(out).toContain('NOT checked against decisions in force')
      expect(out).toContain('PRJCT_CONFLICT_HARD_CAP_MS')
      // Slowness must never block an edit.
      expect(out).not.toContain('permissionDecision')
    } finally {
      process.env.PRJCT_CONFLICT_HARD_CAP_MS = ROOMY_BUDGET
    }
  })

  test('a non-strict mode still passes quietly when the budget runs out', async () => {
    process.env.PRJCT_CONFLICT_HARD_CAP_MS = '0'
    try {
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
      expect(out).not.toContain('conflict gate skipped')
    } finally {
      process.env.PRJCT_CONFLICT_HARD_CAP_MS = ROOMY_BUDGET
    }
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

  test('heads-up dedupes per (session, file, trap-set) — no re-injection on every Edit', async () => {
    await projectMemory.remember(fixture.projectPath, {
      type: 'gotcha',
      content: 'this module mutates shared state — clone before writing',
      tags: { file: 'core/state.ts' },
    })
    const first = await runWith({ file_path: '/abs/repo/core/state.ts' }, 'sess-a')
    expect(first).toContain('heads-up before editing')
    // Same session, same file, same traps → silent.
    const second = await runWith({ file_path: '/abs/repo/core/state.ts' }, 'sess-a')
    expect(second.trim()).toBe('{}')
    // A different session still gets the heads-up.
    const otherSession = await runWith({ file_path: '/abs/repo/core/state.ts' }, 'sess-b')
    expect(otherSession).toContain('heads-up before editing')
    // A newly-recorded trap re-arms the heads-up for the original session.
    await projectMemory.remember(fixture.projectPath, {
      type: 'anti-pattern',
      content: 'never call init() twice here',
      tags: { file: 'core/state.ts' },
    })
    const rearmed = await runWith({ file_path: '/abs/repo/core/state.ts' }, 'sess-a')
    expect(rearmed).toContain('heads-up before editing')
    expect(rearmed).toContain('never call init() twice')
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
