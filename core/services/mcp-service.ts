/**
 * MCP Service — discover + scope MCP servers per project.
 *
 * Three sources of MCP servers Claude Code loads:
 *   1. Cloud (claude.ai connected apps): NOT enumerable via Claude Code config —
 *      they come from the user's claude.ai account. We keep a hand-curated seed
 *      list of well-known ones so `prjct mcp list` can name them and the user
 *      can deny per-project without guessing.
 *   2. Project `.mcp.json`: stdio servers declared in the repo.
 *   3. Global `~/.claude.json` mcpServers: stdio servers in user config.
 *
 * Per-project scoping lives in `.claude/settings.local.json` under
 * `deniedMcpServers` (Anthropic's enterprise denylist schema, accepted from
 * user-level settings too). Edits never touch global config.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type McpSource = 'cloud' | 'project' | 'global'

export interface McpServerInfo {
  name: string
  displayName: string
  source: McpSource
  description: string
  /** Approximate tool count — used to estimate context cost. */
  estimatedTools: number
  /** True if denied in `.claude/settings.local.json`. */
  denied: boolean
}

interface DenyEntry {
  serverName: string
}

interface LocalSettings {
  deniedMcpServers?: DenyEntry[]
  [k: string]: unknown
}

interface ProjectMcpJson {
  mcpServers?: Record<string, unknown>
}

/**
 * Hand-curated catalog of well-known cloud MCPs that load via claude.ai
 * connected apps. Numbers are approximate — used only for context-cost
 * hinting, not for enforcement.
 *
 * When a new cloud MCP is observed (look for `mcp__claude_ai_*__*` patterns
 * in tool listings), add it here so users don't have to guess the exact
 * `serverName` string.
 */
const KNOWN_CLOUD_MCPS: ReadonlyArray<{
  name: string
  displayName: string
  description: string
  estimatedTools: number
}> = [
  {
    name: 'claude_ai_PostHog',
    displayName: 'PostHog',
    description: 'Product analytics, dashboards, feature flags, surveys',
    estimatedTools: 280,
  },
  {
    name: 'claude_ai_Atlassian',
    displayName: 'Atlassian (Jira + Confluence)',
    description: 'Jira issues, Confluence pages, Compass components',
    estimatedTools: 40,
  },
  {
    name: 'claude_ai_Supabase',
    displayName: 'Supabase',
    description: 'Postgres projects, migrations, edge functions, branches',
    estimatedTools: 30,
  },
  {
    name: 'claude_ai_Google_Drive',
    displayName: 'Google Drive',
    description: 'Read files from your Drive (auth-gated)',
    estimatedTools: 2,
  },
  {
    name: 'claude_ai_Linear',
    displayName: 'Linear',
    description: 'Issues, projects, comments',
    estimatedTools: 25,
  },
  {
    name: 'claude_ai_GitHub',
    displayName: 'GitHub',
    description: 'Repos, PRs, issues (claude.ai integration, separate from gh CLI)',
    estimatedTools: 35,
  },
  {
    name: 'claude_ai_Notion',
    displayName: 'Notion',
    description: 'Pages, databases, blocks',
    estimatedTools: 20,
  },
  {
    name: 'claude_ai_Slack',
    displayName: 'Slack',
    description: 'Messages, channels, threads',
    estimatedTools: 15,
  },
]

class McpService {
  /**
   * List all MCP servers prjct knows about for a given project, with their
   * deny-state in `.claude/settings.local.json`. Cloud entries come from the
   * curated seed; project + global entries come from the actual config files.
   */
  async list(projectPath: string): Promise<McpServerInfo[]> {
    const denied = new Set(this.readDenied(projectPath).map((d) => d.serverName))
    const out: McpServerInfo[] = []

    for (const entry of KNOWN_CLOUD_MCPS) {
      out.push({
        name: entry.name,
        displayName: entry.displayName,
        source: 'cloud',
        description: entry.description,
        estimatedTools: entry.estimatedTools,
        denied: denied.has(entry.name),
      })
    }

    // Project .mcp.json
    const projectMcp = this.readJson<ProjectMcpJson>(path.join(projectPath, '.mcp.json'))
    if (projectMcp?.mcpServers) {
      for (const name of Object.keys(projectMcp.mcpServers)) {
        out.push({
          name,
          displayName: name,
          source: 'project',
          description: 'stdio server declared in .mcp.json',
          estimatedTools: 0,
          denied: denied.has(name),
        })
      }
    }

    // Global ~/.claude.json mcpServers
    const globalMcp = this.readJson<{ mcpServers?: Record<string, unknown> }>(
      path.join(os.homedir(), '.claude.json')
    )
    if (globalMcp?.mcpServers) {
      for (const name2 of Object.keys(globalMcp.mcpServers)) {
        out.push({
          name: name2,
          displayName: name2,
          source: 'global',
          description: 'stdio server declared in ~/.claude.json',
          estimatedTools: 0,
          denied: denied.has(name2),
        })
      }
    }

    return out
  }

