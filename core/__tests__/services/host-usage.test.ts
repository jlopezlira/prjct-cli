import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { collectProjectUsage } from '../../services/host-usage'
import { buildInferenceCostReport } from '../../services/inference-cost'
import { persistInferenceUsage, recordInferenceUsage } from '../../services/inference-usage'
import { resetPricingCache, seedPricingCatalog } from '../../services/model-pricing'
import { prjctDb } from '../../storage/database'
import { query } from '../../storage/query-helpers'

const fixture: {
  projectPath: string
  tmpRoot: string
  projectId: string
  home: string
} = {
  projectPath: '',
  tmpRoot: '',
  projectId: '',
  home: '',
}

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

describe('inference usage service', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-usage-root-'))
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-usage-project-'))
    fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-usage-home-'))
    fixture.projectId = `usage-${Math.random().toString(36).slice(2, 10)}`
    pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.tmpRoot, 'data'),
    })
    prjctDb.getDb(fixture.projectId)
    seedPricingCatalog({
      providers: { xai: { label: 'xAI' }, anthropic: { label: 'Anthropic' } },
      rates: [
        { prefix: 'grok-4.6', provider: 'xai', inputPerMillion: 2, outputPerMillion: 6 },
        {
          prefix: 'claude-sonnet-5',
          provider: 'anthropic',
          inputPerMillion: 2,
          outputPerMillion: 10,
        },
      ],
    })
  })

  afterEach(async () => {
    seedPricingCatalog(null)
    resetPricingCache()
    prjctDb.close()
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
    await fs.rm(fixture.home, { recursive: true, force: true })
  })

  it('records whatever model + tokens the caller passes — no host names required', () => {
    recordInferenceUsage(fixture.projectId, 'task-1', {
      model: 'any-new-vendor/titan-9',
      tokensIn: 1000,
      tokensOut: 20,
      measuredAt: Date.now(),
      host: 'mcp',
      sessionId: 's1',
    })
    const rows = query<{ model_id: string; input_tokens: number; output_tokens: number }>(
      fixture.projectId,
      'SELECT model_id, input_tokens, output_tokens FROM token_usage'
    )
    expect(rows).toEqual([
      { model_id: 'any-new-vendor/titan-9', input_tokens: 1000, output_tokens: 20 },
    ])
  })

  it('collects Claude, Grok, Codex, and Kimi logs for this project into the same shape', async () => {
    const claudeDir = path.join(
      fixture.home,
      '.claude',
      'projects',
      fixture.projectPath.replace(/[/.]/g, '-')
    )
    await fs.mkdir(claudeDir, { recursive: true })
    await fs.writeFile(
      path.join(claudeDir, 'sess-claude.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-08-20T12:00:00.000Z',
        message: {
          model: 'claude-sonnet-5',
          usage: { input_tokens: 2000, output_tokens: 100 },
        },
      })}\n`
    )

    const grokDir = path.join(
      fixture.home,
      '.grok',
      'sessions',
      encodeURIComponent(fixture.projectPath),
      'sess-grok'
    )
    await fs.mkdir(grokDir, { recursive: true })
    await fs.writeFile(
      path.join(grokDir, 'summary.json'),
      JSON.stringify({ current_model_id: 'grok-4.6', last_active_at: '2026-08-20T12:00:00.000Z' })
    )
    await fs.writeFile(
      path.join(grokDir, 'signals.json'),
      JSON.stringify({ primaryModelId: 'grok-4.6', totalTokensBeforeCompaction: 50_000 })
    )

    const codexDir = path.join(fixture.home, '.codex', 'sessions', '2026', '08')
    await fs.mkdir(codexDir, { recursive: true })
    await fs.writeFile(
      path.join(codexDir, 'rollout.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-08-20T12:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'sess-codex', cwd: fixture.projectPath, model: 'gpt-5.4' },
        }),
        JSON.stringify({
          timestamp: '2026-08-20T12:01:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 3000,
                output_tokens: 40,
                reasoning_output_tokens: 10,
              },
            },
          },
        }),
      ].join('\n')
    )

    const kimiDir = path.join(
      fixture.home,
      '.kimi-code',
      'sessions',
      'wd_proj',
      'session_kimi',
      'agents',
      'main'
    )
    await fs.mkdir(kimiDir, { recursive: true })
    await fs.writeFile(
      path.join(fixture.home, '.kimi-code', 'sessions', 'wd_proj', 'session_kimi', 'state.json'),
      JSON.stringify({ id: 'session_kimi', cwd: fixture.projectPath })
    )
    await fs.writeFile(
      path.join(kimiDir, 'wire.jsonl'),
      `${JSON.stringify({
        type: 'usage.record',
        model: 'kimi-code/k3',
        usage: { inputOther: 400, output: 80, inputCacheRead: 0, inputCacheCreation: 0 },
        usageScope: 'turn',
        time: Date.parse('2026-08-20T12:00:00.000Z'),
      })}\n`
    )

    const usages = await collectProjectUsage(fixture.projectPath, fixture.home)
    const byHost = Object.fromEntries(usages.map((u) => [u.host, u]))
    expect(byHost.claude?.model).toBe('claude-sonnet-5')
    expect(byHost.claude?.tokensIn).toBe(2000)
    expect(byHost.claude?.tokensOut).toBe(100)
    expect(byHost.grok?.model).toBe('grok-4.6')
    expect(byHost.grok?.tokensIn).toBe(50_000)
    expect(byHost.codex?.model).toBe('gpt-5.4')
    expect(byHost.codex?.tokensIn).toBe(3000)
    expect(byHost.codex?.tokensOut).toBe(50)
    expect(byHost.kimi?.model).toBe('kimi-code/k3')
    expect(byHost.kimi?.tokensIn).toBe(400)
    expect(byHost.kimi?.tokensOut).toBe(80)

    persistInferenceUsage(fixture.projectId, usages)
    const report = buildInferenceCostReport(fixture.projectId, { days: null })
    expect(report.byModel.length).toBe(4)
    expect(report.byProvider.length).toBeGreaterThanOrEqual(2)
  })
})
