import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HookIo } from '../../hooks/_runner'
import { runPostEditHook } from '../../hooks/post-edit'
import configManager from '../../infrastructure/config-manager'
import { _resetDeliveredLedgerForTests } from '../../services/session-context-cache'
import prjctDb from '../../storage/database'

const fixture = { projectPath: '', projectId: '', sessionId: '' }

beforeEach(async () => {
  _resetDeliveredLedgerForTests()
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-post-edit-comments-'))
  fixture.projectId = `comments-${Math.random().toString(36).slice(2, 10)}`
  fixture.sessionId = `session-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
})

afterEach(async () => {
  await fs.rm(fixture.projectPath, { recursive: true, force: true })
  prjctDb.close()
})

async function drive(input: Record<string, unknown>): Promise<string> {
  const chunks: string[] = []
  await runPostEditHook(fixture.projectPath, {
    input,
    sink: (chunk) => chunks.push(chunk),
    detachAfterEmit: (_fn) => undefined,
  } satisfies HookIo)
  const parsed = JSON.parse(chunks.join('').trim()) as {
    hookSpecificOutput?: { additionalContext?: string }
  }
  return parsed.hookSpecificOutput?.additionalContext ?? ''
}

function verboseComment(): string {
  return [
    '/*',
    ' * First read the account record from the database using its identifier.',
    ' * Then check whether the account is enabled and belongs to the tenant.',
    ' * Next calculate the amount that should be charged for this transaction.',
    ' * After calculating the amount create a request for the payment provider.',
    ' * Wait for the provider response and transform it into the internal shape.',
    ' * Finally return that transformed response to the original caller.',
    ' */',
    'export function chargeAccount() {}',
  ].join('\n')
}

describe('post-edit comment discipline', () => {
  it('surfaces a suspicious added comment once per session and signal', async () => {
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: 'src/billing.ts', new_string: verboseComment() },
      session_id: fixture.sessionId,
    }
    const first = await drive(input)
    expect(first).toContain('# prjct: comment signal')
    expect(first).toContain('intent, invariants')
    expect(first).toContain('comment-discipline')

    _resetDeliveredLedgerForTests()
    const repeated = await drive({
      ...input,
      tool_input: { file_path: 'src/another-file.ts', new_string: verboseComment() },
    })
    expect(repeated).toBe('')
  })

  it('keeps normal edits silent', async () => {
    const output = await drive({
      tool_name: 'Write',
      tool_input: {
        file_path: 'src/retry.ts',
        content:
          '// Keep the idempotency key stable across retries.\nexport const key = request.id\n',
      },
      session_id: fixture.sessionId,
    })
    expect(output).toBe('')
  })

  it('does not blame a Write for verbose comments that already existed', async () => {
    const runGit = (...args: string[]) =>
      spawnSync('git', args, { cwd: fixture.projectPath, encoding: 'utf8' })
    expect(runGit('init', '-q').status).toBe(0)
    expect(runGit('config', 'user.email', 'test@example.com').status).toBe(0)
    expect(runGit('config', 'user.name', 'Test').status).toBe(0)

    const filePath = path.join(fixture.projectPath, 'src', 'legacy.ts')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, verboseComment())
    expect(runGit('add', 'src/legacy.ts').status).toBe(0)
    expect(runGit('commit', '-q', '-m', 'fixture').status).toBe(0)

    const rewritten = `${verboseComment()}\nexport const retryLimit = 3\n`
    await fs.writeFile(filePath, rewritten)
    const output = await drive({
      tool_name: 'Write',
      tool_input: { file_path: 'src/legacy.ts', content: rewritten },
      session_id: fixture.sessionId,
    })
    expect(output).toBe('')
  })
})
