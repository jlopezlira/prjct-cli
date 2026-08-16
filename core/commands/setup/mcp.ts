/**
 * MCP server wiring during setup. Each block is independent: a
 * failure in one provider must not abort the others.
 *  - Context7: auto-installs and verifies (required for framework API lookups)
 *  - prjct: auto-installs the local MCP server for project memory/workflow.
 *  - Linear / Jira: optional integrations configured manually via their
 *    setup commands.
 */

import { detectCodex, detectKimi } from '../../infrastructure/ai-provider'
import context7Service from '../../services/context7-service'
import { getErrorMessage } from '../../types/fs'
import { ensureCodexContext7Server, ensureCodexMcpServer } from '../../utils/codex-mcp'
import { ensureKimiMcpServer } from '../../utils/kimi-mcp'
import {
  getClaudeMcpConfigPath,
  hasMcpServer,
  MCP_SERVER_PRESETS,
  upsertMcpServer,
} from '../../utils/mcp-config'

const DEFAULT_MCP_SERVERS = [
  {
    name: 'prjct',
    ready: '✅ prjct MCP already configured',
    added: '✅ prjct MCP added to mcp.json',
    failed: 'prjct MCP setup failed',
    manual: '   Run `prjct start` again to retry.',
  },
] as const

export async function setupMcpServers(
  options: { silent?: boolean; verifyContext7?: boolean } = {}
): Promise<void> {
  if (!options.silent) console.log('\n🔌 Configuring MCP servers...')

  try {
    await context7Service.install()
    const status = options.verifyContext7 === false ? null : await context7Service.verify()
    if (options.silent) {
      // sync verifies Context7 separately and reports in markdown output.
    } else if (status?.verified) {
      console.log('✅ Context7 MCP ready (framework API lookups)')
    } else {
      console.log(`⚠️  Context7 configured but not yet verified: ${status?.message || ''}`)
      console.log('   It will activate on the next time you open your AI client.')
    }
  } catch (error) {
    if (!options.silent) {
      console.log(`⚠️  Context7 MCP setup failed: ${getErrorMessage(error)}`)
      console.log('   Run `prjct start` again to retry.')
    }
  }

  for (const server of DEFAULT_MCP_SERVERS) {
    try {
      const configPath = getClaudeMcpConfigPath()
      const configured = await hasMcpServer(server.name, configPath)
      const result = await upsertMcpServer(server.name, MCP_SERVER_PRESETS[server.name], configPath)
      if (configured && !result.changed) {
        if (!options.silent) console.log(server.ready)
      } else {
        if (!options.silent) console.log(server.added)
      }
    } catch (error) {
      if (!options.silent) {
        console.log(`⚠️  ${server.failed}: ${getErrorMessage(error)}`)
        console.log(server.manual)
      }
    }
  }

  // Codex reads MCP servers and TUI status-line preferences from
  // ~/.codex/config.toml. Without this block, Codex sessions miss either
  // the prjct_* tools or the visible status line users expect.
  try {
    const codex = await detectCodex()
    if (codex.installed) {
      const result = await ensureCodexMcpServer()
      // Give Codex the same Context7 capability Claude gets via mcp.json.
      const context7 = await ensureCodexContext7Server()
      if (!options.silent) {
        if (result.skipped === 'user-managed') {
          console.log('✅ prjct Codex config ready (MCP user-managed)')
        } else if (result.changed || context7.changed) {
          console.log('✅ prjct Codex config updated in ~/.codex/config.toml')
        } else {
          console.log('✅ prjct Codex config already ready')
        }
      }
    }
  } catch (error) {
    if (!options.silent) {
      console.log(`⚠️  Codex config setup failed: ${getErrorMessage(error)}`)
      console.log('   Run `prjct start` again to retry.')
    }
  }

  // Kimi Code CLI reads MCP servers from ~/.kimi-code/mcp.json (standard
  // mcpServers JSON, same shape as Claude; legacy ~/.kimi is the fallback).
  // Without this block, Kimi sessions see the AGENTS.md routing text but have
  // no prjct_* tools behind it.
  try {
    const kimi = await detectKimi()
    if (kimi.installed) {
      const result = await ensureKimiMcpServer()
      if (!options.silent) {
        console.log(
          result.changed
            ? `✅ prjct Kimi config updated in ${result.path}`
            : '✅ prjct Kimi config already ready'
        )
      }
    }
  } catch (error) {
    if (!options.silent) {
      console.log(`⚠️  Kimi config setup failed: ${getErrorMessage(error)}`)
      console.log('   Run `prjct start` again to retry.')
    }
  }
}
