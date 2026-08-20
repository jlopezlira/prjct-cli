import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HostContextTax } from '../../services/context-tax'
import { applyContextTaxHeal, type ContextTaxHealReport } from '../../services/context-tax-heal'

const heavyKimiTax: HostContextTax = {
  host: 'kimi',
  servers: [
    { server: 'native', chars: 60_000, approxTokens: 15_000 },
    { server: 'mcp:storybook-mcp', chars: 12_000, approxTokens: 3_000 },
  ],
  totalCatalogChars: 72_000,
  sessions: [],
  marathonSessions: 0,
}

describe('context tax heal', () => {
  let tempDir = ''
  let configPath = ''

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-context-heal-'))
    configPath = path.join(tempDir, 'mcp.json')
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('reversibly disables a heavy Kimi MCP and preserves its configuration', async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          untouched: { theme: 'dark' },
          mcpServers: {
            'storybook-mcp': {
              command: 'npx',
              args: ['storybook-mcp'],
              env: { PRIVATE_TOKEN: 'preserved-secret' },
            },
            light: { command: 'light-server' },
          },
        },
        null,
        2
      )}\n`
    )

    const report = await applyContextTaxHeal([heavyKimiTax], process.cwd(), [configPath])
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'))

    expect(report.applied).toEqual(['kimi:storybook-mcp disabled'])
    expect(report.errors).toEqual([])
    expect(config.mcpServers['storybook-mcp']).toEqual({
      command: 'npx',
      args: ['storybook-mcp'],
      env: { PRIVATE_TOKEN: 'preserved-secret' },
      enabled: false,
    })
    expect(config.mcpServers.light).toEqual({ command: 'light-server' })
    expect(config.untouched).toEqual({ theme: 'dark' })
    expect(report.line).not.toContain('preserved-secret')
  })

  it('is idempotent and never disables native tools', async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        mcpServers: { 'storybook-mcp': { command: 'npx', enabled: false } },
      })}\n`
    )

    const report: ContextTaxHealReport = await applyContextTaxHeal([heavyKimiTax], process.cwd(), [
      configPath,
    ])

    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('kimi:storybook-mcp already disabled')
    expect(report.skipped.join(' ')).not.toContain('native')
  })

  it('repairs a heavy prjct catalog by pinning micro instead of disabling the harness', async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        mcpServers: { prjct: { command: 'prjct', env: { EXISTING: 'kept' } } },
      })}\n`
    )
    const tax: HostContextTax = {
      ...heavyKimiTax,
      servers: [{ server: 'mcp:prjct', chars: 12_000, approxTokens: 3_000 }],
      totalCatalogChars: 12_000,
    }

    const report = await applyContextTaxHeal([tax], process.cwd(), [configPath])
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'))

    expect(report.applied).toEqual(['kimi:prjct pinned to micro'])
    expect(config.mcpServers.prjct.enabled).toBeUndefined()
    expect(config.mcpServers.prjct.env).toEqual({
      EXISTING: 'kept',
      PRJCT_MCP_TOOLS: 'micro',
    })
  })

  it('reports an unresolved heavy server when its owning config cannot be found', async () => {
    const report = await applyContextTaxHeal([heavyKimiTax], process.cwd(), [configPath])

    expect(report.applied).toEqual([])
    expect(report.errors).toEqual([
      'kimi:storybook-mcp: owning mcp.json entry not found; disable it in the active Kimi MCP configuration',
    ])
  })
})
