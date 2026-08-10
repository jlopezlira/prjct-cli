/**
 * Harness surface matrix — what each benchmark-tier coding agent actually
 * exposes (instructions, MCP, skills, hooks) and how prjct integrates.
 *
 * Source of truth for "is our harness 100% legible on this runtime?":
 *   - agents doctor (`prjct agents --md`) prints this matrix
 *   - install messaging points at inherit paths (e.g. Grok ← Claude settings)
 *
 * Docs reviewed 2026-07:
 *   Claude Code hooks/MCP/skills; Codex hooks + config.toml MCP; Gemini CLI
 *   hooks + settings MCP + skills; Grok Build hooks/skills/plugins/MCP with
 *   native Claude Code surface compatibility.
 */

import type { AgentRuntimeId } from './agent-runtime-registry'

/** How prjct wires into a runtime surface today. */
export type PrjctWireStatus =
  /** prjct writes/maintains this surface natively */
  | 'native'
  /** surface works because the runtime reads Claude Code files we already install */
  | 'inherits-claude'
  /** AGENTS.md / MCP stdio / --md CLI — portable, no runtime-specific writer */
  | 'portable'
  /** runtime has the surface; prjct does not install yet (planned) */
  | 'planned'
  /** runtime lacks the surface or we intentionally skip it */
  | 'none'

export interface HarnessSurfaceEntry {
  runtimeId: AgentRuntimeId
  displayName: string
  /** Short official product name for docs */
  product: string
  instructions: {
    files: string[]
    loadOrder: string
    prjct: PrjctWireStatus
  }
  mcp: {
    configPaths: string[]
    format: string
    prjct: PrjctWireStatus
    notes?: string
  }
  skills: {
    paths: string[]
    prjct: PrjctWireStatus
    notes?: string
  }
  hooks: {
    configPaths: string[]
    events: string[]
    format: string
    prjct: PrjctWireStatus
    /** Fail-open / block semantics that agents must respect */
    contract: string
    notes?: string
  }
  plugins?: {
    paths: string[]
    prjct: PrjctWireStatus
    notes?: string
  }
  /** One-line "what makes prjct legible here" */
  legibility: string
}

/**
 * Benchmark-tier harnesses only. Long-tail runtimes stay on AGENTS.md + MCP
 * portable baseline via the registry.
 */
