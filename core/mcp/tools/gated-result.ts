/**
 * Gated MCP text result — the delivery gate applied to tool output.
 *
 * Static-ish tool results (analysis, architecture, specs, tier docs…) used
 * to re-pay their full body on every identical call; here a repeat collapses
 * to a ~100-char pointer carrying the full:true escape. Every gated result
 * is also counted into token_usage (`mcp-result:<host>`) so `prjct insights
 * cost` can prove the MCP surface's context tax.
 */

import { detectRuntimeAgent } from '../../services/agent-identity'
import { condenseResult } from '../../services/session-context-cache'
import { recordMcpResultChars } from '../../services/work-cost-service'
import { stateStorage } from '../../storage/state-storage'

export interface GatedTextResult {
  content: Array<{ type: 'text'; text: string }>
}

export async function gatedTextResult(
  projectId: string,
  id: string,
  text: string,
  full?: boolean
): Promise<GatedTextResult> {
  const out = condenseResult(`tool:${projectId}`, id, text, { full }).text
  try {
    const task = await stateStorage.getCurrentTask(projectId)
    recordMcpResultChars(projectId, task?.id, out.length, detectRuntimeAgent())
  } catch {
    /* telemetry only */
  }
  return { content: [{ type: 'text', text: out }] }
}
