/**
 * Anthropic Messages API adapter for subscription Claude without Claude Code.
 * Maps to the same ChatCompletionResult surface as OpenAI-compat.
 *
 * Message packing rules (Anthropic API):
 * - system is top-level, not a message role
 * - messages must alternate user/assistant
 * - consecutive same-role turns are merged (multi tool_result, etc.)
 * - first message must be user (bridge inserted if needed)
 */

import { fetchJson } from './http'
import type {
  ChatCompletionResult,
  ChatMessage,
  ChatToolCall,
  ChatToolDef,
  LlmProfile,
} from './types'
import { LLM_DEFAULT_TIMEOUT_MS } from './types'

const ANTHROPIC_VERSION = '2023-06-01'

type AnthRole = 'user' | 'assistant'
type AnthMsg = { role: AnthRole; content: unknown }

/**
 * Convert OpenAI-style messages to Anthropic Messages format.
 * Exported for unit tests.
 */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string
  messages: AnthMsg[]
} {
  const systemMessages: string[] = []
  const out: AnthMsg[] = []

  const push = (role: AnthRole, content: unknown) => {
    const last = out[out.length - 1]
    if (last?.role === role) {
      last.content = mergeContent(last.content, content)
      return
    }
    out.push({ role, content })
  }

  for (const m of messages) {
    if (m.role === 'system') {
      const t = m.content ?? ''
      if (t) systemMessages.push(t)
      continue
    }
    if (m.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id ?? 'tool',
          content: m.content ?? '',
        },
      ])
      continue
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks: unknown[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls) {
        const input = (() => {
          try {
            return JSON.parse(tc.function.arguments || '{}') as unknown
          } catch {
            return { raw: tc.function.arguments }
          }
        })()
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        })
      }
      push('assistant', blocks)
      continue
    }
    if (m.role === 'user') {
      push('user', m.content ?? '')
      continue
    }
    if (m.role === 'assistant') {
      push('assistant', m.content ?? '')
    }
  }

  // Anthropic requires the first message to be user.
  if (out.length > 0 && out[0]?.role === 'assistant') {
    out.unshift({ role: 'user', content: '(continue)' })
  }

  return { system: systemMessages.join('\n\n') || undefined, messages: out }
}

function mergeContent(a: unknown, b: unknown): unknown {
  return [...toBlockArray(a), ...toBlockArray(b)]
}

function toBlockArray(c: unknown): unknown[] {
  if (Array.isArray(c)) return c
  if (typeof c === 'string') return c ? [{ type: 'text', text: c }] : []
  if (c == null) return []
  return [c]
}

function toAnthropicTools(tools: ChatToolDef[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters ?? { type: 'object', properties: {} },
  }))
}

export async function anthropicChat(
  profile: LlmProfile,
  opts: {
    messages: ChatMessage[]
    tools?: ChatToolDef[]
    temperature?: number
    max_tokens?: number
    timeoutMs?: number
  },
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<ChatCompletionResult> {
  const { system, messages } = toAnthropicMessages(opts.messages)
  const body: Record<string, unknown> = {
    model: profile.model,
    max_tokens: opts.max_tokens ?? 4096,
    messages,
  }
  if (system) body.system = system
  if (opts.temperature !== undefined) body.temperature = opts.temperature
  const tools = toAnthropicTools(opts.tools)
  if (tools) body.tools = tools

  const base = profile.baseUrl.replace(/\/+$/, '')
  const url = base.includes('/v1/messages') ? base : `${base}/v1/messages`

  const { json } = await fetchJson(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        ...(profile.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs ?? LLM_DEFAULT_TIMEOUT_MS,
    },
    fetchImpl
  )
  return parseAnthropicResponse(json, profile.model)
}

export function parseAnthropicResponse(json: unknown, fallbackModel: string): ChatCompletionResult {
  const obj = json as {
    model?: string
    stop_reason?: string | null
    content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  const blocks = obj.content ?? []
  const textParts: string[] = []
  const tool_calls: ChatToolCall[] = []
  for (const b of blocks) {
    if (b.type === 'text' && b.text) textParts.push(b.text)
    if (b.type === 'tool_use' && b.name) {
      tool_calls.push({
        id: b.id ?? `toolu_${tool_calls.length}`,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      })
    }
  }
  const inTok = obj.usage?.input_tokens ?? 0
  const outTok = obj.usage?.output_tokens ?? 0
  return {
    content: textParts.length ? textParts.join('\n') : null,
    tool_calls,
    model: obj.model ?? fallbackModel,
    usage: obj.usage
      ? {
          prompt_tokens: obj.usage.input_tokens,
          completion_tokens: obj.usage.output_tokens,
          total_tokens: inTok + outTok > 0 ? inTok + outTok : undefined,
        }
      : undefined,
    finish_reason: obj.stop_reason ?? null,
    raw: json,
  }
}
