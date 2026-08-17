/**
 * Owned agent loop types (print / one-shot mode).
 * Guest harnesses are unaffected — this runs only when owned LLM is enabled.
 */

import type { ChatMessage, ChatToolCall, ChatToolDef, LlmProvider } from '../llm'

export interface AgentToolContext {
  /** Absolute project root; all relative paths resolve under this. */
  root: string
  /** Soft cap for bash / read sizes */
  maxReadBytes?: number
  maxBashMs?: number
  maxBashOutputBytes?: number
}

export interface AgentToolResult {
  ok: boolean
  /** Text returned to the model */
  content: string
}

export interface AgentTool {
  name: string
  description: string
  /** JSON Schema object for function parameters */
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>, ctx: AgentToolContext): Promise<AgentToolResult>
}

export interface AgentRunOptions {
  intent: string
  root: string
  provider: LlmProvider
  maxSteps?: number
  /** Inject tools (tests); default = built-in registry */
  tools?: AgentTool[]
  /** Extra system instructions */
  systemAppend?: string
  onStep?: (event: AgentStepEvent) => void
  timeoutMsPerGenerate?: number
  /**
   * Work cycle this run is bound to (from prepareOwnedAgentWorkContext).
   * When both are set, accumulated completion.usage is recorded against the
   * task so owned runs show up in `prjct performance`. Fail-soft.
   */
  projectId?: string
  taskId?: string
}

export type AgentStepEvent =
  | { type: 'generate'; step: number }
  | { type: 'assistant'; step: number; content: string | null; tool_calls: ChatToolCall[] }
  | { type: 'tool'; step: number; name: string; ok: boolean; preview: string }
  | { type: 'done'; step: number; content: string | null }

export interface AgentRunResult {
  success: boolean
  content: string | null
  steps: number
  toolCalls: number
  messages: ChatMessage[]
  error?: string
  profile: string
  model: string
}

export function toolsToChatDefs(tools: AgentTool[]): ChatToolDef[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}
