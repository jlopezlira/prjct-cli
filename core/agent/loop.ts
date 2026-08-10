/**
 * Owned agent loop — print / one-shot mode.
 *
 * Uses resolveLlmProvider brains + built-in tools. Guest hosts untouched.
 */

import type { ChatMessage, ChatToolCall } from '../llm'
import { defaultTools, getToolMap } from './tools'
import {
  type AgentRunOptions,
  type AgentRunResult,
  type AgentToolContext,
  toolsToChatDefs,
} from './types'

const DEFAULT_MAX_STEPS = 12

export function buildSystemPrompt(root: string, append?: string): string {
  const base = [
    'You are prjct owned agent (print mode): a careful coding agent.',
    `Project root: ${root}`,
    'Use tools to inspect and edit files. Prefer edit over write for small changes.',
    'Prefer prjct_search for project knowledge and prjct_guard before risky edits.',
    'Persist non-obvious outcomes with prjct_remember (English).',
    'A work cycle may already be open for this intent; use prjct_work only if none is active.',
    'Stay inside the project. Do not touch secrets (.env, keys, credentials).',
    'When done, respond with a short summary of what you changed — no more tool calls.',
    'If the task is unclear or impossible, say so without inventing files.',
  ].join('\n')
  return append ? `${base}\n\n${append}` : base
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}')
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    return { value: v }
  } catch {
    return { raw }
  }
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const tools = opts.tools ?? defaultTools()
  const toolMap = getToolMap(tools)
  const defs = toolsToChatDefs(tools)
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS
  const ctx: AgentToolContext = { root: opts.root }
  const profile = opts.provider.profile

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(opts.root, opts.systemAppend) },
    { role: 'user', content: opts.intent },
  ]

  const runState = { toolCalls: 0, steps: 0 }

  try {
    for (const step of Array.from({ length: maxSteps }, (_, index) => index + 1)) {
      runState.steps = step
      opts.onStep?.({ type: 'generate', step })

      const completion = await opts.provider.generate({
        messages,
        tools: defs,
        temperature: 0.2,
        max_tokens: 4096,
        timeoutMs: opts.timeoutMsPerGenerate,
      })

      const calls = completion.tool_calls ?? []
      opts.onStep?.({
        type: 'assistant',
        step,
        content: completion.content,
        tool_calls: calls,
      })

      if (calls.length === 0) {
        opts.onStep?.({ type: 'done', step, content: completion.content })
        return {
          success: true,
          content: completion.content,
          steps: runState.steps,
          toolCalls: runState.toolCalls,
          messages: [
            ...messages,
            { role: 'assistant', content: completion.content, tool_calls: undefined },
          ],
          profile: profile.name,
          model: completion.model || profile.model,
        }
      }

      // Assistant turn with tool calls
      messages.push({
        role: 'assistant',
        content: completion.content,
        tool_calls: calls,
      })

      for (const call of calls) {
        runState.toolCalls++
        const result = await executeToolCall(call, toolMap, ctx)
        const preview = result.content.slice(0, 200)
        opts.onStep?.({
          type: 'tool',
          step,
          name: call.function.name,
          ok: result.ok,
          preview,
        })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.content,
          name: call.function.name,
        })
      }
    }

    return {
      success: false,
      content: null,
      steps: runState.steps,
      toolCalls: runState.toolCalls,
      messages,
      error: `Reached maxSteps (${maxSteps}) without a final answer`,
      profile: profile.name,
      model: profile.model,
    }
  } catch (e) {
    return {
      success: false,
      content: null,
      steps: runState.steps,
      toolCalls: runState.toolCalls,
      messages,
      error: e instanceof Error ? e.message : String(e),
      profile: profile.name,
      model: profile.model,
    }
  }
}

async function executeToolCall(
  call: ChatToolCall,
  toolMap: Map<string, ReturnType<typeof defaultTools>[number]>,
  ctx: AgentToolContext
): Promise<{ ok: boolean; content: string }> {
  const tool = toolMap.get(call.function.name)
  if (!tool) {
    return { ok: false, content: `Unknown tool: ${call.function.name}` }
  }
  const args = parseToolArgs(call.function.arguments)
  return tool.execute(args, ctx)
}
