/**
 * Shared helpers for Claude Code hook subcommands.
 *
 * Anti-harness contract: hooks describe state, never prescribe action.
 * Output is a short markdown block read as WHAT, not HOW. No "first do
 * X, then Y" language — just "here's who you are, here's what matters
 * right now". Claude decides the rest.
 *
 * All hooks share:
 *   - Never throw (`safeRun`) — exit 0 with `{}` on any internal error
 *     so the host session is never disturbed.
 *   - Short stdin timeout (200ms) — Claude Code pipes fast.
 *   - Keyword matcher — simple substring + regex over prompt text.
 */

import { readSync } from 'node:fs'
import { isatty } from 'node:tty'
import { deburr } from '../utils/deburr'
import { clipHead, clipTail } from '../utils/text-summary'

interface HookOutput {
  /** Top-level informational message. Accepted by every Claude Code hook
   *  event — the only safe channel for Stop, SubagentStart, and
   *  CwdChanged since their response schemas reject
   *  `hookSpecificOutput.additionalContext`. */
  systemMessage?: string
  /** Valid for SessionStart, UserPromptSubmit, PreToolUse, and
   *  PostToolUse. Injects context into the model's turn (stronger than a
   *  user-facing system message). Emitting this on any other event
   *  triggers a schema validation error in Claude Code. */
  hookSpecificOutput?: {
    hookEventName: string
    additionalContext?: string
  }
}

/** Events whose response schema accepts `hookSpecificOutput.additionalContext`. */
const ADDITIONAL_CONTEXT_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
])

/**
 * A PreToolUse DENY decision — the one true per-tool-call block the host
 * contract defines (`permissionDecision`/`Reason` are whitelisted top-level
 * keys). Emitted RIG-AGNOSTICALLY (never gated to Claude): any host that honors
 * a PreToolUse deny blocks the tool call; hosts that don't simply ignore it and
 * fall back to the forceful per-turn injection. The deny channel is how the
 * hard loop guard reaches "all rigs" without prjct owning the loop.
 */
export interface DenyOutput {
  hookSpecificOutput: {
    hookEventName: string
    permissionDecision: 'deny'
    permissionDecisionReason: string
  }
}

export function buildDenyOutput(event: string, reason: string): DenyOutput {
  return {
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'deny',
      permissionDecisionReason: stripLoneSurrogates(reason),
    },
  }
}

/** Host that invoked the hook (Claude default; others remap output). */
export type HookHost = 'claude' | 'gemini' | 'codex' | 'cursor' | 'kimi' | 'pi'

/** Validate a raw host string (env var / daemon request field) into a HookHost. */
export function hookHostFrom(raw: string | undefined | null): HookHost {
  const v = (raw ?? 'claude').trim().toLowerCase()
  if (v === 'gemini' || v === 'codex' || v === 'cursor' || v === 'kimi' || v === 'pi') return v
  return 'claude'
}

export function currentHookHost(): HookHost {
  return hookHostFrom(process.env.PRJCT_HOOK_HOST)
}

/**
 * Host-specific rewrite of Claude-shaped hook payloads.
 * - gemini: BeforeTool/decision deny (geminicli.com/docs/hooks)
 * - cursor: camelCase events + snake_case additional_context
 *   (cursor.com/docs/agent/hooks, verified 2026-08-16)
 * - codex: Claude-compatible shapes (hooks.json mirrors Claude)
 * - kimi: plain-text context on stdout; deny JSON is already Kimi's contract
 *
 * Returns a string when the host expects RAW TEXT on stdout instead of a
 * JSON line (Kimi appends stdout verbatim to context and documents no
 * `additionalContext` JSON field).
 */
export function adaptHookOutputForHost(
  output: HookOutput | DenyOutput | Record<string, never>,
  host: HookHost = currentHookHost()
): Record<string, unknown> | string {
  if (host === 'claude' || host === 'codex') return output as Record<string, unknown>
  if (!output || Object.keys(output).length === 0) return output as Record<string, unknown>

  if (host === 'gemini') return adaptForGemini(output)
  if (host === 'cursor') return adaptForCursor(output)
  if (host === 'kimi') return adaptForKimi(output)
  return output as Record<string, unknown>
}

