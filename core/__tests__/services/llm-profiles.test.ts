/**
 * LLM multi-brain — profiles, keys, wires, merge, clear lifecycle, probes.
 * Hermetic: PRJCT_CLI_HOME + PRJCT_TEST_MODE (no real Keychain).
 */

import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LlmCommands } from '../../commands/llm'
import {
  clearAllLlmKeys,
  clearAllLlmProfiles,
  detectBrainFromBaseUrl,
  detectBrainFromKey,
  getActiveLlmProfile,
  getLlmKey,
  getLlmProfile,
  isOwnedLlmEnabled,
  isUsableCompletion,
  LLM_API_KEY_ENV,
  LLM_PROFILE_ENV,
  LOCAL_DUMMY_KEY,
  listLlmProfiles,
  normalizeMessageContent,
  OWNED_LLM_ENV,
  ProfileLlmProvider,
  parseAnthropicResponse,
  parseOpenAiChatResponse,
  profileImpliesWeakMode,
  profileKeyEnvName,
  removeLlmProfile,
  resetLlmKeyCache,
  setActiveLlmProfile,
  setLlmKey,
  setOwnedLlmEnabled,
  toAnthropicMessages,
  upsertLlmProfile,
} from '../../llm'

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'prjct-llm-'))
  const origHome = process.env.PRJCT_CLI_HOME
  const origTest = process.env.PRJCT_TEST_MODE
  const origKey = process.env[LLM_API_KEY_ENV]
  const origProf = process.env[LLM_PROFILE_ENV]
  const origOwned = process.env[OWNED_LLM_ENV]
  process.env.PRJCT_CLI_HOME = tmp
  process.env.PRJCT_TEST_MODE = '1'
  delete process.env[LLM_API_KEY_ENV]
  delete process.env[LLM_PROFILE_ENV]
  delete process.env[OWNED_LLM_ENV]
  resetLlmKeyCache()
  clearAllLlmProfiles()
  setOwnedLlmEnabled(true) // tests exercise the enabled surface
  try {
    return await fn(tmp)
  } finally {
    if (origHome === undefined) delete process.env.PRJCT_CLI_HOME
    else process.env.PRJCT_CLI_HOME = origHome
    if (origTest === undefined) delete process.env.PRJCT_TEST_MODE
    else process.env.PRJCT_TEST_MODE = origTest
    if (origKey === undefined) delete process.env[LLM_API_KEY_ENV]
    else process.env[LLM_API_KEY_ENV] = origKey
    if (origProf === undefined) delete process.env[LLM_PROFILE_ENV]
    else process.env[LLM_PROFILE_ENV] = origProf
    if (origOwned === undefined) delete process.env[OWNED_LLM_ENV]
    else process.env[OWNED_LLM_ENV] = origOwned
    for (const k of Object.keys(process.env)) {
      if (k.startsWith(`${LLM_API_KEY_ENV}_`)) delete process.env[k]
    }
    resetLlmKeyCache()
    await fsPromises.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

describe('detectBrainFromKey', () => {
  test('OpenRouter / Anthropic / OpenAI / xAI', () => {
    expect(detectBrainFromKey('sk-or-v1-abc')?.providerLabel).toBe('OpenRouter')
    expect(detectBrainFromKey('sk-ant-api03-xyz')?.wire).toBe('anthropic')
    expect(detectBrainFromKey('sk-proj-abc')?.providerLabel).toBe('OpenAI')
    expect(detectBrainFromKey('xai-abc')?.providerLabel).toBe('xAI')
  })
})

describe('detectBrainFromBaseUrl', () => {
  test('Ollama / LM Studio', () => {
    expect(detectBrainFromBaseUrl('http://localhost:11434/v1')?.weakHint).toBe(true)
    expect(detectBrainFromBaseUrl('http://127.0.0.1:1234')?.providerLabel).toBe('LM Studio')
  })
})

describe('profile merge + lifecycle', () => {
  test('partial set updates model keeps baseUrl', async () => {
    await withTempHome(async () => {
      upsertLlmProfile({
        name: 'ollama',
        wire: 'openai-compatible',
        providerLabel: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen3.5:4b',
        weak: true,
      })
      upsertLlmProfile({ name: 'ollama', model: 'other:7b' })
      const p = getLlmProfile('ollama')
      expect(p?.baseUrl).toBe('http://localhost:11434/v1')
      expect(p?.model).toBe('other:7b')
      expect(p?.weak).toBe(true)
    })
  })

  test('use switches active; env PRJCT_LLM_PROFILE overrides', async () => {
    await withTempHome(async () => {
      upsertLlmProfile({
        name: 'anthropic',
        wire: 'anthropic',
        providerLabel: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-20250514',
      })
      upsertLlmProfile({
        name: 'ollama',
        wire: 'openai-compatible',
        providerLabel: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen3.5:4b',
      })
      setActiveLlmProfile('anthropic')
      expect(getActiveLlmProfile()?.name).toBe('anthropic')
      process.env[LLM_PROFILE_ENV] = 'ollama'
      expect(getActiveLlmProfile()?.name).toBe('ollama')
    })
  })

  test('clear --all removes profiles and key files', async () => {
    await withTempHome(async (home) => {
      upsertLlmProfile({
        name: 'ollama',
        wire: 'openai-compatible',
        providerLabel: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen3.5:4b',
      })
      await setLlmKey('ollama', 'secret-abc')
      expect(await getLlmKey('ollama')).toBe('secret-abc')
      const names = clearAllLlmProfiles()
      expect(names).toContain('ollama')
      await clearAllLlmKeys(names)
      resetLlmKeyCache()
      expect(listLlmProfiles().profiles).toHaveLength(0)
      expect(await getLlmKey('ollama')).toBeNull()
      const keyDir = path.join(home, 'config', 'llm-keys')
      expect(
        fs.existsSync(keyDir) ? fs.readdirSync(keyDir).filter((f) => f.endsWith('.key')) : []
      ).toEqual([])
    })
  })

  test('remove one profile clears its key', async () => {
    await withTempHome(async () => {
      upsertLlmProfile({
        name: 'a',
        wire: 'openai-compatible',
        providerLabel: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
      })
      await setLlmKey('a', 'key-a')
      removeLlmProfile('a')
      const { clearLlmKey } = await import('../../llm')
      await clearLlmKey('a')
      resetLlmKeyCache()
      expect(await getLlmKey('a')).toBeNull()
    })
  })

  test('global env key only applies to active profile', async () => {
    await withTempHome(async () => {
      upsertLlmProfile({
        name: 'anthropic',
        wire: 'anthropic',
        providerLabel: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-x',
      })
      upsertLlmProfile({
        name: 'openai',
        wire: 'openai-compatible',
        providerLabel: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-x',
      })
      setActiveLlmProfile('anthropic')
      process.env[LLM_API_KEY_ENV] = 'global-env-key'
      expect(await getLlmKey('anthropic', { isActive: true })).toBe('global-env-key')
      // non-active must NOT get global env
      expect(await getLlmKey('openai', { isActive: false })).toBeNull()
      // per-profile env wins
      process.env[profileKeyEnvName('openai')] = 'openai-only'
      expect(await getLlmKey('openai', { isActive: false })).toBe('openai-only')
    })
  })

  test('weak explicit false disables localhost heuristic', async () => {
    await withTempHome(async () => {
      const p = upsertLlmProfile({
        name: 'local',
        wire: 'openai-compatible',
        providerLabel: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'big-model',
        weak: false,
      })
      expect(profileImpliesWeakMode(p)).toBe(false)
    })
  })
})

describe('parse + content normalize', () => {
  test('OpenAI content array + tool_calls', () => {
    const r = parseOpenAiChatResponse(
      {
        model: 'm',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: [{ type: 'text', text: 'hi' }],
              tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }],
            },
          },
        ],
      },
      'fb'
    )
    expect(r.content).toBe('hi')
    expect(r.tool_calls[0]?.function.name).toBe('read')
    expect(normalizeMessageContent([{ type: 'text', text: 'a' }, { text: 'b' }])).toBe('a\nb')
  })

  test('Anthropic parse + toAnthropicMessages merges tool results', () => {
    const packed = toAnthropicMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 't2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: 'r1' },
      { role: 'tool', tool_call_id: 't2', content: 'r2' },
    ])
    expect(packed.messages[0]?.role).toBe('user')
    expect(packed.messages[1]?.role).toBe('assistant')
    // consecutive tool → single user with two tool_results
    expect(packed.messages[2]?.role).toBe('user')
    const blocks = packed.messages[2]?.content as unknown[]
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks.length).toBe(2)

    const r = parseAnthropicResponse(
      {
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'x', name: 'bash', input: { c: 'ls' } },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      'fb'
    )
    expect(r.content).toBe('ok')
    expect(r.usage?.total_tokens).toBe(3)
  })

  test('isUsableCompletion', () => {
    expect(isUsableCompletion({ content: null, tool_calls: [], model: 'm' })).toBe(false)
    expect(isUsableCompletion({ content: '  ', tool_calls: [], model: 'm' })).toBe(false)
    expect(isUsableCompletion({ content: 'pong', tool_calls: [], model: 'm' })).toBe(true)
    expect(
      isUsableCompletion({
        content: null,
        tool_calls: [{ id: '1', type: 'function', function: { name: 'x', arguments: '{}' } }],
        model: 'm',
      })
    ).toBe(true)
  })
})

