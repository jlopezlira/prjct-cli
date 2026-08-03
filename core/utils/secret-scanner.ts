/**
 * Secret scanner shared by `prjct remember`, the wiki ingest service,
 * PreToolUse credential guard, and (Phase 1.5 / B7) the prjct-cloud server.
 *
 * **Standalone contract** — this file MUST stay free of imports from
 * `path-manager`, `storage/*`, `infrastructure/*`, anything that
 * touches the filesystem or SQLite. Pure regex matching, no I/O.
 * Server-side reuse depends on this. If you add a new dependency
 * here, the cloud's secret-scanner package will fail to load and
 * events containing secrets will leak into the database.
 *
 * Conservative list — any hit triggers a warning (or PreToolUse deny).
 * Better a false positive than a committed / exfiltrated key.
 *
 * Public API is intentionally load-bearing:
 *   - `scanForSecrets(text: string): string[]` — names of patterns hit
 *   - `scanHookToolInput(input: unknown): string[]` — walk agent tool
 *     payloads (Claude + Gemini shapes) and scan every string with bounded
 *     working memory
 *
 * The API is treated as load-bearing. Renames or removals must update
 * both prjct-cli and the cloud package in lockstep.
 */

const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'sk-… token', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 'prjct live token', re: /\bprjct_sk_(?:live|test)_[A-Za-z0-9_-]{8,}/ },
  { name: 'GitHub PAT', re: /\bghp_[A-Za-z0-9]{30,}/ },
  { name: 'GitHub server PAT', re: /\bghs_[A-Za-z0-9]{30,}/ },
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[abps]-[A-Za-z0-9-]{10,}/ },
  { name: 'Supabase access token', re: /\bsbp_[A-Za-z0-9]{20,}/ },
  { name: 'OpenAI project key', re: /\bsk-proj-[A-Za-z0-9_-]{20,}/ },
  {
    name: 'bearer JWT-ish',
    re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
  },
  {
    name: 'PEM private key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
]

export function scanForSecrets(text: string): string[] {
  if (!text) return []
  const hits: string[] = []
  for (const { name, re } of SECRET_PATTERNS) if (re.test(text)) hits.push(name)
  return hits
}

/**
 * Walk an unknown tool payload and collect string leaves for scanning.
 * Host-agnostic: Claude (`command`, `file_path`, `content`) and Gemini
 * (`run_shell_command` args, `write_file` contents) all flatten the same way.
 * Caps retained text so a huge paste cannot OOM the hook. When input exceeds
 * the cap, retain both the head and tail: keeping only the prefix lets padding
 * hide a credential at the end of an otherwise valid tool payload.
 */
export function flattenToolInputText(input: unknown, maxChars = 200_000): string {
  const limit = Math.max(0, maxChars)
  const headLimit = Math.ceil(limit / 2)
  const tailLimit = Math.floor(limit / 2)
  let head = ''
  let tail = ''
  let full: string | null = ''
  let totalChars = 0
  let hasPart = false

  const push = (s: string) => {
    if (!s || limit === 0) return
    const chunk = `${hasPart ? '\n' : ''}${s}`
    hasPart = true
    totalChars += chunk.length

    if (full !== null) {
      if (totalChars <= limit) full += chunk
      else full = null
    }

    if (head.length < headLimit) head += chunk.slice(0, headLimit - head.length)
    if (tailLimit > 0) {
      tail =
        chunk.length >= tailLimit ? chunk.slice(-tailLimit) : `${tail}${chunk}`.slice(-tailLimit)
    }
  }

  const walk = (v: unknown, depth: number) => {
    if (depth > 8) return
    if (typeof v === 'string') {
      push(v)
      return
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1)
      return
    }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        // Keys sometimes carry secret names; scan both key and value path labels lightly
        if (/token|secret|password|api[_-]?key|authorization/i.test(k) && typeof val === 'string') {
          push(`${k}=${val}`)
        } else {
          walk(val, depth + 1)
        }
      }
    }
  }

  walk(input, 0)
  if (full !== null) return full
  return totalChars > limit ? `${head}\n${tail}` : head
}

const TOOL_INPUT_CHUNK_CHARS = 64 * 1024
const TOOL_INPUT_CHUNK_OVERLAP = 512

function addSecretHits(text: string, hits: Set<string>): void {
  if (!text) return
  if (text.length <= 200_000) {
    for (const hit of scanForSecrets(flattenToolInputText(text))) hits.add(hit)
    return
  }

  const step = TOOL_INPUT_CHUNK_CHARS - TOOL_INPUT_CHUNK_OVERLAP
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(text.length, start + TOOL_INPUT_CHUNK_CHARS)
    for (const hit of scanForSecrets(text.slice(start, end))) hits.add(hit)
    if (end === text.length) break
  }
}

/** Scan every string leaf without retaining or concatenating the full payload. */
function scanUnknownStrings(input: unknown, hits: Set<string>): void {
  const stack: unknown[] = [input]
  const seen = new WeakSet<object>()

  while (stack.length > 0) {
    const value = stack.pop()
    if (typeof value === 'string') {
      addSecretHits(value, hits)
      continue
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)

    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push(value[i])
      continue
    }

    const entries = Object.entries(value as Record<string, unknown>)
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, nested] = entries[i]
      if (
        /token|secret|password|api[_-]?key|authorization/i.test(key) &&
        typeof nested === 'string'
      ) {
        stack.push(`${key}=${nested}`)
      } else {
        stack.push(nested)
      }
    }
  }
}

/**
 * Scan a PreToolUse / BeforeTool payload for credential material.
 * Accepts the full hook stdin object or just `tool_input`.
 */
export function scanHookToolInput(payload: unknown): string[] {
  if (payload == null) return []
  // Prefer tool_input / toolInput when present; also scan top-level for Gemini variants
  const obj = payload as Record<string, unknown>
  const toolInput = obj.tool_input ?? obj.toolInput ?? obj.parameters ?? payload
  const hits = new Set<string>()
  scanUnknownStrings(toolInput, hits)
  // Also scan shell command fields that hosts put at top level
  for (const extra of [obj.command, obj.prompt, obj.content]) {
    if (typeof extra === 'string') addSecretHits(extra, hits)
  }
  return [...hits]
}

/**
 * Managed hook commands must not reference host-specific env like `$PPID`.
 * Gemini (and other sanitized-env hosts) refuse hooks whose commands require
 * env vars they do not inject — which silently skips security MUST hooks.
 */
export function hookCommandUsesFragileEnv(command: string): boolean {
  // PPID is shell-special but NOT in Gemini's sanitized env allowlist.
  // Also flag bare ${VAR} required-env patterns that are not portable GEMINI_/PRJCT_ vars.
  if (/\$\{?PPID\}?/.test(command)) return true
  if (/\$\{SUPACODE_[A-Z0-9_]+\}/.test(command)) return true
  if (/\$\{P_TERM_[A-Z0-9_]+\}/.test(command)) return true
  return false
}
