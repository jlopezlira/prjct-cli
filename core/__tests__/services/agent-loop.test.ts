/**
 * Owned agent loop + path safety + mock LLM tool calls.
 */

import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildSystemPrompt, resolveSafePath, runAgent } from '../../agent'
import { PathDeniedError } from '../../agent/paths'
import type { ChatCompletionResult, LlmGenerateOptions, LlmProfile, LlmProvider } from '../../llm'

function mockProvider(
  script: Array<(opts: LlmGenerateOptions) => ChatCompletionResult>,
  profile?: Partial<LlmProfile>
): LlmProvider {
  const p: LlmProfile = {
    name: 'mock',
    wire: 'openai-compatible',
    providerLabel: 'Mock',
    baseUrl: 'http://mock.test/v1',
    model: 'mock-model',
    ...profile,
  }
  const calls: LlmGenerateOptions[] = []
  return {
    profile: p,
    async generate(opts: LlmGenerateOptions) {
      const fn = script[calls.length] ?? script[script.length - 1]
      calls.push(opts)
      return fn!(opts)
    },
  }
}

describe('resolveSafePath', () => {
  test('allows relative under root; denies escape and secrets', async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'prjct-agent-path-'))
    try {
      expect(resolveSafePath(root, 'src/a.ts')).toBe(path.join(root, 'src/a.ts'))
      expect(() => resolveSafePath(root, '../outside')).toThrow(PathDeniedError)
      expect(() => resolveSafePath(root, '.env')).toThrow(PathDeniedError)
      expect(() => resolveSafePath(root, 'secrets/id_rsa')).toThrow(PathDeniedError)
    } finally {
      await fsPromises.rm(root, { recursive: true, force: true })
    }
  })
})

describe('runAgent', () => {
  test('tool loop: read → edit → final summary', async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'prjct-agent-run-'))
    const file = path.join(root, 'hello.ts')
    fs.writeFileSync(file, 'export const x = 1\n', 'utf-8')

    const provider = mockProvider([
      () => ({
        content: null,
        tool_calls: [
          {
            id: '1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ path: 'hello.ts' }) },
          },
        ],
        model: 'mock-model',
      }),
      () => ({
        content: null,
        tool_calls: [
          {
            id: '2',
            type: 'function',
            function: {
              name: 'edit',
              arguments: JSON.stringify({
                path: 'hello.ts',
                old_string: 'export const x = 1',
                new_string: 'export const x = 2',
              }),
            },
          },
        ],
        model: 'mock-model',
      }),
      () => ({
        content: 'Updated hello.ts so x is 2.',
        tool_calls: [],
        model: 'mock-model',
      }),
    ])

    try {
      const result = await runAgent({
        intent: 'Change x to 2 in hello.ts',
        root,
        provider,
        maxSteps: 8,
      })
      expect(result.success).toBe(true)
      expect(result.toolCalls).toBe(2)
      expect(result.content).toContain('x is 2')
      expect(fs.readFileSync(file, 'utf-8')).toContain('x = 2')
    } finally {
      await fsPromises.rm(root, { recursive: true, force: true })
    }
  })

  test('write creates file', async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'prjct-agent-write-'))
    const provider = mockProvider([
      () => ({
        content: null,
        tool_calls: [
          {
            id: '1',
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({ path: 'src/new.ts', content: 'export const n = 1\n' }),
            },
          },
        ],
        model: 'mock',
      }),
      () => ({
        content: 'Created src/new.ts',
        tool_calls: [],
        model: 'mock',
      }),
    ])
    try {
      const result = await runAgent({ intent: 'create file', root, provider })
      expect(result.success).toBe(true)
      expect(fs.readFileSync(path.join(root, 'src/new.ts'), 'utf-8')).toContain('n = 1')
    } finally {
      await fsPromises.rm(root, { recursive: true, force: true })
    }
  })

  test('system prompt includes root and prjct tools guidance', () => {
    const p = buildSystemPrompt('/tmp/proj')
    expect(p).toContain('/tmp/proj')
    expect(p).toContain('prjct_search')
    expect(p).toContain('prjct_guard')
  })

  test('default tools include prjct body tools', async () => {
    const { defaultTools } = await import('../../agent')
    const names = defaultTools().map((t) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('prjct_search')
    expect(names).toContain('prjct_guard')
    expect(names).toContain('prjct_remember')
    expect(names).toContain('prjct_work')
  })

  test('weakModelAppend only for weak profiles', async () => {
    const { weakModelAppend } = await import('../../agent')
    expect(
      weakModelAppend({
        name: 'o',
        wire: 'openai-compatible',
        providerLabel: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen',
      })
    ).toContain('Weak-model')
    expect(
      weakModelAppend({
        name: 'a',
        wire: 'anthropic',
        providerLabel: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet',
        weak: false,
      })
    ).toBe('')
  })

  test('prepareOwnedAgentWorkContext noWork skips start', async () => {
    const { prepareOwnedAgentWorkContext } = await import('../../agent')
    const ctx = await prepareOwnedAgentWorkContext({
      root: '/tmp/not-a-prjct-project-xyz',
      intent: 'do something',
      profile: {
        name: 'm',
        wire: 'openai-compatible',
        providerLabel: 'Mock',
        baseUrl: 'http://x',
        model: 'm',
      },
      noWork: true,
    })
    expect(ctx.workStarted).toBe(false)
    expect(ctx.root).toBe('/tmp/not-a-prjct-project-xyz')
  })
})
