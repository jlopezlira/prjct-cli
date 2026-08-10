/**
 * Resolve who is calling prjct — runtime (claude/codex/…) + identity string.
 *
 * Used to stamp live work cycles (who started) and to match switch/accept
 * handoffs to the right target. Prefer env signals from the host over
 * installed-CLI detection: a machine may have Claude + Codex both installed
 * while only one is driving this terminal.
 */

import { pickCodename } from './agent-codenames'

export interface AgentIdentity {
  /** Runtime id: claude | codex | gemini | grok | cursor | unknown */
  agent: string
  /** Display identity: PRJCT_AGENT, codename, or short fallback */
  identity: string
  /** Host session id when available */
  sessionId?: string
}

const KNOWN_AGENTS = new Set([
  'claude',
  'codex',
  'gemini',
  'grok',
  'cursor',
  'opencode',
  'pi',
  'antigravity',
  'unknown',
])

/**
 * Detect the active coding-agent runtime from process env (no shell probes).
 * Explicit `PRJCT_AGENT_RUNTIME` wins; then host-specific markers.
 */
export function detectRuntimeAgent(): string {
  const explicit = process.env.PRJCT_AGENT_RUNTIME?.trim().toLowerCase()
  if (explicit && KNOWN_AGENTS.has(explicit)) return explicit
  if (explicit) return explicit.slice(0, 32)

  if (process.env.CLAUDE_AGENT || process.env.ANTHROPIC_CLAUDE || process.env.CLAUDECODE) {
    return 'claude'
  }
  if (process.env.CODEX_SANDBOX || process.env.PRJCT_SANDBOX === '1') {
    return 'codex'
  }
  if (process.env.GEMINI_CLI || process.env.GEMINI_API_KEY) {
    return 'gemini'
  }
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_AGENT || process.env.CURSOR_SESSION_ID) {
    return 'cursor'
  }
  if (process.env.GROK_API_KEY || process.env.XAI_API_KEY || process.env.GROK_SESSION) {
    return 'grok'
  }
  if (process.env.OPENCODE || process.env.OPENCODE_SESSION || process.env.OPENCODE_CONFIG) {
    return 'opencode'
  }
  if (process.env.PI_CODING_AGENT_DIR || process.env.PI_SESSION || process.env.PI_AGENT) {
    return 'pi'
  }
  return 'unknown'
}

/**
 * Resolve full caller identity for task stamping and handoff matching.
 * `seed` stabilizes the fallback codename (e.g. task description).
 */
export function resolveCallerIdentity(seed = 'session'): AgentIdentity {
  const agent = detectRuntimeAgent()
  const sessionId =
    process.env.CLAUDE_SESSION_ID ||
    process.env.CODEX_SESSION_ID ||
    process.env.PRJCT_SESSION_ID ||
    undefined

  const fromEnv = process.env.PRJCT_AGENT?.trim()
  const identity =
    fromEnv && fromEnv.length > 0 ? fromEnv : pickCodename(`identity:${agent}:${seed}`)

  return { agent, identity, sessionId }
}

/** Normalize a user-supplied target agent name (`Codex` → `codex`). */
export function normalizeAgentName(raw: string): string {
  const t = raw.trim().toLowerCase()
  if (t === 'claude-code' || t === 'anthropic') return 'claude'
  if (t === 'openai' || t === 'oai') return 'codex'
  if (t === 'google') return 'gemini'
  if (t === 'xai' || t === 'grok-build') return 'grok'
  if (t === 'opencode-ai' || t === 'open-code') return 'opencode'
  if (t === 'pi-coding-agent' || t === 'pi-agent') return 'pi'
  return t.slice(0, 32)
}

/** True when two identities likely belong to the same agent session. */
export function sameOwner(
  a: { ownerAgent?: string; ownerIdentity?: string; ownerSessionId?: string } | null | undefined,
  b: AgentIdentity
): boolean {
  if (!a) return false
  if (a.ownerSessionId && b.sessionId && a.ownerSessionId === b.sessionId) return true
  if (a.ownerIdentity && b.identity && a.ownerIdentity === b.identity) return true
  // Same runtime alone is NOT enough — two Claudes in two terminals are different owners.
  return false
}
