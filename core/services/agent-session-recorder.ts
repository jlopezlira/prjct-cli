import prjctDb from '../storage/database'

interface AgentSessionStartInput {
  projectId: string
  sessionId?: string | null
  directory?: string | null
  taskId?: string | null
  goal?: string | null
}

interface AgentSessionEndInput extends AgentSessionStartInput {
  tokensIn?: number
  tokensOut?: number
  agent?: string
  model?: string
  filesTouched?: string[]
}

function cleanText(value: string | null | undefined, max = 500): string | null {
  const normalized = value?.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`
}

function summary(input: AgentSessionEndInput): string | null {
  const parts: string[] = []
  if (input.agent) parts.push(`agent=${input.agent}`)
  if ((input.tokensIn ?? 0) + (input.tokensOut ?? 0) > 0) {
    parts.push(`tokens_in=${Math.round(input.tokensIn ?? 0)}`)
    parts.push(`tokens_out=${Math.round(input.tokensOut ?? 0)}`)
  }
  if (input.filesTouched && input.filesTouched.length > 0) {
    parts.push(`files_touched=${input.filesTouched.length}`)
  }
  return parts.length === 0 ? null : parts.join(' ')
}

export function recordAgentSessionStart(input: AgentSessionStartInput): void {
  if (!input.sessionId) return
  const now = new Date().toISOString()
  try {
    prjctDb.run(
      input.projectId,
      `INSERT INTO agent_sessions
       (id, project_id, directory, task_id, goal, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         directory = COALESCE(excluded.directory, agent_sessions.directory),
         task_id = COALESCE(excluded.task_id, agent_sessions.task_id),
         goal = COALESCE(excluded.goal, agent_sessions.goal)`,
      input.sessionId,
      input.projectId,
      cleanText(input.directory),
      cleanText(input.taskId),
      cleanText(input.goal),
      now,
      now
    )
  } catch {
    /* measurement must never block hooks */
  }
}

export function recordAgentSessionEnd(input: AgentSessionEndInput): void {
  if (!input.sessionId) return
  const now = new Date().toISOString()
  const filesTouched =
    input.filesTouched && input.filesTouched.length > 0
      ? JSON.stringify(input.filesTouched.slice(0, 100))
      : null
  try {
    prjctDb.run(
      input.projectId,
      `INSERT INTO agent_sessions
       (id, project_id, directory, task_id, goal, started_at, ended_at, summary, files_touched, runtime, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         directory = COALESCE(excluded.directory, agent_sessions.directory),
         task_id = COALESCE(excluded.task_id, agent_sessions.task_id),
         goal = COALESCE(excluded.goal, agent_sessions.goal),
         ended_at = excluded.ended_at,
         summary = COALESCE(excluded.summary, agent_sessions.summary),
         files_touched = COALESCE(excluded.files_touched, agent_sessions.files_touched),
         runtime = excluded.runtime,
         model = excluded.model`,
      input.sessionId,
      input.projectId,
      cleanText(input.directory),
      cleanText(input.taskId),
      cleanText(input.goal),
      now,
      now,
      summary(input),
      filesTouched,
      cleanText(input.agent, 32) ?? 'unknown',
      cleanText(input.model, 120) ?? 'unknown',
      now
    )
  } catch {
    /* measurement must never block hooks */
  }
}
