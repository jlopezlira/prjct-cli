import path from 'node:path'
import { dirExists, fileExists } from '../utils/file-helper'
import { commandOnPathAsync } from '../utils/which'
import { resolveUserHome } from './user-home'

export type AgentRuntimeId =
  | 'agents-md'
  | 'mcp'
  | 'acp'
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'opencode'
  | 'pi'
  | 'qwen-code'
  | 'kimi-cli'
  | 'grok'
  | 'goose'
  | 'aider'
  | 'cursor'
  | 'cline'
  | 'roo-code'
  | 'continue'
  | 'kiro'
  | 'copilot'
  | 'devin'
  | 'jules'
  | 'zed'
  | 'warp'
  | 'amp'
  | 'factory'
  | 'augment'
  | 'kilo-code'
  | 'phoenix'
  | 'ona'
  | 'semgrep'

export type AgentRuntimeKind = 'standard' | 'cli' | 'ide' | 'hosted' | 'model-runtime'

export interface AgentRuntimeRuleTarget {
  relativePath: string
  templateKey: string
  detectPath?: string
}

export interface AgentRuntimeMcpTarget {
  format: 'claude-json' | 'codex-toml' | 'opencode-json' | 'continue-yaml' | 'generic'
  pathHint: string
  writable: boolean
}

export interface AgentRuntimeDefinition {
  id: AgentRuntimeId
  displayName: string
  kind: AgentRuntimeKind
  /** stable = current benchmark focus; emerging = active evaluation. */
  status: 'stable' | 'emerging' | 'hosted'
  detectsBy?: {
    homeDirs?: string[]
    projectFiles?: string[]
    projectDirs?: string[]
    commands?: string[]
  }
  contextFiles: string[]
  projectRuleTargets?: AgentRuntimeRuleTarget[]
  mcpTargets?: AgentRuntimeMcpTarget[]
  supports: {
    agentsMd: boolean
    mcp: boolean
    skills: boolean
    hooks: boolean
    acp: boolean
    projectRules: boolean
  }
  notes: string
}

export interface RuntimeDetection {
  runtime: AgentRuntimeDefinition
  detected: boolean
  reason?: string
}

export type RuntimeSupportLevel = 'full' | 'good' | 'baseline' | 'manual' | 'hosted'

export interface AgentRuntimeStatus extends RuntimeDetection {
  supportLevel: RuntimeSupportLevel
  detectedSignals: string[]
  writableMcpTargets: AgentRuntimeMcpTarget[]
}

