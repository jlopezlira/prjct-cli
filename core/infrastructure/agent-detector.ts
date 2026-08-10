/**
 * Agent Detector
 * Detects Claude Code and Claude Desktop environments.
 *
 */

import path from 'node:path'
import type { DetectedAgent } from '../types/infrastructure'
import { fileExists } from '../utils/file-helper'

declare const global: typeof globalThis & {
  mcp?: { filesystem?: unknown }
}

// ============ Module State (for caching) ============

const agentCache: { value: DetectedAgent | null } = { value: null }

// ============ Agent Definitions ============

const CLAUDE_AGENT: DetectedAgent = {
  type: 'claude',
  name: 'Claude (Code + Desktop)',
  isSupported: true,
  capabilities: {
    mcp: true,
    filesystem: 'mcp',
    markdown: true,
    emojis: true,
    colors: true,
    interactive: true,
    agents: true,
  },
  config: {
    configFile: 'CLAUDE.md',
    commandPrefix: 'p.',
    responseStyle: 'rich',
    dataDir: '.prjct',
    commandsDir: '~/.claude/commands/p',
  },
  environment: {
    hasMCP: true,
    sandboxed: false,
    persistent: true,
    agentSystem: true,
  },
}

const TERMINAL_AGENT: DetectedAgent = {
  type: 'terminal',
  name: 'Terminal/CLI',
  isSupported: true,
  capabilities: {
    mcp: false,
    filesystem: 'native',
    markdown: false,
    emojis: true,
    colors: true,
    interactive: true,
    agents: false,
  },
  config: {
    configFile: null,
    commandPrefix: 'prjct',
    responseStyle: 'cli',
    dataDir: '.prjct',
    commandsDir: null,
  },
  environment: {
    hasMCP: false,
    sandboxed: false,
    persistent: true,
    agentSystem: false,
  },
}

// ============ Detection Functions ============

async function isClaudeEnvironment(): Promise<boolean> {
  // CLAUDE_AGENT / ANTHROPIC_CLAUDE: Set by Claude runtime to indicate agent environment
  if (process.env.CLAUDE_AGENT || process.env.ANTHROPIC_CLAUDE) return true

  // MCP_AVAILABLE: Set when Model Context Protocol is available
  if (global.mcp || process.env.MCP_AVAILABLE) return true

  // Configuration files
  const projectRoot = process.cwd()
  if (await fileExists(path.join(projectRoot, 'CLAUDE.md'))) return true

  // Claude directory in home
  const homeDir = process.env.HOME || process.env.USERPROFILE || ''
  if (await fileExists(path.join(homeDir, '.claude'))) return true

  // Filesystem paths
  const cwd = process.cwd()
  if (cwd.includes('/.claude/') || cwd.includes('/claude-workspace/')) return true

  return false
}

function getClaudeAgent(): DetectedAgent {
  return { ...CLAUDE_AGENT }
}

function getTerminalAgent(): DetectedAgent {
  return { ...TERMINAL_AGENT }
}

/**
 * Whether prjct is running inside a restricted sandbox (e.g. OpenAI Codex
 * executes shell commands in one). `CODEX_SANDBOX` is the documented signal;
 * `PRJCT_SANDBOX=1` lets any harness or test opt in. Used to tune error
 * messaging — a write failure in a sandbox needs an "approve access" hint, not
 * a "your disk is broken" one.
 */
export function isSandboxed(): boolean {
  return Boolean(process.env.CODEX_SANDBOX || process.env.PRJCT_SANDBOX === '1')
}

export async function detect(): Promise<DetectedAgent> {
  if (agentCache.value) return agentCache.value

  const agent = (await isClaudeEnvironment()) ? getClaudeAgent() : getTerminalAgent()
  // The `sandboxed` flag was historically hardcoded false; derive it at runtime
  // so downstream consumers can branch on it.
  agent.environment = { ...agent.environment, sandboxed: isSandboxed() }
  agentCache.value = agent
  return agent
}