describe('ProfileLlmProvider', () => {
  test('openai-compatible generate + timeout body for local', async () => {
    await withTempHome(async () => {
      const profile = {
        name: 'mock',
        wire: 'openai-compatible' as const,
        providerLabel: 'Mock',
        baseUrl: 'http://localhost:11434/v1',
        model: 'mock-model',
      }
      const seenBody: Record<string, unknown> = {}
      const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
        Object.assign(seenBody, JSON.parse(String(init?.body ?? '{}')))
        return new Response(
          JSON.stringify({
            model: 'mock-model',
            choices: [{ message: { content: 'pong', role: 'assistant' } }],
          }),
          { status: 200 }
        )
      }) as typeof fetch

      const provider = new ProfileLlmProvider(profile, LOCAL_DUMMY_KEY, fetchImpl)
      const result = await provider.generate({
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
      })
      expect(result.content).toBe('pong')
      expect(seenBody.think).toBe(false)
      expect(seenBody.reasoning_effort).toBe('none')
    })
  })

  test('anthropic rejects missing key', async () => {
    const profile = {
      name: 'anthropic',
      wire: 'anthropic' as const,
      providerLabel: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-x',
    }
    const provider = new ProfileLlmProvider(profile, null)
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(/no API key/)
  })
})

describe('opt-in gate (default OFF = zero guest impact)', () => {
  test('default disabled; set blocked; enable unlocks; disable locks', async () => {
    await withTempHome(async (home) => {
      setOwnedLlmEnabled(false)
      delete process.env[OWNED_LLM_ENV]
      expect(isOwnedLlmEnabled()).toBe(false)

      const cmd = new LlmCommands()
      const blocked = await cmd.llm(
        'set --name x --base-url http://localhost:11434/v1 --model m',
        home,
        {}
      )
      expect(blocked.success).toBe(false)

      const st = await cmd.llm('status', home, {})
      expect(st.success).toBe(true)
      expect(st.enabled).toBe(false)

      const en = await cmd.llm('enable', home, {})
      expect(en.success).toBe(true)
      expect(isOwnedLlmEnabled()).toBe(true)

      const ok = await cmd.llm(
        'set --name ollama --base-url http://localhost:11434/v1 --model qwen3.5:4b',
        home,
        {}
      )
      expect(ok.success).toBe(true)

      await cmd.llm('disable', home, {})
      expect(isOwnedLlmEnabled()).toBe(false)
      const blockedAgain = await cmd.llm('set --name ollama --model other', home, {})
      expect(blockedAgain.success).toBe(false)
    })
  })

  test('PRJCT_OWNED_LLM=0 forces off even if config on', async () => {
    await withTempHome(async () => {
      setOwnedLlmEnabled(true)
      process.env[OWNED_LLM_ENV] = '0'
      expect(isOwnedLlmEnabled()).toBe(false)
    })
  })
})

