import { describe, expect, it } from 'bun:test'
import {
  formatHarnessSurfacesMarkdown,
  getHarnessSurface,
  listHarnessSurfaces,
} from '../../infrastructure/harness-surfaces'

describe('harness surfaces matrix', () => {
  it('covers benchmark-tier CLIs with hook + MCP wire status', () => {
    const ids = listHarnessSurfaces().map((s) => s.runtimeId)
    for (const id of [
      'claude',
      'codex',
      'gemini',
      'grok',
      'opencode',
      'pi',
      'cursor',
      'cline',
      'kimi-cli',
    ] as const) {
      expect(ids).toContain(id)
    }
  })

  it('documents Kimi Code CLI as fully native (hooks TOML + claude-json MCP + shared skill)', () => {
    const kimi = getHarnessSurface('kimi-cli')
    expect(kimi).toBeDefined()
    expect(kimi!.hooks.prjct).toBe('native')
    expect(kimi!.mcp.prjct).toBe('native')
    expect(kimi!.skills.prjct).toBe('native')
    expect(kimi!.hooks.configPaths[0]).toContain('.kimi-code/config.toml')
    expect(kimi!.hooks.events).toContain('PreToolUse')
    expect(kimi!.hooks.events).not.toContain('CwdChanged')
    expect(kimi!.mcp.configPaths[0]).toContain('.kimi-code/mcp.json')
    expect(kimi!.skills.paths.some((p) => p.includes('.kimi-code/skills'))).toBe(true)
    expect(kimi!.skills.paths.some((p) => p.includes('.agents/skills'))).toBe(false)
  })

  it('documents OpenCode MCP as native and Pi skill as native (no MCP)', () => {
    const opencode = getHarnessSurface('opencode')
    expect(opencode).toBeDefined()
    expect(opencode!.mcp.prjct).toBe('native')
    expect(opencode!.hooks.prjct).toBe('none')

    const pi = getHarnessSurface('pi')
    expect(pi).toBeDefined()
    expect(pi!.skills.prjct).toBe('native')
    expect(pi!.mcp.prjct).toBe('none')
    expect(pi!.legibility).toMatch(/skill/i)
  })

  it('documents Grok as native MCP+skills+plugin with hooks inherits-claude', () => {
    const grok = getHarnessSurface('grok')
    expect(grok).toBeDefined()
    expect(grok!.hooks.prjct).toBe('inherits-claude')
    expect(grok!.mcp.prjct).toBe('native')
    expect(grok!.skills.prjct).toBe('native')
    expect(grok!.plugins?.prjct).toBe('native')
    expect(grok!.legibility).toMatch(/native MCP/i)
  })

  it('documents Claude as fully native', () => {
    const claude = getHarnessSurface('claude')
    expect(claude!.hooks.prjct).toBe('native')
    expect(claude!.mcp.prjct).toBe('native')
    expect(claude!.hooks.events).toContain('SessionStart')
    expect(claude!.hooks.events).toContain('PreToolUse')
  })

  it('documents Codex MCP and hooks as native', () => {
    const codex = getHarnessSurface('codex')
    expect(codex!.mcp.prjct).toBe('native')
    expect(codex!.hooks.prjct).toBe('native')
  })

  it('documents Gemini MCP and hooks as native', () => {
    const gemini = getHarnessSurface('gemini')
    expect(gemini!.mcp.prjct).toBe('native')
    expect(gemini!.hooks.prjct).toBe('native')
  })

  it('documents Cursor hooks as native', () => {
    const cursor = getHarnessSurface('cursor')
    expect(cursor!.hooks.prjct).toBe('native')
  })

  it('formatHarnessSurfacesMarkdown is agent-legible', () => {
    const md = formatHarnessSurfacesMarkdown({ detail: true })
    expect(md).toContain('Harness surfaces')
    expect(md).toContain('Grok')
    expect(md).toContain('inherits-claude')
    expect(md).toContain('native')
  })
})