export const AGENT_RUNTIME_REGISTRY: readonly AgentRuntimeDefinition[] = [
  {
    id: 'agents-md',
    displayName: 'AGENTS.md-compatible agents',
    kind: 'standard',
    status: 'stable',
    contextFiles: ['AGENTS.md'],
    supports: {
      agentsMd: true,
      mcp: false,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: false,
    },
    notes: 'Universal project instruction surface shared by current and future coding agents.',
  },
  {
    id: 'mcp',
    displayName: 'Model Context Protocol clients',
    kind: 'standard',
    status: 'stable',
    contextFiles: [],
    supports: {
      agentsMd: false,
      mcp: true,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: false,
    },
    notes: 'Universal tool surface for prjct memory, workflow, files, and code intelligence.',
  },
  {
    id: 'acp',
    displayName: 'Agent Client Protocol clients',
    kind: 'standard',
    status: 'emerging',
    contextFiles: [],
    supports: {
      agentsMd: false,
      mcp: false,
      skills: false,
      hooks: false,
      acp: true,
      projectRules: false,
    },
    notes: 'Editor/agent transport for clients such as Zed and other ACP-compatible tools.',
  },
  {
    id: 'claude',
    displayName: 'Claude Code',
    kind: 'cli',
    status: 'stable',
    detectsBy: { homeDirs: ['.claude'], commands: ['claude'] },
    contextFiles: ['CLAUDE.md', 'AGENTS.md'],
    mcpTargets: [{ format: 'claude-json', pathHint: '~/.claude/mcp.json', writable: true }],
    supports: {
      agentsMd: false,
      mcp: true,
      skills: true,
      hooks: true,
      acp: false,
      projectRules: true,
    },
    notes:
      'Benchmark-tier CLI (2026-07): Claude Code + Opus frontier. CLAUDE.md, skills, hooks, MCP JSON.',
  },
  {
    id: 'codex',
    displayName: 'OpenAI Codex',
    kind: 'cli',
    status: 'stable',
    detectsBy: { homeDirs: ['.codex'], commands: ['codex'] },
    contextFiles: ['AGENTS.md'],
    mcpTargets: [{ format: 'codex-toml', pathHint: '~/.codex/config.toml', writable: true }],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: true,
      // Hooks exist (hooks.json / config.toml) behind [features] codex_hooks — see harness-surfaces.
      hooks: true,
      acp: false,
      projectRules: false,
    },
    notes:
      'Benchmark-tier CLI (2026-07): Codex + GPT-5.x (TB leader). AGENTS.md, config.toml MCP (native), hooks opt-in (planned installer).',
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    kind: 'cli',
    status: 'stable',
    detectsBy: { homeDirs: ['.gemini'], commands: ['gemini'] },
    contextFiles: ['GEMINI.md', 'AGENTS.md'],
    mcpTargets: [
      { format: 'claude-json', pathHint: '~/.gemini/settings.json mcpServers', writable: true },
    ],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: true,
      hooks: true,
      acp: false,
      projectRules: true,
    },
    notes:
      'Benchmark-tier CLI (2026-07): Gemini CLI + Pro/Flash. GEMINI.md; prjct install writes MCP+hooks to ~/.gemini/settings.json.',
  },
  {
    id: 'antigravity',
    displayName: 'Google Antigravity',
    kind: 'ide',
    status: 'emerging',
    detectsBy: { homeDirs: [path.join('.gemini', 'antigravity')] },
    contextFiles: ['ANTIGRAVITY.md', 'AGENTS.md'],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: true,
      hooks: false,
      acp: false,
      projectRules: true,
    },
    notes: 'Uses Antigravity skills under the Gemini config tree.',
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    kind: 'cli',
    status: 'stable',
    detectsBy: {
      homeDirs: ['.config/opencode'],
      projectDirs: ['.opencode'],
      commands: ['opencode'],
    },
    contextFiles: ['AGENTS.md', 'opencode.json', 'opencode.jsonc'],
    mcpTargets: [
      {
        format: 'opencode-json',
        pathHint: '~/.config/opencode/opencode.json mcp.prjct',
        writable: true,
      },
    ],
    supports: {
      agentsMd: true,
      mcp: true,
      // Claude-compat skills (~/.claude/skills) when OPENCODE_DISABLE_CLAUDE_CODE unset.
      skills: true,
      hooks: false,
      acp: false,
      projectRules: true,
    },
    notes:
      'Benchmark-tier open-source CLI (2026-07): most-starred multi-provider agent. AGENTS.md + prjct install writes mcp.prjct; Claude skill/CLAUDE.md compat.',
  },
  {
    id: 'pi',
    displayName: 'Pi',
    kind: 'cli',
    status: 'stable',
    detectsBy: {
      homeDirs: ['.pi', path.join('.pi', 'agent')],
      projectDirs: ['.pi'],
      commands: ['pi'],
    },
    contextFiles: ['AGENTS.md', 'CLAUDE.md', 'SYSTEM.md', 'APPEND_SYSTEM.md'],
    supports: {
      agentsMd: true,
      // No built-in MCP — skills + CLI --md are the contract (pi.dev design).
      mcp: false,
      skills: true,
      hooks: false,
      acp: false,
      projectRules: false,
    },
    notes:
      'Benchmark-tier minimal harness (2026-07): AGENTS.md + prjct skill at ~/.pi/agent/skills/prjct. MCP only via optional extensions — do not require it.',
  },
  {
    id: 'qwen-code',
    displayName: 'Qwen Code',
    kind: 'model-runtime',
    status: 'emerging',
    detectsBy: { homeDirs: ['.qwen'], projectDirs: ['.qwen'], commands: ['qwen'] },
    contextFiles: ['AGENTS.md', 'GEMINI.md'],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: true,
    },
    notes:
      'Qwen-family coding runtime; treat model/provider choice as separate from runtime setup.',
  },
  {
    id: 'kimi-cli',
    displayName: 'Kimi Code CLI',
    kind: 'model-runtime',
    status: 'emerging',
    detectsBy: { homeDirs: ['.kimi-code', '.kimi'], projectDirs: ['.kimi'], commands: ['kimi'] },
    contextFiles: ['AGENTS.md'],
    mcpTargets: [
      { format: 'claude-json', pathHint: '~/.kimi-code/mcp.json', writable: true },
      {
        format: 'claude-json',
        pathHint: '~/.kimi/mcp.json (legacy Kimi CLI fallback)',
        writable: false,
      },
    ],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: true,
      hooks: true,
      acp: false,
      projectRules: false,
    },
    notes:
      'Kimi Code CLI (~/.kimi-code; legacy ~/.kimi is fallback-only): native MCP + hooks ([[hooks]] in config.toml) + compact skill at ~/.agents/skills/prjct via prjct install. See harness-surfaces.',
  },
  {
    id: 'grok',
    displayName: 'xAI Grok Build',
    kind: 'cli',
    status: 'stable',
    detectsBy: { homeDirs: ['.grok'], commands: ['grok'] },
    contextFiles: ['AGENTS.md', 'CLAUDE.md'],
    mcpTargets: [
      {
        format: 'codex-toml',
        pathHint: '~/.grok/config.toml',
        writable: true,
      },
      {
        format: 'claude-json',
        pathHint: '~/.claude/mcp.json (Grok Claude-compat fallback)',
        writable: true,
      },
    ],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: true,
      hooks: true,
      acp: false,
      projectRules: false,
    },
    notes:
      'Benchmark-tier CLI (2026-07): Grok Build. Native MCP + skill via prjct install (~/.grok/config.toml + ~/.grok/skills/prjct). Hooks still Claude-compat. See harness-surfaces.',
  },
  {
    id: 'goose',
    displayName: 'Goose',
    kind: 'cli',
    status: 'stable',
    detectsBy: { homeDirs: ['.config/goose'], projectDirs: ['.goose'], commands: ['goose'] },
    contextFiles: ['AGENTS.md'],
    mcpTargets: [{ format: 'generic', pathHint: 'Goose extensions', writable: false }],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: false,
    },
    notes: 'Open-source coding agent with extension/MCP-style tool configuration.',
  },
  {
    id: 'aider',
    displayName: 'Aider',
    kind: 'cli',
    status: 'stable',
    detectsBy: { projectFiles: ['.aider.conf.yml', '.aider.conf.yaml'], commands: ['aider'] },
    contextFiles: ['AGENTS.md', 'CONVENTIONS.md'],
    supports: {
      agentsMd: true,
      mcp: false,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: true,
    },
    notes: 'CLI pair-programming agent; AGENTS.md provides durable repo instructions.',
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    kind: 'ide',
    status: 'stable',
    detectsBy: { projectDirs: ['.cursor'], projectFiles: ['.cursorrules'] },
    contextFiles: ['AGENTS.md', '.cursor/rules/prjct.mdc'],
    projectRuleTargets: [
      {
        relativePath: '.cursor/rules/prjct.mdc',
        templateKey: 'global/CURSOR.mdc',
        detectPath: '.cursor',
      },
    ],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: false,
      hooks: true,
      acp: false,
      projectRules: true,
    },
    notes:
      'Benchmark-tier AI IDE (2026-07): agent mode + CLI. Rules under .cursor/rules; prjct install writes ~/.cursor/hooks.json.',
  },
  {
    id: 'cline',
    displayName: 'Cline',
    kind: 'ide',
    status: 'stable',
    detectsBy: { projectDirs: ['.cline', '.clinerules'], projectFiles: ['.clinerules'] },
    contextFiles: ['AGENTS.md', '.clinerules/'],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: true,
      hooks: true,
      acp: true,
      projectRules: true,
    },
    notes:
      'Benchmark-tier open agent (2026-07): VS Code + multi-model. AGENTS.md, rules, skills, hooks, MCP, ACP.',
  },
  {
    id: 'roo-code',
    displayName: 'Roo Code',
    kind: 'ide',
    status: 'stable',
    detectsBy: { projectDirs: ['.roo'] },
    contextFiles: ['AGENTS.md'],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: true,
    },
    notes: 'VS Code agent with MCP and project rule surfaces.',
  },
  {
    id: 'continue',
    displayName: 'Continue',
    kind: 'ide',
    status: 'stable',
    detectsBy: { projectDirs: ['.continue'] },
    contextFiles: ['AGENTS.md'],
    mcpTargets: [{ format: 'continue-yaml', pathHint: '.continue/mcpServers/', writable: false }],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: true,
    },
    notes: 'IDE assistant with dedicated MCP server config directory.',
  },
  {
    id: 'kiro',
    displayName: 'Kiro',
    kind: 'ide',
    status: 'stable',
    detectsBy: { homeDirs: ['.kiro'], projectDirs: ['.kiro'] },
    contextFiles: ['AGENTS.md', '.kiro/steering/'],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: false,
      hooks: true,
      acp: false,
      projectRules: true,
    },
    notes: 'Agentic IDE with steering docs and MCP.',
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot coding agent',
    kind: 'hosted',
    status: 'hosted',
    detectsBy: { projectFiles: [path.join('.github', 'copilot-instructions.md')] },
    contextFiles: ['AGENTS.md', '.github/copilot-instructions.md'],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: true,
    },
    notes:
      'GitHub Copilot coding agent / Copilot CLI (2026-07 benchmark field). Repo AGENTS.md + .github instructions + MCP.',
  },
  {
    id: 'devin',
    displayName: 'Devin',
    kind: 'hosted',
    status: 'hosted',
    contextFiles: ['AGENTS.md'],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: false,
    },
    notes: 'Hosted coding agent; repo-level AGENTS.md is the safest portable surface.',
  },
  {
    id: 'jules',
    displayName: 'Google Jules',
    kind: 'hosted',
    status: 'hosted',
    contextFiles: ['AGENTS.md'],
    supports: {
      agentsMd: true,
      mcp: false,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: false,
    },
    notes: 'Hosted coding agent; AGENTS.md carries repo-level prjct instructions.',
  },
  {
    id: 'zed',
    displayName: 'Zed Agent Panel',
    kind: 'ide',
    status: 'stable',
    detectsBy: { projectDirs: ['.zed'] },
    contextFiles: ['AGENTS.md'],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: false,
      hooks: false,
      acp: true,
      projectRules: true,
    },
    notes: 'Editor agent surface with ACP support; AGENTS.md remains the repo contract.',
  },
  {
    id: 'warp',
    displayName: 'Warp',
    kind: 'ide',
    status: 'stable',
    detectsBy: { homeDirs: ['.warp'] },
    contextFiles: ['AGENTS.md'],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: false,
    },
    notes: 'Terminal agent surface; AGENTS.md plus MCP covers portable prjct usage.',
  },
  {
    id: 'amp',
    displayName: 'Amp',
    kind: 'cli',
    status: 'stable',
    detectsBy: { homeDirs: ['.config/amp'], commands: ['amp'] },
    contextFiles: ['AGENTS.md'],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: false,
    },
    notes: 'Coding agent runtime; AGENTS.md and MCP are the portable contract.',
  },
  {
    id: 'factory',
    displayName: 'Factory',
    kind: 'hosted',
    status: 'hosted',
    contextFiles: ['AGENTS.md'],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: false,
    },
    notes: 'Hosted/agentic development platform; repo instructions are the stable surface.',
  },
  {
    id: 'augment',
    displayName: 'Augment',
    kind: 'ide',
    status: 'stable',
    contextFiles: ['AGENTS.md'],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: true,
    },
    notes: 'IDE agent; universal project instructions avoid model-specific coupling.',
  },
  {
    id: 'kilo-code',
    displayName: 'Kilo Code',
    kind: 'ide',
    status: 'stable',
    detectsBy: { projectDirs: ['.kilocode'] },
    contextFiles: ['AGENTS.md'],
    supports: {
      agentsMd: true,
      mcp: true,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: true,
    },
    notes: 'Agent runtime in the Cline/Roo family; AGENTS.md and MCP keep it compatible.',
  },
  {
    id: 'phoenix',
    displayName: 'Phoenix',
    kind: 'hosted',
    status: 'hosted',
    contextFiles: ['AGENTS.md'],
    supports: {
      agentsMd: true,
      mcp: false,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: false,
    },
    notes: 'Hosted coding agent; AGENTS.md is the repo-level bridge.',
  },
  {
    id: 'ona',
    displayName: 'Ona',
    kind: 'hosted',
    status: 'hosted',
    contextFiles: ['AGENTS.md'],
    supports: {
      agentsMd: true,
      mcp: false,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: false,
    },
    notes: 'Hosted coding agent; AGENTS.md is the repo-level bridge.',
  },
  {
    id: 'semgrep',
    displayName: 'Semgrep assistant',
    kind: 'hosted',
    status: 'hosted',
    contextFiles: ['AGENTS.md'],
    supports: {
      agentsMd: true,
      mcp: false,
      skills: false,
      hooks: false,
      acp: false,
      projectRules: false,
    },
    notes: 'Security/review agent surface; AGENTS.md carries project workflow guidance.',
  },
] as const

