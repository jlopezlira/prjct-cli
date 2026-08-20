/**
 * Safe, reversible repairs for context-tax errors.
 *
 * Doctor may change declared configuration, but it never kills a host session
 * or deletes a user's integration. Heavy Kimi MCP entries are retained and
 * set to `enabled: false`; the host boundary still requires reload/new session.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { getKimiMcpConfigPaths } from '../utils/kimi-mcp'
import type { HostContextTax } from './context-tax'
import { SERVER_FLAG_TOKENS } from './context-tax'

interface KimiMcpDocument {
  mcpServers?: Record<string, Record<string, unknown>>
  [key: string]: unknown
}

export interface ContextTaxHealReport {
  applied: string[]
  skipped: string[]
  errors: string[]
  restartRequired: boolean
  line: string
}

function configCandidates(projectPath: string, explicitPaths?: string[]): string[] {
  const candidates = explicitPaths ?? [
    ...getKimiMcpConfigPaths(),
    path.join(projectPath, '.kimi-code', 'mcp.json'),
    path.join(projectPath, '.kimi', 'mcp.json'),
  ]
  return candidates.filter((candidate, index, all) => all.indexOf(candidate) === index)
}

async function readDocument(configPath: string): Promise<{
  document: KimiMcpDocument
} | null> {
  const raw = await fs.readFile(configPath, 'utf-8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) return null
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP config root must be a JSON object')
  }
  return { document: parsed as KimiMcpDocument }
}

/** Repair only catalog-proven heavy Kimi MCPs. Native tools are never mutated. */
export async function applyContextTaxHeal(
  taxes: HostContextTax[],
  projectPath: string = process.cwd(),
  explicitConfigPaths?: string[]
): Promise<ContextTaxHealReport> {
  const applied: string[] = []
  const skipped: string[] = []
  const errors: string[] = []
  const kimi = taxes.find((tax) => tax.host === 'kimi')
  const heavyNames = (kimi?.servers ?? [])
    .filter(
      (server) => server.server.startsWith('mcp:') && server.approxTokens > SERVER_FLAG_TOKENS
    )
    .map((server) => server.server.slice('mcp:'.length))

  for (const serverName of heavyNames) {
    const matchingConfigs: string[] = []
    for (const configPath of configCandidates(projectPath, explicitConfigPaths)) {
      const loaded = await readDocument(configPath).catch((error) => {
        errors.push(
          `${path.basename(path.dirname(configPath))}/${path.basename(configPath)}: ${(error as Error).message}`
        )
        return null
      })
      const entry = loaded?.document.mcpServers?.[serverName]
      if (!loaded || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      matchingConfigs.push(configPath)
      if (entry.enabled === false) {
        skipped.push(`kimi:${serverName} already disabled`)
        continue
      }

      if (serverName === 'prjct') {
        const currentEnv =
          entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
            ? (entry.env as Record<string, unknown>)
            : {}
        if (currentEnv.PRJCT_MCP_TOOLS === 'micro') {
          skipped.push('kimi:prjct already pinned to micro')
          continue
        }
        entry.env = { ...currentEnv, PRJCT_MCP_TOOLS: 'micro' }
      } else {
        entry.enabled = false
      }
      const next = `${JSON.stringify(loaded.document, null, 2)}\n`
      await fs.writeFile(configPath, next, { encoding: 'utf-8', mode: 0o600 })
      applied.push(
        serverName === 'prjct' ? 'kimi:prjct pinned to micro' : `kimi:${serverName} disabled`
      )
    }
    if (matchingConfigs.length === 0) {
      errors.push(
        `kimi:${serverName}: owning mcp.json entry not found; disable it in the active Kimi MCP configuration`
      )
    }
  }

  const restartRequired = applied.length > 0
  return {
    applied,
    skipped,
    errors,
    restartRequired,
    line: `Context repair: applied ${applied.length} · skipped ${skipped.length} · errors ${errors.length}${restartRequired ? ' · Kimi reload/new session required' : ''}`,
  }
}
