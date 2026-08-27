/**
 * End-to-end proof for sync-built repository patterns.
 *
 * Exercises the real CLI in separate processes against a hermetic git repo:
 * sync samples source → structured analysis becomes ProjectStyle → Codex prompt
 * receives only the relevant pattern → blind edit is denied → Read unlocks it.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { makeSandbox, type Sandbox } from './_harness'

setDefaultTimeout(120_000)

const fixture: { sb: Sandbox } = { sb: undefined as unknown as Sandbox }
const SESSION_ID = 'repository-pattern-e2e-session'

function hookInput(input: Record<string, unknown>): string {
  return JSON.stringify({ session_id: SESSION_ID, ...input })
}

function modelContext(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return trimmed
  const parsed = JSON.parse(trimmed) as {
    additional_context?: string
    hookSpecificOutput?: { additionalContext?: string; additional_context?: string }
    systemMessage?: string
  }
  return (
    parsed.hookSpecificOutput?.additionalContext ??
    parsed.hookSpecificOutput?.additional_context ??
    parsed.additional_context ??
    parsed.systemMessage ??
    ''
  )
}

async function writeFixtureRepository(sb: Sandbox): Promise<void> {
  await fs.mkdir(path.join(sb.dir, 'src', 'storage'), { recursive: true })
  await fs.mkdir(path.join(sb.dir, 'src', 'commands'), { recursive: true })
  await fs.mkdir(path.join(sb.dir, 'src', 'components'), { recursive: true })
  await fs.mkdir(path.join(sb.dir, 'test'), { recursive: true })
  await fs.writeFile(
    path.join(sb.dir, 'src', 'storage', 'order-store.ts'),
    [
      "import { database } from './database'",
      '',
      'export async function saveOrder(order: Order): Promise<void> {',
      '  await database.withTransaction(async (transaction) => {',
      '    await transaction.orders.insert(order)',
      '  })',
      '}',
      '',
    ].join('\n')
  )
  await fs.writeFile(
    path.join(sb.dir, 'src', 'commands', 'create-order.ts'),
    [
      "import { saveOrder } from '../storage/order-store'",
      '',
      'export async function createOrder(input: Input): Promise<CommandResult> {',
      '  await saveOrder(toOrder(input))',
      "  return { success: true, value: 'created' }",
      '}',
      '',
    ].join('\n')
  )
  await fs.writeFile(
    path.join(sb.dir, 'src', 'components', 'order-card.tsx'),
    'export function OrderCard() { return <section>Order</section> }\n'
  )
  await fs.writeFile(
    path.join(sb.dir, 'test', 'create-order.test.ts'),
    "describe('createOrder', () => { it('delegates storage', async () => expect(true).toBe(true)) })\n"
  )
}

beforeAll(async () => {
  fixture.sb = await makeSandbox()
  await writeFixtureRepository(fixture.sb)
  const init = await fixture.sb.cli(['init'], { timeoutMs: 90_000 })
  expect(init.code).toBe(0)
  const setup = await fixture.sb.cli(['setup'], { timeoutMs: 90_000 })
  expect(setup.code).toBe(0)
})

afterAll(async () => {
  await fixture.sb.cleanup()
})

describe('e2e: sync-built task-relevant repository patterns', () => {
  test('sync samples multiple pattern lanes instead of one generic file list', async () => {
    const sync = await fixture.sb.cli(['sync', '--md'], { timeoutMs: 90_000 })
    const output = sync.stdout + sync.stderr

    if (sync.code !== 0) {
      throw new Error(
        `sync failed (${sync.code})\nSTDOUT:\n${sync.stdout}\nSTDERR:\n${sync.stderr}`
      )
    }
    expect(output).toContain('## Analysis Payload')
    expect(output).toContain('pattern lane: testing')
    expect(output).toContain('pattern lane: data-access')
  })

  test('real Codex hooks retrieve the relevant synced pattern and enforce inspection', async () => {
    const analysisPath = path.join(fixture.sb.dir, 'prjct-analysis.json')
    await fs.writeFile(
      analysisPath,
      JSON.stringify({
        version: 1,
        commitHash: 'fixture-head',
        analyzedAt: '2026-08-27T00:00:00.000Z',
        architecture: {
          style: 'layered-service',
          insights: ['Commands orchestrate; storage owns transactions.'],
          domains: ['commands', 'storage'],
        },
        patterns: [
          {
            name: 'Transactional storage boundary',
            description: 'Storage modules own transactions; commands delegate persistence.',
            locations: ['src/storage'],
            category: 'persistence',
            confidence: 0.98,
          },
          {
            name: 'UI component composition',
            description: 'UI pages compose small visual components.',
            locations: ['src/components'],
            category: 'frontend',
            confidence: 0.95,
          },
        ],
        antiPatterns: [
          {
            issue: 'Database calls inside commands',
            reasoning: 'They bypass the storage transaction boundary.',
            files: ['src/commands'],
            suggestion: 'Delegate persistence to the matching storage module.',
            severity: 'high',
            confidence: 0.99,
          },
        ],
        techDebt: [],
        riskAreas: [],
        refactorSuggestions: [],
        projectInsights: [],
        conventions: [
          {
            category: 'command-result',
            rule: 'Commands return CommandResult at the public boundary.',
            example: "return { success: true, value: 'created' }",
          },
        ],
      })
    )
    const saved = await fixture.sb.cli(['analysis-save-llm', analysisPath, '--md'])
    expect(saved.code).toBe(0)

    const hookEnv = { PRJCT_HOOK_HOST: 'codex' }
    const prompt = await fixture.sb.cli(['hook', 'prompt'], {
      env: hookEnv,
      stdin: hookInput({
        prompt: 'Fix the order database transaction in the create-order command',
      }),
    })
    expect(prompt.code).toBe(0)
    const context = modelContext(prompt.stdout)
    expect(context).toContain('Transactional storage boundary')
    expect(context).toContain('Storage modules own transactions')
    expect(context).toContain('src/storage')
    expect(context).not.toContain('UI component composition')
    expect(context.length).toBeLessThanOrEqual(700)

    const target = path.join(fixture.sb.dir, 'src', 'commands', 'create-order.ts')
    const blindEdit = await fixture.sb.cli(['hook', 'pre-edit'], {
      env: hookEnv,
      stdin: hookInput({ tool_name: 'Edit', tool_input: { file_path: target } }),
    })
    if (blindEdit.code !== 0 || !blindEdit.stdout.includes('source-first gate')) {
      throw new Error(
        `blind edit was not denied (${blindEdit.code})\nSTDOUT:\n${blindEdit.stdout}\nSTDERR:\n${blindEdit.stderr}`
      )
    }
    expect(blindEdit.stdout).toContain('source-first gate')
    expect(blindEdit.stdout).toContain('permissionDecision')
    expect(blindEdit.stdout).not.toContain('Synced house patterns for this file')
    expect(blindEdit.stdout).not.toContain('Database calls inside commands')

    const read = await fixture.sb.cli(['hook', 'post-read'], {
      env: hookEnv,
      stdin: hookInput({ tool_name: 'Read', tool_input: { file_path: target } }),
    })
    expect(read.code).toBe(0)

    const inspectedEdit = await fixture.sb.cli(['hook', 'pre-edit'], {
      env: hookEnv,
      stdin: hookInput({ tool_name: 'Edit', tool_input: { file_path: target } }),
    })
    expect(inspectedEdit.code).toBe(0)
    expect(inspectedEdit.stdout.trim()).toBe('{}')

    const nextMessage = await fixture.sb.cli(['hook', 'prompt'], {
      env: hookEnv,
      stdin: hookInput({ prompt: 'Now adjust the order UI component' }),
    })
    expect(nextMessage.code).toBe(0)
    const nextContext = modelContext(nextMessage.stdout)
    expect(nextContext).not.toContain('# prjct: repository alignment')
    expect(nextContext).not.toContain('UI component composition')

    // The prompt did not repeat repository context, so a blind edit may carry
    // it once as recovery guidance. A second denied edit in the same turn may not.
    const storageTarget = path.join(fixture.sb.dir, 'src', 'storage', 'order-store.ts')
    const firstStorageEdit = await fixture.sb.cli(['hook', 'pre-edit'], {
      env: hookEnv,
      stdin: hookInput({ tool_name: 'Edit', tool_input: { file_path: storageTarget } }),
    })
    expect(firstStorageEdit.stdout).toContain('source-first gate')
    expect(firstStorageEdit.stdout).toContain('Synced house patterns for this file')
    expect(firstStorageEdit.stdout).toContain('Transactional storage boundary')

    const repeatedStorageEdit = await fixture.sb.cli(['hook', 'pre-edit'], {
      env: hookEnv,
      stdin: hookInput({ tool_name: 'Edit', tool_input: { file_path: storageTarget } }),
    })
    expect(repeatedStorageEdit.stdout).toContain('source-first gate')
    expect(repeatedStorageEdit.stdout).not.toContain('Synced house patterns for this file')
    expect(repeatedStorageEdit.stdout).not.toContain('Transactional storage boundary')
  })
})