export function getAgentRuntime(id: AgentRuntimeId): AgentRuntimeDefinition {
  const runtime = AGENT_RUNTIME_REGISTRY.find((entry) => entry.id === id)
  if (!runtime) throw new Error(`Unknown agent runtime: ${id}`)
  return runtime
}

export function listAgentRuntimes(): readonly AgentRuntimeDefinition[] {
  return AGENT_RUNTIME_REGISTRY
}

export function listProjectRuleTargets(): AgentRuntimeRuleTarget[] {
  return AGENT_RUNTIME_REGISTRY.flatMap((runtime) => runtime.projectRuleTargets ?? [])
}

export async function detectAgentRuntimes(projectPath: string): Promise<AgentRuntimeStatus[]> {
  return Promise.all(
    AGENT_RUNTIME_REGISTRY.map(async (runtime): Promise<AgentRuntimeStatus> => {
      const detectedSignals = await detectRuntimeSignals(runtime, projectPath)
      return {
        runtime,
        detected: detectedSignals.length > 0 || runtime.id === 'agents-md' || runtime.id === 'mcp',
        reason: detectedSignals[0],
        detectedSignals,
        writableMcpTargets: (runtime.mcpTargets ?? []).filter((target) => target.writable),
        supportLevel: supportLevelFor(runtime),
      }
    })
  )
}

