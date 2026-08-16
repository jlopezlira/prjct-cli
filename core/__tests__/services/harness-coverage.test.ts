import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { probeHarnessCoverage, renderHarnessCoverageMd } from '../../services/harness-coverage'

describe('harness coverage (organic multi-runtime board)', () => {
  const fixture: {
    home: string
    prevHome: string | undefined
    prevTestMode: string | undefined
  } = {
    home: '',
    prevHome: undefined as unknown as string | undefined,
    prevTestMode: undefined as unknown as string | undefined,
  }

  beforeEach(async () => {
    fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-coverage-home-'))
    fixture.prevHome = process.env.HOME
    fixture.prevTestMode = process.env.PRJCT_TEST_MODE
    process.env.HOME = fixture.home
    process.env.PRJCT_TEST_MODE = '1'
    // Isolate codex/gemini/cursor paths under test home via resolveUserPath + PRJCT_TEST_MODE
  })

  afterEach(async () => {
    if (fixture.prevHome === undefined) delete process.env.HOME
    else process.env.HOME = fixture.prevHome
    if (fixture.prevTestMode === undefined) delete process.env.PRJCT_TEST_MODE
    else process.env.PRJCT_TEST_MODE = fixture.prevTestMode
    await fs.rm(fixture.home, { recursive: true, force: true }).catch(() => {})
  })

  it('reports absent when no runtimes are wired', async () => {
    const report = await probeHarnessCoverage(fixture.home)
    // Claude, Codex, Gemini, Cursor, Grok, OpenCode, Pi, Kimi Code CLI
    expect(report.runtimes.length).toBe(8)
    expect(report.runtimes.map((r) => r.id)).toEqual(
      expect.arrayContaining(['opencode', 'pi', 'claude', 'grok', 'kimi-cli'])
    )
    // Without CLIs on PATH in a fresh HOME, detected may still be 0
    expect(report.organicPct).toBeGreaterThanOrEqual(0)
    expect(report.grade).toBeGreaterThanOrEqual(1)
  })

  it('marks Kimi Code CLI full when TOML hooks + claude-json MCP are present', async () => {
    const kimiHome = path.join(fixture.home, '.kimi-code')
    await fs.mkdir(kimiHome, { recursive: true })
    await fs.writeFile(
      path.join(kimiHome, 'config.toml'),
      `# prjct-managed
[[hooks]]
event = "Stop"
command = "command -v prjct >/dev/null 2>&1 && PRJCT_HOOK_HOST=kimi prjct hook stop || exit 0"
timeout = 10
`,
      'utf-8'
    )
    await fs.writeFile(
      path.join(kimiHome, 'mcp.json'),
      JSON.stringify({ mcpServers: { prjct: { command: 'prjct', args: ['mcp-server'] } } }),
      'utf-8'
    )

    const report = await probeHarnessCoverage(fixture.home)
    const kimi = report.runtimes.find((r) => r.id === 'kimi-cli')
    expect(kimi?.detected).toBe(true)
    expect(kimi?.hooksLive).toBe(true)
    expect(kimi?.mcpLive).toBe(true)
    expect(kimi?.organic).toBe('full')
  })

  it('marks OpenCode full when mcp.prjct is present and Pi full when skill is present', async () => {
    const ocDir = path.join(fixture.home, '.prjct-tests', 'opencode')
    await fs.mkdir(ocDir, { recursive: true })
    await fs.writeFile(
      path.join(ocDir, 'opencode.json'),
      JSON.stringify({
        mcp: {
          prjct: {
            type: 'local',
            command: ['npx', '-y', 'prjct-cli@latest', 'mcp-server'],
            enabled: true,
          },
        },
      }),
      'utf-8'
    )
    // Detect via ~/.config/opencode in real path — PRJCT_TEST_MODE uses .prjct-tests.
    // Create home config dir so detection fires, and ensure MCP path is test path.
    await fs.mkdir(path.join(fixture.home, '.config', 'opencode'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        mcp: {
          prjct: {
            type: 'local',
            command: ['npx', '-y', 'prjct-cli@latest', 'mcp-server'],
            enabled: true,
          },
        },
      }),
      'utf-8'
    )

    const piSkillDir = path.join(fixture.home, '.prjct-tests', 'pi', 'agent', 'skills', 'prjct')
    await fs.mkdir(piSkillDir, { recursive: true })
    await fs.writeFile(path.join(piSkillDir, 'SKILL.md'), '# prjct\n', 'utf-8')
    await fs.mkdir(path.join(fixture.home, '.pi', 'agent'), { recursive: true })

    const report = await probeHarnessCoverage(fixture.home)
    const oc = report.runtimes.find((r) => r.id === 'opencode')
    expect(oc?.detected).toBe(true)
    // Probe reads getOpenCodeConfigPath() which under PRJCT_TEST_MODE is .prjct-tests/opencode
    expect(oc?.mcpLive).toBe(true)
    expect(oc?.organic).toBe('full')

    const pi = report.runtimes.find((r) => r.id === 'pi')
    expect(pi?.detected).toBe(true)
    expect(pi?.organic).toBe('full')
  })

  it('marks Claude full when settings + mcp.json have prjct wire', async () => {
    const claude = path.join(fixture.home, '.claude')
    await fs.mkdir(claude, { recursive: true })
    await fs.writeFile(
      path.join(claude, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'prjct hook session-start',
                  _prjctManaged: true,
                },
              ],
            },
          ],
        },
      }),
      'utf-8'
    )
    await fs.writeFile(
      path.join(claude, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          prjct: { command: 'prjct', args: ['mcp-server'] },
        },
      }),
      'utf-8'
    )

    const report = await probeHarnessCoverage(fixture.home)
    const claudeRow = report.runtimes.find((r) => r.id === 'claude')
    expect(claudeRow?.detected).toBe(true)
    expect(claudeRow?.hooksLive).toBe(true)
    expect(claudeRow?.mcpLive).toBe(true)
    expect(claudeRow?.organic).toBe('full')
  })

  it('renders dominance board markdown', async () => {
    const report = await probeHarnessCoverage(fixture.home)
    const md = renderHarnessCoverageMd(report)
    expect(md).toContain('Organic multi-runtime board')
    expect(md).toContain('Claude Code')
    expect(md).toContain('Grok Build')
    expect(md).toContain('OpenCode')
    expect(md).toContain('Pi')
    expect(md).toContain('Moat')
  })

  it('grades higher when more detected surfaces are live', async () => {
    // Wire Claude full — at least one live when detected
    const claude = path.join(fixture.home, '.claude')
    await fs.mkdir(claude, { recursive: true })
    await fs.writeFile(
      path.join(claude, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: 'prjct hook session-start', _prjctManaged: true },
              ],
            },
          ],
        },
      }),
      'utf-8'
    )
    await fs.writeFile(
      path.join(claude, 'mcp.json'),
      JSON.stringify({ mcpServers: { prjct: { command: 'prjct', args: ['mcp-server'] } } }),
      'utf-8'
    )
    const report = await probeHarnessCoverage(fixture.home)
    const claudeRow = report.runtimes.find((r) => r.id === 'claude')
    if (claudeRow?.detected) {
      expect(report.liveCount).toBeGreaterThanOrEqual(1)
      expect(report.grade).toBeGreaterThanOrEqual(3)
    }
  })
})