export const BENCHMARK_HARNESS_SURFACES: readonly HarnessSurfaceEntry[] = [
  {
    runtimeId: 'claude',
    displayName: 'Claude Code',
    product: 'Anthropic Claude Code',
    instructions: {
      files: ['CLAUDE.md', 'AGENTS.md', '~/.claude/CLAUDE.md'],
      loadOrder: 'user global → project CLAUDE.md → nested CLAUDE.md',
      prjct: 'native',
    },
    mcp: {
      configPaths: ['~/.claude/mcp.json', 'project .mcp.json'],
      format: 'JSON mcpServers',
      prjct: 'native',
      notes: 'prjct MCP + Context7 installable via prjct install / context7-service',
    },
    skills: {
      paths: ['~/.claude/skills/', '.claude/skills/', 'project skills via skill-generator'],
      prjct: 'native',
    },
    hooks: {
      configPaths: ['~/.claude/settings.json'],
      events: [
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'Stop',
        'SubagentStart',
        'SubagentStop',
        'Notification',
        'CwdChanged',
      ],
      format: 'settings.json hooks[] with type:command',
      prjct: 'native',
      contract:
        'Passive inject via additionalContext; PreToolUse deny only for explicit loop-guard. Fail-soft {}.',
      notes: 'prjct install writes _prjctManaged hooks (PRJCT_HOOKS)',
    },
    plugins: {
      paths: ['Claude Code plugins / marketplaces'],
      prjct: 'none',
    },
    legibility:
      'Deepest native wire: hooks + MCP + skill + CLAUDE.md. Reference implementation for all other rigs.',
  },
  {
    runtimeId: 'codex',
    displayName: 'OpenAI Codex',
    product: 'OpenAI Codex CLI',
    instructions: {
      files: ['AGENTS.md', 'nested AGENTS.md'],
      loadOrder: 'cwd → repo root AGENTS.md (Codex priority rules)',
      prjct: 'portable',
    },
    mcp: {
      configPaths: ['~/.codex/config.toml [mcp_servers.*]'],
      format: 'TOML mcp_servers tables',
      prjct: 'native',
      notes: 'ensureCodexMcpServer writes # prjct:mcp markers; status line optional',
    },
    skills: {
      paths: ['~/.codex/skills/', '.agents/skills/', 'plugins'],
      prjct: 'portable',
      notes: 'Codex skill description hard ~1024 byte limit (gotcha mem_3723)',
    },
    hooks: {
      configPaths: ['~/.codex/hooks.json', '~/.codex/config.toml [[hooks.*]]', '.codex/hooks.json'],
      events: [
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'Stop',
        'SubagentStart',
        'SubagentStop',
        'PermissionRequest',
        'PreCompact',
        'PostCompact',
      ],
      format: 'hooks.json (+ [features] hooks = true); trust via Codex /hooks once',
      prjct: 'native',
      contract:
        'PRJCT_HOOKS mapped to hooks.json (skips Notification/CwdChanged). Fail-soft command wrapper. User must trust hooks once in TUI.',
      notes:
        'prjct install → installCodexHooks(); commandWindows for win32; features.hooks enabled when missing',
    },
    legibility:
      'MCP + hooks both native on install when Codex is detected. Trust new hooks once via `/hooks`. AGENTS.md portable.',
  },
  {
    runtimeId: 'gemini',
    displayName: 'Gemini CLI',
    product: 'Google Gemini CLI',
    instructions: {
      files: ['GEMINI.md', 'AGENTS.md (if context.fileName includes it)', '~/.gemini/GEMINI.md'],
      loadOrder: 'global GEMINI.md → project → nested; fileName configurable',
      prjct: 'portable',
    },
    mcp: {
      configPaths: ['~/.gemini/settings.json mcpServers', 'mcp_config.json'],
      format: 'JSON mcpServers in settings',
      prjct: 'native',
      notes: 'prjct install → ensureGeminiMcpServer (mcpServers.prjct)',
    },
    skills: {
      paths: ['Agent Skills standard dirs under Gemini config'],
      prjct: 'portable',
    },
    hooks: {
      configPaths: [
        '.gemini/settings.json',
        '~/.gemini/settings.json',
        '/etc/gemini-cli/settings.json',
      ],
      events: [
        'BeforeTool',
        'AfterTool',
        'BeforeAgent',
        'AfterAgent',
        'SessionStart',
        'SessionEnd',
        'Notification',
      ],
      format: 'settings.json hooks.*[] with type:command; timeout ms',
      prjct: 'native',
      contract:
        'PRJCT_HOOK_HOST=gemini remaps deny→{decision:deny} and event names. Matchers: run_shell_command, write_file|replace.',
      notes: 'installGeminiSettings maps Claude events → Gemini BeforeTool/BeforeAgent/AfterAgent',
    },
    legibility:
      'MCP + hooks native on install when Gemini is detected. GEMINI.md/AGENTS.md remain portable context.',
  },
  {
    runtimeId: 'grok',
    displayName: 'xAI Grok Build',
    product: 'xAI Grok Build CLI',
    instructions: {
      files: [
        'AGENTS.md / Agents.md / AGENT.md',
        'CLAUDE.md (native Claude compat)',
        '.claude/rules/',
        '~/.grok + project walk',
      ],
      loadOrder: 'AGENTS.md cwd→root; also auto-reads Claude instruction files',
      prjct: 'inherits-claude',
    },
    mcp: {
      configPaths: [
        '~/.grok/config.toml [mcp_servers.prjct]',
        '~/.claude/mcp.json (Claude compat fallback)',
        'plugins .mcp.json',
      ],
      format: 'TOML mcp_servers (same shape as Codex) + Claude MCP JSON (compat)',
      prjct: 'native',
      notes:
        'prjct install → ensureGrokMcpServer() writes managed [mcp_servers.prjct] into ~/.grok/config.toml; Claude MCP remains a fallback',
    },
    skills: {
      paths: [
        './.grok/skills/',
        '~/.grok/skills/prjct/SKILL.md',
        '~/.agents/skills/',
        '.claude/skills/ (compat)',
        'plugin skills/',
      ],
      prjct: 'native',
      notes: 'prjct install → installGrokSkill() at ~/.grok/skills/prjct/SKILL.md',
    },
    hooks: {
      configPaths: [
        '~/.grok/hooks/*.json',
        '.grok/hooks/*.json (needs /hooks-trust)',
        '~/.claude/settings.json (compat)',
        '.cursor/hooks.json (compat)',
      ],
      events: [
        'SessionStart',
        'SessionEnd',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'PostToolUseFailure',
        'PermissionDenied',
        'Stop',
        'StopFailure',
        'Notification',
        'SubagentStart',
        'SubagentStop',
        'PreCompact',
        'PostCompact',
      ],
      format: 'JSON hook files; Claude settings.json + Cursor hooks.json also loaded',
      prjct: 'inherits-claude',
      contract:
        'PreToolUse is the only blocking event (decision deny or exit 2). Fail-open on errors. Project hooks need trust.',
      notes:
        'Hooks still via Claude/Cursor compat (no second Grok hook writer yet). MCP + skill are native.',
    },
    plugins: {
      paths: ['./.grok/plugins/', '~/.grok/plugins/prjct/', 'marketplaces'],
      prjct: 'native',
      notes:
        'prjct install → installGrokPlugin() at ~/.grok/plugins/prjct (skill + /plan command; MCP stays in config.toml)',
    },
    legibility:
      'Native MCP + skill + user plugin on prjct install when Grok is detected; PreToolUse/Session hooks still fire via Claude-compat settings. Plan ceremony: `prjct plan`. Grok is Brain; prjct SQLite is Body.',
  },
  {
    runtimeId: 'opencode',
    displayName: 'OpenCode',
    product: 'OpenCode (OSS multi-provider)',
    instructions: {
      files: ['AGENTS.md', 'opencode.json(c)', 'CLAUDE.md (compat)'],
      loadOrder: 'project AGENTS.md → global ~/.config/opencode/AGENTS.md; Claude fallbacks',
      prjct: 'portable',
    },
    mcp: {
      configPaths: [
        '~/.config/opencode/opencode.json mcp.prjct',
        '~/.config/opencode/opencode.jsonc',
        'project opencode.json(c)',
      ],
      format: 'JSONC mcp.<name> = { type:local, command:[...], enabled }',
      prjct: 'native',
      notes: 'prjct install → ensureOpenCodeMcpServer() upserts mcp.prjct (jsonc-safe merge)',
    },
    skills: {
      paths: ['.opencode/skills/', '~/.claude/skills/ (Claude Code compat)'],
      prjct: 'inherits-claude',
      notes: 'Claude skill install covers OpenCode when Claude compat is enabled',
    },
    hooks: {
      configPaths: [],
      events: [],
      format: 'plugin/extension dependent',
      prjct: 'none',
      contract: 'No Claude-parity hook pack; MCP + AGENTS.md is the organic wire',
    },
    legibility:
      'Native MCP on prjct install when OpenCode is detected. AGENTS.md portable; Claude skills/CLAUDE.md as fallback.',
  },
  {
    runtimeId: 'pi',
    displayName: 'Pi',
    product: 'Pi coding agent (minimal harness)',
    instructions: {
      files: ['AGENTS.md', 'CLAUDE.md', '~/.pi/agent/AGENTS.md', 'SYSTEM.md / APPEND_SYSTEM.md'],
      loadOrder: '~/.pi/agent → parents → cwd',
      prjct: 'portable',
    },
    mcp: {
      configPaths: [],
      format: 'none built-in (extension-only)',
      prjct: 'none',
      notes: 'Pi intentionally has no native MCP; do not require it for full wire',
    },
    skills: {
      paths: ['~/.pi/agent/skills/prjct/SKILL.md', 'pi packages'],
      prjct: 'native',
      notes: 'prjct install → installPiSkill() at ~/.pi/agent/skills/prjct/SKILL.md',
    },
    hooks: {
      configPaths: [],
      events: [],
      format: 'extension event hooks only',
      prjct: 'none',
      contract: 'Skill + AGENTS.md + prjct CLI --md; no lifecycle hook pack',
    },
    legibility:
      'Native skill on prjct install when Pi is detected. AGENTS.md portable. MCP is optional via community extensions only.',
  },
  {
    runtimeId: 'cursor',
    displayName: 'Cursor',
    product: 'Cursor IDE',
    instructions: {
      files: ['AGENTS.md', '.cursor/rules/*.mdc'],
      loadOrder: 'project rules + AGENTS.md; model pick in-app',
      prjct: 'portable',
    },
    mcp: {
      configPaths: ['Cursor MCP settings (app)'],
      format: 'IDE MCP UI / json',
      prjct: 'portable',
    },
    skills: {
      paths: [],
      prjct: 'none',
      notes: 'Skills are CLI-agent concept; Cursor uses rules + MCP',
    },
    hooks: {
      configPaths: ['~/.cursor/hooks.json', 'project .cursor/hooks.json'],
      events: [
        'sessionStart',
        'beforeSubmitPrompt',
        'preToolUse',
        'postToolUse',
        'stop',
        'subagentStart',
        'subagentStop',
      ],
      format: 'version:1 flat handlers; camelCase events; timeout seconds',
      prjct: 'native',
      contract:
        'User-level install (clean-repo). PRJCT_HOOK_HOST=cursor emits camelCase + additional_context. Grok also reads this file.',
      notes:
        'installCursorHooks on prjct install when .cursor detected; matchers Write|StrReplace|Edit, Shell|Bash',
    },
    legibility:
      'Hooks native at ~/.cursor/hooks.json on install. AGENTS.md + optional .cursor/rules. MCP still IDE UI.',
  },
  {
    runtimeId: 'cline',
    displayName: 'Cline',
    product: 'Cline (VS Code agent)',
    instructions: {
      files: ['AGENTS.md', '.clinerules/'],
      loadOrder: 'rules + AGENTS.md',
      prjct: 'portable',
    },
    mcp: {
      configPaths: ['Cline MCP settings'],
      format: 'IDE MCP',
      prjct: 'portable',
    },
    skills: {
      paths: ['Cline skills / custom instructions'],
      prjct: 'portable',
    },
    hooks: {
      configPaths: ['Cline hooks (when enabled)'],
      events: ['varies by version'],
      format: 'extension-defined',
      prjct: 'planned',
      contract: 'Multi-model VS Code agent; ACP support for some hosts',
    },
    legibility: 'AGENTS.md + MCP portable; deep native wire planned if hook schema stabilizes.',
  },
] as const