/**
 * Kimi Code CLI (kimi.com/code/docs …/customization/hooks.html):
 * - exit 0 stdout text is appended to context — so additionalContext and
 *   systemMessage degrade to the bare text, no JSON envelope.
 * - blocking uses the SAME `hookSpecificOutput.permissionDecision` JSON
 *   shape prjct already builds — passed through unchanged.
 */
function adaptForKimi(
  output: HookOutput | DenyOutput | Record<string, never>
): Record<string, unknown> | string {
  const deny = output as DenyOutput
  if (deny.hookSpecificOutput?.permissionDecision === 'deny') {
    return output as Record<string, unknown>
  }
  const out = output as HookOutput
  if (out.hookSpecificOutput?.additionalContext) return out.hookSpecificOutput.additionalContext
  if (out.systemMessage) return out.systemMessage
  return output as Record<string, unknown>
}

function adaptForGemini(
  output: HookOutput | DenyOutput | Record<string, never>
): Record<string, unknown> {
  const deny = output as DenyOutput
  if (deny.hookSpecificOutput?.permissionDecision === 'deny') {
    return {
      decision: 'deny',
      reason: deny.hookSpecificOutput.permissionDecisionReason ?? 'blocked by prjct',
    }
  }
  const out = output as HookOutput
  const hso = out.hookSpecificOutput
  if (hso?.additionalContext) {
    return {
      hookSpecificOutput: {
        hookEventName: mapClaudeEventToGemini(hso.hookEventName),
        additionalContext: hso.additionalContext,
      },
    }
  }
  if (out.systemMessage) return { systemMessage: out.systemMessage }
  return output as Record<string, unknown>
}

function adaptForCursor(
  output: HookOutput | DenyOutput | Record<string, never>
): Record<string, unknown> {
  const deny = output as DenyOutput
  if (deny.hookSpecificOutput?.permissionDecision === 'deny') {
    // Cursor preToolUse commonly accepts permissionDecision or decision.
    return {
      decision: 'deny',
      reason: deny.hookSpecificOutput.permissionDecisionReason ?? 'blocked by prjct',
      permissionDecision: 'deny',
      permissionDecisionReason:
        deny.hookSpecificOutput.permissionDecisionReason ?? 'blocked by prjct',
    }
  }
  const out = output as HookOutput
  const hso = out.hookSpecificOutput
  if (hso?.additionalContext) {
    const event = mapClaudeEventToCursor(hso.hookEventName)
    // Official Cursor hooks schema (https://cursor.com/docs/agent/hooks, verified
    // 2026-08-16) documents ONLY snake_case `additional_context` — top-level for
    // sessionStart/postToolUse; camelCase `additionalContext` is Claude Code's
    // field and appears nowhere in Cursor's schema, so it was dropped. The
    // nested hookSpecificOutput copy stays as cheap insurance: whether Cursor's
    // Claude-compat loader reads that envelope is undocumented.
    return {
      hookSpecificOutput: {
        hookEventName: event,
        additional_context: hso.additionalContext,
      },
      additional_context: hso.additionalContext,
    }
  }
  if (out.systemMessage) return { systemMessage: out.systemMessage }
  return output as Record<string, unknown>
}

function mapClaudeEventToGemini(event: string): string {
  switch (event) {
    case 'UserPromptSubmit':
      return 'BeforeAgent'
    case 'PreToolUse':
      return 'BeforeTool'
    case 'PostToolUse':
      return 'AfterTool'
    case 'Stop':
      return 'AfterAgent'
    default:
      return event
  }
}

function mapClaudeEventToCursor(event: string): string {
  switch (event) {
    case 'SessionStart':
      return 'sessionStart'
    case 'UserPromptSubmit':
      return 'beforeSubmitPrompt'
    case 'PreToolUse':
      return 'preToolUse'
    case 'PostToolUse':
      return 'postToolUse'
    case 'Stop':
      return 'stop'
    case 'SubagentStart':
      return 'subagentStart'
    case 'SubagentStop':
      return 'subagentStop'
    default:
      return event.charAt(0).toLowerCase() + event.slice(1)
  }
}

