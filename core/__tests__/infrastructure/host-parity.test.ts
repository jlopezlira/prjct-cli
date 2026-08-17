/**
 * Host parity guard (plan 1.0): the surface prjct installs must not drift
 * between coding-agent hosts. Cross-checks three sources of truth:
 *
 *  1. AGENT_RUNTIME_REGISTRY (infrastructure/agent-runtime-registry.ts) —
 *     declares per-runtime capabilities (`supports.hooks`, `mcp`, ...).
 *  2. Hook installer modules — one per hook-capable full-support runtime.
 *  3. KNOWN_AGENTS (services/agent-identity.ts) — runtimes the hooks can
 *     attribute telemetry to (a host missing here silently falls back to
 *     ambient detection, the bug class behind mem_15019-style gaps).
 *
 * A failure here means a host gained/lost a surface without updating the
 * others — update the mapping tables below deliberately.
 */

import { describe, expect, it } from 'bun:test'
import {
  AGENT_RUNTIME_REGISTRY,
  type AgentRuntimeId,
} from '../../infrastructure/agent-runtime-registry'
import { KNOWN_AGENTS } from '../../services/agent-identity'

/** Registry id → hook installer module (only runtimes with a real installer). */
const HOOK_INSTALLERS: Record<string, () => Promise<Record<string, unknown>>> = {
  claude: () => import('../../services/settings-installer'),
  'kimi-cli': () => import('../../utils/kimi-hooks'),
  cursor: () => import('../../utils/cursor-hooks'),
  gemini: () => import('../../utils/gemini-settings'),
  codex: () => import('../../utils/codex-hooks'),
}

/** Registry id → KNOWN_AGENTS id when they differ (kimi-cli ↔ kimi). */
const REGISTRY_TO_KNOWN_AGENT: Partial<Record<AgentRuntimeId, string>> = {
  'kimi-cli': 'kimi',
}

const FULL_SUPPORT: ReadonlySet<AgentRuntimeId> = new Set([
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

describe('host parity', () => {
  it('every full-support runtime with supports.hooks has a hook installer', () => {
    const missing = AGENT_RUNTIME_REGISTRY.filter(
      (r) => FULL_SUPPORT.has(r.id) && r.supports.hooks && !(r.id in HOOK_INSTALLERS)
    ).map((r) => r.id)
    // cline/grok claim hooks via Claude-compat — if that changes to a native
    // installer, add it to HOOK_INSTALLERS and drop it here.
    const claudeCompat = ['cline', 'grok']
    expect(missing.filter((id) => !claudeCompat.includes(id))).toEqual([])
  })

  it('every hook installer exposes install + uninstall (+ status where available)', async () => {
    for (const [id, load] of Object.entries(HOOK_INSTALLERS)) {
      const mod = await load()
      const fns = Object.keys(mod).filter((k) => typeof mod[k] === 'function')
      expect(
        fns.some((f) => /^install/i.test(f)),
        `${id} installer`
      ).toBe(true)
      expect(
        fns.some((f) => /^uninstall/i.test(f)),
        `${id} uninstaller`
      ).toBe(true)
    }
  })

  it('every runtime with a hook installer is attributable in KNOWN_AGENTS', () => {
    for (const id of Object.keys(HOOK_INSTALLERS)) {
      const known = REGISTRY_TO_KNOWN_AGENT[id as AgentRuntimeId] ?? id
      expect(KNOWN_AGENTS.has(known), `${id} → ${known}`).toBe(true)
    }
  })

  it('every KNOWN_AGENTS entry (except unknown) exists in the runtime registry', () => {
    const registryIds = new Set<string>([
      ...AGENT_RUNTIME_REGISTRY.map((r) => r.id),
      ...Object.values(REGISTRY_TO_KNOWN_AGENT).map(String),
    ])
    const missing = [...KNOWN_AGENTS].filter((a) => a !== 'unknown' && !registryIds.has(a))
    expect(missing).toEqual([])
  })

  it('every full-support runtime with supports.mcp declares an MCP target', () => {
    // A declared target documents WHERE the host's MCP config lives; writable
    // means prjct's installer writes it, non-writable means in-app config.
    const noTarget = AGENT_RUNTIME_REGISTRY.filter(
      (r) => FULL_SUPPORT.has(r.id) && r.supports.mcp && (r.mcpTargets ?? []).length === 0
    ).map((r) => r.id)
    // pi has no built-in MCP by design (pi.dev contract: skills + CLI --md).
    const byDesign = ['pi']
    expect(noTarget.filter((id) => !byDesign.includes(id))).toEqual([])
  })
})