async function detectRuntimeSignals(
  runtime: AgentRuntimeDefinition,
  projectPath: string
): Promise<string[]> {
  const signals: string[] = []

  for (const file of runtime.detectsBy?.projectFiles ?? []) {
    if (await fileExists(path.join(projectPath, file))) signals.push(file)
  }

  for (const dir of runtime.detectsBy?.projectDirs ?? []) {
    if (await dirExists(path.join(projectPath, dir))) signals.push(`${dir}/`)
  }

  for (const dir2 of runtime.detectsBy?.homeDirs ?? []) {
    if (await dirExists(path.join(resolveUserHome(), dir2))) signals.push(`~/${dir2}/`)
  }

  for (const command of runtime.detectsBy?.commands ?? []) {
    if (await commandExists(command)) signals.push(`command:${command}`)
  }

  return signals
}

async function commandExists(command: string): Promise<boolean> {
  // Cross-platform: which on Unix, where.exe on Windows.
  if (await commandOnPathAsync(command)) return true
  if (process.platform === 'win32' && (await commandOnPathAsync(`${command}.cmd`))) return true
  return false
}

/** Runtimes that get first-class support investment (2026-07 benchmark field). */
const FULL_SUPPORT_RUNTIME_IDS = new Set<AgentRuntimeId>([
  'claude',
  'codex',
  'gemini',
  'opencode',
  'pi',
  'cursor',
  'cline',
  'grok',
  'kimi-cli',
])

function supportLevelFor(runtime: AgentRuntimeDefinition): RuntimeSupportLevel {
  if (runtime.status === 'hosted') return 'hosted'
  if (FULL_SUPPORT_RUNTIME_IDS.has(runtime.id)) return 'full'
  if (runtime.supports.agentsMd && runtime.supports.mcp) return 'good'
  if (runtime.supports.agentsMd) return 'baseline'
  return 'manual'
}