/**
 * Sync-read stdin via fs.readSync on fd 0 directly — never READS through
 * `process.stdin`, whose stream wrapper costs event-loop turnaround per
 * hook. We still touch `process.stdin.fd` once up front: on node (the
 * production runtime) creating the wrapper flips fd 0 non-blocking, so an
 * open-but-empty pipe yields EAGAIN and the `timeoutMs` deadline below is
 * REAL — a host that opens stdin but never closes degrades to whatever
 * arrived instead of hanging until the host's hook-timeout kill. On bun
 * (dev-only) the fd stays blocking and the deadline only governs EAGAIN
 * retries; the host-side hook timeout remains the backstop there. Retries
 * sleep ~1ms via Atomics.wait so a slow-to-flush host doesn't busy-spin.
 *
 * Shared busy-wait/EAGAIN-retry core for both this module's JSON-parsing
 * `readStdinSafe` and the cold-entry raw-string reader (mirrors bin/prjct.ts
 * `readStdinSync`) — same loop, different timeout and post-processing.
 */
export function readStdinRaw(timeoutMs: number): Buffer {
  if (isatty(0)) return Buffer.alloc(0)
  try {
    void process.stdin.fd
  } catch {
    // stdin fd unavailable — readSync below fails and degrades to empty
  }
  const deadline = Date.now() + timeoutMs
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  const buf = Buffer.alloc(65536)
  const parts: Buffer[] = []
  for (;;) {
    try {
      const n = readSync(0, buf, 0, buf.length, null)
      if (n === 0) break
      parts.push(Buffer.from(buf.subarray(0, n)))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN' && Date.now() < deadline) {
        Atomics.wait(sleeper, 0, 0, 1)
        continue
      }
      break
    }
  }
  return Buffer.concat(parts)
}

export function readStdinSafe<T = Record<string, unknown>>(): T {
  try {
    const raw = readStdinRaw(200).toString('utf-8').trim()
    if (!raw) return {} as T
    return JSON.parse(raw) as T
  } catch {
    return {} as T
  }
}

/**
 * Emit the hook's output and exit 0. Both success and no-op paths
 * should flow through this — it guarantees a valid line on stdout
 * so the host parser is happy. Hosts that take raw text (Kimi) get
 * the bare string; everyone else gets the JSON envelope.
 */
export function emit(output: HookOutput | DenyOutput | Record<string, never>): void {
  const adapted = adaptHookOutputForHost(output)
  process.stdout.write(
    typeof adapted === 'string' ? `${adapted}\n` : `${JSON.stringify(adapted)}\n`
  )
}

function emitEmpty(): void {
  emit({})
}

/**
 * Wrap a hook body so any thrown error becomes `{}` instead of a crash.
 * If the host kills the process mid-execution, the cost is just "no
 * context injected this turn" — the next hook will retry fresh.
 */
export async function safeRun(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch {
    emitEmpty()
  }
}

/**
 * Cheap keyword extraction — unique tokens ≥ 3 chars, max 8.
 *
 * Pre-splits camelCase / PascalCase so `setupOAuthCallback` yields
 * `setup`, `oauth`, `callback` AND the compound dashed form, both
 * useful as FTS5 match candidates. Stopwords trimmed to true noise
 * (articles, demonstratives, pronouns) — coding-intent verbs like
 * `need`/`want`/`should` stay, since "should we cache responses?"
 * loses signal otherwise.
 *
 * Unicode-aware: tokens are deburred ("búsqueda" → "busqueda", matching
 * FTS5 unicode61's remove_diacritics indexing) and split on any
 * non-letter/digit, so Spanish/mixed-language prompts produce real
 * keywords instead of mangled fragments (the old `[^a-z0-9]` split
 * turned "qué pasó" into nothing). Spanish function words join the
 * stopword list — the user prompts in Spanish even though stored
 * memories are English, and technical terms (daemon, cache, sync) pass
 * through either way.
 */