describe('LlmCommands CLI', () => {
  test('set partial + clear requires --all + clear --all wipes keys', async () => {
    await withTempHome(async (home) => {
      const cmd = new LlmCommands()
      const r1 = await cmd.llm(
        'set --name ollama --base-url http://localhost:11434/v1 --model qwen3.5:4b',
        home,
        {}
      )
      expect(r1.success).toBe(true)

      const r2 = await cmd.llm('set --name ollama --model other:7b', home, {})
      expect(r2.success).toBe(true)
      expect(getLlmProfile('ollama')?.model).toBe('other:7b')
      expect(getLlmProfile('ollama')?.baseUrl).toBe('http://localhost:11434/v1')

      const bare = await cmd.llm('clear', home, {})
      expect(bare.success).toBe(false)

      const all = await cmd.llm('clear --all', home, { all: true })
      expect(all.success).toBe(true)
      expect(listLlmProfiles().profiles).toHaveLength(0)
      const keyDir = path.join(home, 'config', 'llm-keys')
      const leftovers = fs.existsSync(keyDir)
        ? fs.readdirSync(keyDir).filter((f) => f.endsWith('.key'))
        : []
      expect(leftovers).toEqual([])
    })
  })

  test('test fails on empty content', async () => {
    await withTempHome(async (home) => {
      const cmd = new LlmCommands()
      await cmd.llm(
        'set --name mock --base-url http://example.test/v1 --model m --wire openai-compatible',
        home,
        {}
      )
      expect(isUsableCompletion({ content: '', tool_calls: [], model: 'm' })).toBe(false)
    })
  })
})