export function getHarnessSurface(runtimeId: AgentRuntimeId): HarnessSurfaceEntry | undefined {
  return BENCHMARK_HARNESS_SURFACES.find((s) => s.runtimeId === runtimeId)
}

export function listHarnessSurfaces(): readonly HarnessSurfaceEntry[] {
  return BENCHMARK_HARNESS_SURFACES
}

/** Compact markdown table for doctor / install / skill injection. */
export function formatHarnessSurfacesMarkdown(opts?: {
  /** Only these runtime ids (default: all benchmark) */
  only?: AgentRuntimeId[]
  /** Include per-surface wire status detail */
  detail?: boolean
}): string {
  const only = opts?.only ? new Set(opts.only) : null
  const rows = BENCHMARK_HARNESS_SURFACES.filter((s) => !only || only.has(s.runtimeId))
  const lines = [
    '## Harness surfaces (benchmark tier)',
    '',
    '| Runtime | Instructions | MCP | Skills | Hooks | prjct wire |',
    '|---|---|---|---|---|---|',
  ]
  for (const s of rows) {
    const wire = summarizeWire(s)
    lines.push(
      `| ${s.displayName} | ${s.instructions.prjct} | ${s.mcp.prjct} | ${s.skills.prjct} | ${s.hooks.prjct} | ${wire} |`
    )
  }
  lines.push(
    '',
    'Wire legend: `native` = prjct installs; `inherits-claude` = covered by Claude install; `portable` = AGENTS.md/MCP/CLI; `planned` = surface exists, installer next.',
    ''
  )
  if (opts?.detail) {
    lines.push('### Integration notes', '')
    for (const s of rows) {
      lines.push(`#### ${s.displayName}`, '', s.legibility, '')
      if (s.hooks.notes) lines.push(`- Hooks: ${s.hooks.notes}`)
      if (s.mcp.notes) lines.push(`- MCP: ${s.mcp.notes}`)
      if (s.skills.notes) lines.push(`- Skills: ${s.skills.notes}`)
      lines.push(`- Hook events: ${s.hooks.events.slice(0, 8).join(', ') || '(none)'}`)
      lines.push(`- MCP paths: ${s.mcp.configPaths.join('; ')}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

function summarizeWire(s: HarnessSurfaceEntry): string {
  const ranks: PrjctWireStatus[] = [
    s.hooks.prjct,
    s.mcp.prjct,
    s.instructions.prjct,
    s.skills.prjct,
  ]
  if (ranks.includes('native')) return 'native+'
  if (ranks.includes('inherits-claude')) return 'via Claude'
  if (ranks.includes('planned')) return 'partial/planned'
  if (ranks.includes('portable')) return 'portable'
  return 'none'
}