const STOPWORDS = new Set([
  // English noise
  'this',
  'that',
  'with',
  'from',
  'have',
  'your',
  'please',
  'would',
  'about',
  'there',
  'these',
  'those',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'been',
  'were',
  'they',
  'them',
  'their',
  // Spanish noise (post-deburr forms; ≥3 chars — shorter never tokenizes)
  'que',
  'como',
  'cuando',
  'donde',
  'porque',
  'para',
  'pero',
  'por',
  'con',
  'sin',
  'los',
  'las',
  'del',
  'una',
  'uno',
  'unos',
  'unas',
  'este',
  'esta',
  'esto',
  'estos',
  'estas',
  'eso',
  'esos',
  'esas',
  'mas',
  'muy',
  'todo',
  'toda',
  'todos',
  'todas',
  'sobre',
  'entre',
  'hasta',
  'desde',
  'hace',
  'hacer',
  'tiene',
  'tienen',
  'debe',
  'deben',
  'puede',
  'pueden',
  'estan',
  'ser',
  'son',
  'algo',
  'ahora',
  'aqui',
  'bien',
  'cada',
  'dale',
])

export function extractKeywords(text: string, maxCount = 8): string[] {
  // setupOAuthCallback → setup OAuth Callback → setup oauth callback,
  // then tokenize on every non-word boundary (dash, space, punctuation).
  // Yields atomic tokens ['setup', 'oauth', 'callback'] so an FTS5 MATCH
  // can OR them and still find a memory entry that mentions any one.
  const normalized = deburr(
    text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  ).toLowerCase()
  const seen = new Set<string>()
  const out: string[] = []
  for (const tok of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (tok.length < 3) continue
    if (STOPWORDS.has(tok)) continue
    if (seen.has(tok)) continue
    seen.add(tok)
    out.push(tok)
    if (out.length >= maxCount) break
  }
  return out
}

/**
 * Replace any unpaired UTF-16 surrogate with U+FFFD.
 *
 * JS strings are UTF-16; an astral character (emoji, non-BMP CJK) is a
 * high+low surrogate pair. A lone surrogate — a high not followed by a
 * low, or a low not preceded by a high — is a well-formed JS string but
 * NOT representable in UTF-8. When Claude Code forwards our injected
 * context into the model request body, the Anthropic API rejects it
 * with `400 ... no low surrogate in string`, killing the user's turn.
 *
 * Two ways a lone surrogate reaches us: (1) truncation cutting between a
 * pair — handled at the source by `safeTruncate` — and (2) corrupted
 * source content captured by a user. This scrub at the single emit
 * choke point (`buildHookOutput`) defends against both, for every hook.
 */
export function stripLoneSurrogates(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
}

/**
 * Truncate `s` to at most `max` UTF-16 units on CLAUSE boundaries — never
 * inside a word, never across a surrogate pair.
 *
 * With `tailChars > 0` the result is head + marker + tail instead of head +
 * marker. In guidance text the action usually sits at the END, so a head-only
 * cut keeps the preamble and drops the instruction. `flattenToolInputText`
 * (core/utils/secret-scanner.ts) already retains both ends for the same
 * reason: keeping only the prefix lets padding hide what matters. Default 0,
 * so every existing caller is unchanged until it opts in. A naive `s.slice(0, n)` can land
 * between a high and low surrogate, leaving a trailing lone high
 * surrogate that makes the API request body invalid JSON (see
 * `stripLoneSurrogates`). If the last retained unit is a high surrogate
 * we drop it, so the cut always lands on a code-point boundary.
 */
export function safeTruncate(
  s: string,
  max: number,
  marker = '\n… [truncated]',
  tailChars = 0
): string {
  if (s.length <= max) return s
  const budget = Math.max(0, max - marker.length)
  const tail = Math.min(Math.max(0, tailChars), Math.max(0, budget - 1))
  const head = clipHead(s, budget - tail)
  if (tail <= 0) return head + marker
  return head + marker + clipTail(s, tail)
}

export function buildHookOutput(event: string, context: string | null): HookOutput {
  if (!context) return {}
  const safe = stripLoneSurrogates(context)
  if (ADDITIONAL_CONTEXT_EVENTS.has(event)) {
    return { hookSpecificOutput: { hookEventName: event, additionalContext: safe } }
  }
  return { systemMessage: safe }
}