  /**
   * Add a server to the per-project denylist in `.claude/settings.local.json`.
   * Idempotent: returns `alreadyDenied: true` if the entry was present.
   */
  async deny(
    projectPath: string,
    serverName: string
  ): Promise<{ alreadyDenied: boolean; settingsPath: string }> {
    const settingsPath = this.localSettingsPath(projectPath)
    const settings = this.readJson<LocalSettings>(settingsPath) ?? {}
    const existing = settings.deniedMcpServers ?? []
    const already = existing.some((e) => e.serverName === serverName)
    if (already) return { alreadyDenied: true, settingsPath }

    settings.deniedMcpServers = [...existing, { serverName }]
    this.writeJson(settingsPath, settings)
    return { alreadyDenied: false, settingsPath }
  }

  /**
   * Remove a server from the per-project denylist. Idempotent: returns
   * `wasDenied: false` if there was nothing to remove.
   */
  async allow(
    projectPath: string,
    serverName: string
  ): Promise<{ wasDenied: boolean; settingsPath: string }> {
    const settingsPath = this.localSettingsPath(projectPath)
    const settings = this.readJson<LocalSettings>(settingsPath) ?? {}
    const existing = settings.deniedMcpServers ?? []
    const filtered = existing.filter((e) => e.serverName !== serverName)
    if (filtered.length === existing.length) return { wasDenied: false, settingsPath }

    if (filtered.length === 0) {
      delete settings.deniedMcpServers
    } else {
      settings.deniedMcpServers = filtered
    }
    this.writeJson(settingsPath, settings)
    return { wasDenied: true, settingsPath }
  }

  /**
   * Atomically reconcile the denylist with a desired set of *enabled* server
   * names. Returns which names changed sides so callers can show a diff.
   * Used by the interactive multi-select — single file write instead of N.
   */
  async setEnabled(
    projectPath: string,
    enabledNames: string[],
    knownNames: string[]
  ): Promise<{
    nowDenied: string[]
    nowAllowed: string[]
    settingsPath: string
  }> {
    const settingsPath = this.localSettingsPath(projectPath)
    const settings = this.readJson<LocalSettings>(settingsPath) ?? {}
    const previous = new Set((settings.deniedMcpServers ?? []).map((e) => e.serverName))
    const enabled = new Set(enabledNames)

    // Desired denylist = (previous denylist ∪ known names) − enabled names.
    // Preserves entries we don't recognize (user may hand-edit denylist for
    // servers prjct doesn't catalog yet).
    const desired = new Set<string>(previous)
    for (const name of knownNames) {
      if (enabled.has(name)) desired.delete(name)
      else desired.add(name)
    }

    const nowDenied: string[] = []
    const nowAllowed: string[] = []
    for (const name2 of knownNames) {
      const wasDenied = previous.has(name2)
      const isDenied = desired.has(name2)
      if (!wasDenied && isDenied) nowDenied.push(name2)
      else if (wasDenied && !isDenied) nowAllowed.push(name2)
    }

    if (nowDenied.length === 0 && nowAllowed.length === 0) {
      return { nowDenied, nowAllowed, settingsPath }
    }

    if (desired.size === 0) {
      delete settings.deniedMcpServers
    } else {
      settings.deniedMcpServers = Array.from(desired).map((serverName) => ({ serverName }))
    }
    this.writeJson(settingsPath, settings)
    return { nowDenied, nowAllowed, settingsPath }
  }

  // ---------------------------------------------------------------------

  private localSettingsPath(projectPath: string): string {
    return path.join(projectPath, '.claude', 'settings.local.json')
  }

  private readDenied(projectPath: string): DenyEntry[] {
    const settings = this.readJson<LocalSettings>(this.localSettingsPath(projectPath))
    return settings?.deniedMcpServers ?? []
  }

  private readJson<T>(p: string): T | null {
    try {
      const raw = fs.readFileSync(p, 'utf-8')
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  private writeJson(p: string, value: unknown): void {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  }
}

export const mcpService = new McpService()
