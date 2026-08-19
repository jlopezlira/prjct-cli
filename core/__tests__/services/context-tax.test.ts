/**
 * Context-tax doctor section — per-host catalog cost and marathon-session
 * signal, parsed from the hosts' own session logs (kimi wire.jsonl, codex
 * rollouts) under PRJCT_TEST_MODE fixture homes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { collectContextTax, contextTaxChecks } from '../../services/context-tax'
import { getCodexConfigTomlPath } from '../../utils/codex-mcp'
import { getKimiMcpConfigPaths } from '../../utils/kimi-mcp'

const state: { kimiHome: string; codexHome: string } = { kimiHome: '', codexHome: '' }

beforeEach(async () => {
  process.env.PRJCT_TEST_MODE = '1'
  state.kimiHome = path.dirname(getKimiMcpConfigPaths()[0]!)
  state.codexHome = path.dirname(getCodexConfigTomlPath())
  await fs.rm(path.join(state.kimiHome, 'sessions'), { recursive: true, force: true })
  await fs.rm(path.join(state.codexHome, 'sessions'), { recursive: true, force: true })
})

afterEach(async () => {
  await fs.rm(path.join(state.kimiHome, 'sessions'), { recursive: true, force: true })
  await fs.rm(path.join(state.codexHome, 'sessions'), { recursive: true, force: true })
  delete process.env.PRJCT_TEST_MODE
})

async function seedKimiSession(opts: { turns: number; tokensPerTurn: number }): Promise<void> {
  const dir = path.join(state.kimiHome, 'sessions', 'wd_test', 'session_1', 'agents', 'main')
  await fs.mkdir(dir, { recursive: true })
  const bigDescription = 'x'.repeat(9000)
  const lines = [
    JSON.stringify({
      type: 'llm.tools_snapshot',
      tools: [
        { name: 'mcp__prjct__prjct_mem_save', description: 'save', inputSchema: {} },
        { name: 'mcp__heavy-mcp__do_everything', description: bigDescription, inputSchema: {} },
        { name: 'Bash', description: 'native shell', inputSchema: {} },
      ],
    }),
    ...Array.from({ length: opts.turns }, () =>
      JSON.stringify({
        type: 'usage.record',
        usageScope: 'turn',
        usage: { inputOther: opts.tokensPerTurn, inputCacheRead: 0, output: 10 },
      })
    ),
  ]
  await fs.writeFile(path.join(dir, 'wire.jsonl'), `${lines.join('\n')}\n`)
}

async function seedCodexSession(opts: { turns: number; tokensPerTurn: number }): Promise<void> {
  await fs.mkdir(state.codexHome, { recursive: true })
  await fs.writeFile(
    getCodexConfigTomlPath(),
    '[mcp_servers.prjct]\ncommand = "node"\n\n[mcp_servers.context7]\ncommand = "npx"\n'
  )
  const dir = path.join(state.codexHome, 'sessions', '2026', '08', '19')
  await fs.mkdir(dir, { recursive: true })
  const lines = Array.from({ length: opts.turns }, () =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: opts.tokensPerTurn, output_tokens: 20 } },
      },
    })
  )
  await fs.writeFile(
    path.join(dir, 'rollout-2026-08-19T10-00-00-test.jsonl'),
    `${lines.join('\n')}\n`
  )
}

describe('context tax collection', () => {
  it('reports kimi per-server catalog and flags heavy servers', async () => {
    await seedKimiSession({ turns: 5, tokensPerTurn: 1000 })
    const taxes = await collectContextTax()
    const kimi = taxes.find((t) => t.host === 'kimi')
    expect(kimi).toBeDefined()
    const heavy = kimi!.servers.find((s) => s.server === 'mcp:heavy-mcp')
    expect(heavy!.approxTokens).toBeGreaterThan(2000)
    const checks = contextTaxChecks(taxes)
    const catalog = checks.find((c) => c.name === 'kimi catalog')
    expect(catalog?.status).toBe('warn')
    expect(catalog?.message).toContain('heavy: mcp:heavy-mcp')
  })

  it('flags marathon sessions as a signal (never auto-kill wording)', async () => {
    await seedCodexSession({ turns: 200, tokensPerTurn: 120_000 })
    const taxes = await collectContextTax()
    const codex = taxes.find((t) => t.host === 'codex')
    expect(codex?.marathonSessions).toBe(1)
    const sessionCheck = contextTaxChecks(taxes).find((c) => c.name === 'codex sessions')
    expect(sessionCheck?.status).toBe('warn')
    expect(sessionCheck?.message).toContain('Signal only')
    expect(sessionCheck?.message).toContain('prjct land')
  })

  it('small sessions and light catalogs stay ok', async () => {
    await seedCodexSession({ turns: 10, tokensPerTurn: 5_000 })
    const taxes = await collectContextTax()
    const sessionCheck = contextTaxChecks(taxes).find((c) => c.name === 'codex sessions')
    expect(sessionCheck?.status).toBe('ok')
  })
})
