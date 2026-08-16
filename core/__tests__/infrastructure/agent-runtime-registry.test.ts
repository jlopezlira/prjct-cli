import { describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  type AgentRuntimeId,
  detectAgentRuntimes,
  getAgentRuntime,
  listAgentRuntimes,
} from '../../infrastructure/agent-runtime-registry'

describe('agent runtime registry', () => {
  it('keeps AGENTS.md as the universal baseline', () => {
    const universal = getAgentRuntime('agents-md')

    expect(universal.supports.agentsMd).toBe(true)
    expect(universal.contextFiles).toContain('AGENTS.md')
  })

  it('tracks modern coding-agent runtimes beyond the original provider list', () => {
    const ids = new Set(listAgentRuntimes().map((runtime) => runtime.id))

    const expectedRuntimes: AgentRuntimeId[] = [
      'opencode',
      'pi',
      'qwen-code',
      'kimi-cli',
      'grok',
      'goose',
      'aider',
      'cline',
      'roo-code',
      'continue',
      'kiro',
      'copilot',
      'devin',
      'jules',
      'zed',
      'amp',
    ]

    for (const id of expectedRuntimes) {
      expect(ids.has(id)).toBe(true)
    }
  })

  it('exposes a writable MCP target for Kimi Code CLI (~/.kimi-code/mcp.json)', () => {
    const kimi = getAgentRuntime('kimi-cli')

    expect(kimi.displayName).toBe('Kimi Code CLI')
    expect(kimi.supports.mcp).toBe(true)
    expect(kimi.supports.hooks).toBe(true)
    expect(kimi.supports.skills).toBe(true)
    expect(kimi.detectsBy?.homeDirs?.[0]).toBe('.kimi-code')
    expect(kimi.detectsBy?.homeDirs).toContain('.kimi')
    const writable = (kimi.mcpTargets ?? []).filter((target) => target.writable)
    expect(writable.length).toBeGreaterThan(0)
    expect(writable[0]?.pathHint).toContain('.kimi-code/mcp.json')
  })

  it('exposes a writable OpenCode MCP target and full support for Pi skill path', () => {
    const opencode = getAgentRuntime('opencode')
    expect(opencode.supports.mcp).toBe(true)
    expect(opencode.supports.skills).toBe(true)
    const writable = (opencode.mcpTargets ?? []).filter((t) => t.writable)
    expect(writable.length).toBeGreaterThan(0)
    expect(writable[0]?.pathHint).toContain('opencode')

    const pi = getAgentRuntime('pi')
    expect(pi.kind).toBe('cli')
    expect(pi.status).toBe('stable')
    expect(pi.supports.agentsMd).toBe(true)
    expect(pi.supports.skills).toBe(true)
    expect(pi.supports.mcp).toBe(false)
    expect(pi.detectsBy?.commands).toContain('pi')
  })

  it('registers xAI Grok Build with native writable ~/.grok/config.toml MCP', () => {
    const grok = getAgentRuntime('grok')

    expect(grok.kind).toBe('cli')
    expect(grok.status).toBe('stable')
    expect(grok.supports.agentsMd).toBe(true)
    expect(grok.supports.mcp).toBe(true)
    expect(grok.supports.skills).toBe(true)
    expect(grok.supports.hooks).toBe(true)
    expect(grok.detectsBy?.commands).toContain('grok')
    const writable = (grok.mcpTargets ?? []).filter((target) => target.writable)
    expect(writable.some((t) => t.pathHint.includes('.grok/config.toml'))).toBe(true)
    expect(writable.some((t) => t.pathHint.includes('.claude/mcp.json'))).toBe(true)
  })

  it('marks Codex and Gemini as hook-capable (install adapters planned)', () => {
    expect(getAgentRuntime('codex').supports.hooks).toBe(true)
    expect(getAgentRuntime('gemini').supports.hooks).toBe(true)
  })

  it('separates runtime compatibility from model/provider names', () => {
    const qwen = getAgentRuntime('qwen-code')

    expect(qwen.kind).toBe('model-runtime')
    expect(qwen.notes).toContain('model/provider choice')
    expect(qwen.supports.mcp).toBe(true)
  })

  it('detects project surfaces and reports support levels from the registry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-runtime-registry-test-'))
    try {
      await fs.mkdir(path.join(dir, '.cursor'), { recursive: true })
      await fs.writeFile(path.join(dir, '.aider.conf.yml'), 'auto-commits: false\n')

      const statuses = await detectAgentRuntimes(dir)
      const byId = new Map(statuses.map((status) => [status.runtime.id, status]))

      expect(byId.get('agents-md')?.detected).toBe(true)
      expect(byId.get('mcp')?.supportLevel).toBe('manual')
      expect(byId.get('cursor')?.detectedSignals).toContain('.cursor/')
      // Benchmark-tier runtimes get full support investment (2026-07).
      expect(byId.get('cursor')?.supportLevel).toBe('full')
      expect(byId.get('aider')?.detectedSignals).toContain('.aider.conf.yml')
      expect(byId.get('aider')?.supportLevel).toBe('baseline')
      expect(byId.get('grok')?.supportLevel).toBe('full')
      expect(byId.get('claude')?.supportLevel).toBe('full')
      expect(byId.get('opencode')?.supportLevel).toBe('full')
      expect(byId.get('pi')?.supportLevel).toBe('full')
      expect(byId.get('codex')?.supportLevel).toBe('full')
      expect(byId.get('gemini')?.supportLevel).toBe('full')
      expect(byId.get('opencode')?.supportLevel).toBe('full')
      expect(byId.get('cline')?.supportLevel).toBe('full')
      expect(byId.get('kimi-cli')?.supportLevel).toBe('full')
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('does not carry retired runtime profiles', () => {
    expect(listAgentRuntimes().map((runtime) => runtime.id)).not.toContain('windsurf')
  })
})
