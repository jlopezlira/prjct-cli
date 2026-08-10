/**
 * Zero-config provider detection + partial-update preservation for global
 * embeddings. Pasting just `--key sk-or-…` should infer the OpenRouter base
 * URL; a later `set --model …` must not silently reset the provider.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  detectBaseUrlFromKey,
  resolveGlobalEmbeddings,
  setGlobalEmbeddings,
} from '../../services/embeddings'

describe('detectBaseUrlFromKey', () => {
  test('OpenRouter key → openrouter.ai', () => {
    expect(detectBaseUrlFromKey('sk-or-v1-abcdef')).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      provider: 'OpenRouter',
    })
  })

  test('OpenAI key → api.openai.com (and is not mistaken for OpenRouter)', () => {
    expect(detectBaseUrlFromKey('sk-proj-abcdef')?.baseUrl).toBe('https://api.openai.com/v1')
    expect(detectBaseUrlFromKey('sk-abcdef')?.provider).toBe('OpenAI')
  })

  test('Anthropic key → undefined (no embeddings endpoint, not routed to OpenAI)', () => {
    expect(detectBaseUrlFromKey('sk-ant-api03-xyz')).toBeUndefined()
  })

  test('Voyage key → voyageai', () => {
    expect(detectBaseUrlFromKey('pa-xyz')?.provider).toBe('Voyage')
  })

  test('unknown prefix → undefined (caller keeps default/existing)', () => {
    expect(detectBaseUrlFromKey('xoxb-not-a-key')).toBeUndefined()
    expect(detectBaseUrlFromKey('gsk_groq')).toBeUndefined()
  })
})

describe('setGlobalEmbeddings partial-update preservation', () => {
  const fixture: {
    tmp: string
    orig: string | undefined
  } = {
    tmp: '',
    orig: undefined as unknown as string | undefined,
  }

  beforeEach(async () => {
    fixture.tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-embset-'))
    fixture.orig = process.env.PRJCT_CLI_HOME
    process.env.PRJCT_CLI_HOME = fixture.tmp
  })
  afterEach(async () => {
    if (fixture.orig === undefined) delete process.env.PRJCT_CLI_HOME
    else process.env.PRJCT_CLI_HOME = fixture.orig
    await fs.rm(fixture.tmp, { recursive: true, force: true }).catch(() => undefined)
  })

  test('first config seeds defaults; later partial set preserves them', () => {
    setGlobalEmbeddings({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'text-embedding-3-small',
    })
    // A later set that only changes the model must keep the base URL.
    setGlobalEmbeddings({ model: 'text-embedding-3-large' })
    const g = resolveGlobalEmbeddings()
    expect(g?.baseUrl).toBe('https://openrouter.ai/api/v1')
    // Base URL preserved across the partial set; the model is namespaced for
    // OpenRouter (bare id → `openai/…`).
    expect(g?.model).toBe('openai/text-embedding-3-large')
  })

  test('a set with neither base URL nor model on first config uses defaults', () => {
    setGlobalEmbeddings({})
    const g = resolveGlobalEmbeddings()
    expect(g?.baseUrl).toBe('https://api.openai.com/v1')
    expect(g?.model).toBe('text-embedding-3-small')
  })
})
