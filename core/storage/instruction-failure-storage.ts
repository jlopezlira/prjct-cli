import { createHash } from 'node:crypto'
import {
  type InstructionFailure,
  type InstructionFailureDisposition,
  type InstructionFailureInput,
  InstructionFailureInputSchema,
  InstructionFailureSchema,
} from '../schemas/instruction-failure'
import { prjctDb } from './database'

export const INSTRUCTION_GUIDANCE_ACTIVATED_EVENT = 'instruction.guidance.activated'
export const INSTRUCTION_FAILURE_RETENTION_DAYS = 90

interface InstructionFailureRow {
  id: string
  project_id: string
  dedup_key: string
  source: string
  runtime: string
  model: string
  session_id: string | null
  task_id: string | null
  category: string
  expected_behavior: string
  observed_behavior: string
  related_rule_id: string | null
  disposition: InstructionFailureDisposition
  occurred_at: string
  created_at: string
}

export interface InstructionFailureGroup {
  runtime: string
  model: string
  category: string
  total: number
  open: number
  resolved: number
  falsePositive: number
}

export interface InstructionFailureOpenCase {
  id: string
  runtime: string
  model: string
  category: string
  observedBehavior: string
  relatedRuleId: string | null
  occurredAt: string
}

export interface InstructionFailureWindowStats {
  total: number
  attributed: number
  open: number
  resolved: number
  falsePositive: number
  observedSessions: number
  attributedSessions: number
  legacyUnattributedInputs: number
  guidanceActivations: number
  groups: InstructionFailureGroup[]
  unresolved: InstructionFailureOpenCase[]
}

const normalizedBehavior = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')

const dedupKeyFor = (input: InstructionFailureInput): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        input.source,
        input.sessionId ?? '',
        input.category,
        normalizedBehavior(input.expectedBehavior),
        normalizedBehavior(input.observedBehavior),
        input.relatedRuleId ?? '',
      ])
    )
    .digest('hex')

const rowToFailure = (row: InstructionFailureRow): InstructionFailure =>
  InstructionFailureSchema.parse({
    id: row.id,
    projectId: row.project_id,
    dedupKey: row.dedup_key,
    source: row.source,
    runtime: row.runtime,
    model: row.model,
    sessionId: row.session_id,
    taskId: row.task_id,
    category: row.category,
    expectedBehavior: row.expected_behavior,
    observedBehavior: row.observed_behavior,
    relatedRuleId: row.related_rule_id,
    disposition: row.disposition,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  })

class InstructionFailureStorage {
  record(
    projectId: string,
    rawInput: InstructionFailureInput
  ): { inserted: boolean; failure: InstructionFailure } {
    const input = InstructionFailureInputSchema.parse(rawInput)
    const dedupKey = dedupKeyFor(input)
    const id = `if_${dedupKey.slice(0, 24)}`
    const createdAt = new Date().toISOString()
    const occurredAt = input.occurredAt ?? createdAt
    // Fresh-insert fast path: one round trip. `RETURNING *` on `INSERT OR
    // IGNORE` returns the new row when the insert actually happened, and
    // zero rows when it was ignored as a duplicate — a reliable insert/
    // ignore signal straight from SQLite, unlike comparing timestamps
    // (two calls can land in the same millisecond and collide).
    const insertedRows = prjctDb.query<InstructionFailureRow>(
      projectId,
      `INSERT OR IGNORE INTO instruction_failures
       (id, project_id, dedup_key, source, runtime, model, session_id, task_id, category,
        expected_behavior, observed_behavior, related_rule_id, disposition, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
       RETURNING *`,
      id,
      projectId,
      dedupKey,
      input.source,
      input.runtime,
      input.model,
      input.sessionId ?? null,
      input.taskId ?? null,
      input.category,
      input.expectedBehavior,
      input.observedBehavior,
      input.relatedRuleId ?? null,
      occurredAt,
      createdAt
    )
    if (insertedRows[0]) {
      return { inserted: true, failure: rowToFailure(insertedRows[0]) }
    }

    // Duplicate: dedupKey intentionally excludes runtime/model (attribution
    // can resolve late or inconsistently across occurrences of the SAME
    // underlying failure) — backfill 'unknown' with a real value here
    // instead of leaving the row permanently locked to whatever the first
    // occurrence happened to record.
    let row = prjctDb.get<InstructionFailureRow>(
      projectId,
      'SELECT * FROM instruction_failures WHERE dedup_key = ?',
      dedupKey
    )
    if (!row) throw new Error('Instruction failure insert did not produce a readable row')
    const runtimeUpgrade = row.runtime === 'unknown' && input.runtime !== 'unknown'
    const modelUpgrade = row.model === 'unknown' && input.model !== 'unknown'
    if (runtimeUpgrade || modelUpgrade) {
      const [updated] = prjctDb.query<InstructionFailureRow>(
        projectId,
        'UPDATE instruction_failures SET runtime = ?, model = ? WHERE id = ? RETURNING *',
        runtimeUpgrade ? input.runtime : row.runtime,
        modelUpgrade ? input.model : row.model,
        row.id
      )
      row = updated ?? row
    }
    return { inserted: false, failure: rowToFailure(row) }
  }

  getById(projectId: string, id: string): InstructionFailure | null {
    const row = prjctDb.get<InstructionFailureRow>(
      projectId,
      'SELECT * FROM instruction_failures WHERE id = ?',
      id
    )
    return row ? rowToFailure(row) : null
  }

  setDisposition(
    projectId: string,
    id: string,
    disposition: InstructionFailureDisposition
  ): boolean {
    return (
      prjctDb.run(
        projectId,
        'UPDATE instruction_failures SET disposition = ? WHERE id = ?',
        disposition,
        id
      ).changes === 1
    )
  }

  recordGuidanceActivation(
    projectId: string,
    input: { sessionId?: string | null; taskId?: string | null; ruleId?: string | null }
  ): number | null {
    return prjctDb.appendEvent(
      projectId,
      INSTRUCTION_GUIDANCE_ACTIVATED_EVENT,
      { sessionId: input.sessionId ?? null, ruleId: input.ruleId ?? null },
      input.taskId ?? undefined
    )
  }

  getWindowStats(projectId: string, since: Date): InstructionFailureWindowStats {
    const sinceIso = since.toISOString()
    const sinceMs = since.getTime()
    const totals = prjctDb.get<{
      total: number
      attributed: number
      open_count: number
      resolved_count: number
      false_positive_count: number
    }>(
      projectId,
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN runtime <> 'unknown' AND model <> 'unknown' THEN 1 ELSE 0 END), 0) AS attributed,
              COALESCE(SUM(CASE WHEN disposition = 'open' THEN 1 ELSE 0 END), 0) AS open_count,
              COALESCE(SUM(CASE WHEN disposition = 'resolved' THEN 1 ELSE 0 END), 0) AS resolved_count,
              COALESCE(SUM(CASE WHEN disposition = 'false_positive' THEN 1 ELSE 0 END), 0) AS false_positive_count
       FROM instruction_failures
       WHERE project_id = ? AND occurred_at >= ?`,
      projectId,
      sinceIso
    )
    const groups = prjctDb
      .query<{
        runtime: string
        model: string
        category: string
        total: number
        open_count: number
        resolved_count: number
        false_positive_count: number
      }>(
        projectId,
        `SELECT runtime, model, category, COUNT(*) AS total,
                SUM(CASE WHEN disposition = 'open' THEN 1 ELSE 0 END) AS open_count,
                SUM(CASE WHEN disposition = 'resolved' THEN 1 ELSE 0 END) AS resolved_count,
                SUM(CASE WHEN disposition = 'false_positive' THEN 1 ELSE 0 END) AS false_positive_count
         FROM instruction_failures
         WHERE project_id = ? AND occurred_at >= ?
         GROUP BY runtime, model, category
         ORDER BY total DESC, runtime ASC, model ASC, category ASC`,
        projectId,
        sinceIso
      )
      .map((row) => ({
        runtime: row.runtime,
        model: row.model,
        category: row.category,
        total: row.total,
        open: row.open_count,
        resolved: row.resolved_count,
        falsePositive: row.false_positive_count,
      }))
    const unresolved = prjctDb
      .query<InstructionFailureRow>(
        projectId,
        `SELECT * FROM instruction_failures
         WHERE project_id = ? AND disposition = 'open' AND occurred_at >= ?
         ORDER BY occurred_at DESC, id ASC LIMIT 20`,
        projectId,
        sinceIso
      )
      .map((row) => ({
        id: row.id,
        runtime: row.runtime,
        model: row.model,
        category: row.category,
        observedBehavior: row.observed_behavior,
        relatedRuleId: row.related_rule_id,
        occurredAt: row.occurred_at,
      }))
    const sessionCoverage = prjctDb.get<{ total: number; attributed: number }>(
      projectId,
      `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN runtime <> 'unknown' AND model <> 'unknown' THEN 1 ELSE 0 END), 0) AS attributed
         FROM agent_sessions WHERE project_id = ? AND started_at >= ?`,
      projectId,
      sinceIso
    ) ?? { total: 0, attributed: 0 }
    const legacyUnattributedInputs =
      prjctDb.get<{ value: number }>(
        projectId,
        `SELECT COUNT(DISTINCT me.id) AS value
         FROM memory_entries me
         INNER JOIN memory_entry_tags met ON met.entry_id = me.id
         WHERE me.project_id = ? AND me.type = 'improvement-signal'
           AND me.deleted_at IS NULL AND me.created_at >= ?
           AND met.key = 'source'
           AND met.value IN ('friction-detector', 'skill-miss-detector')
           AND (NOT EXISTS (
             SELECT 1 FROM memory_entry_tags attribution
             WHERE attribution.entry_id = me.id
               AND attribution.key = 'runtime'
           ) OR NOT EXISTS (
             SELECT 1 FROM memory_entry_tags attribution
             WHERE attribution.entry_id = me.id
               AND attribution.key = 'model'
           ))`,
        projectId,
        sinceMs
      )?.value ?? 0
    const guidanceActivations =
      prjctDb.get<{ value: number }>(
        projectId,
        'SELECT COUNT(*) AS value FROM events WHERE type = ? AND timestamp >= ?',
        INSTRUCTION_GUIDANCE_ACTIVATED_EVENT,
        sinceIso
      )?.value ?? 0

    return {
      total: totals?.total ?? 0,
      attributed: totals?.attributed ?? 0,
      open: totals?.open_count ?? 0,
      resolved: totals?.resolved_count ?? 0,
      falsePositive: totals?.false_positive_count ?? 0,
      observedSessions: sessionCoverage.total,
      attributedSessions: sessionCoverage.attributed,
      legacyUnattributedInputs,
      guidanceActivations,
      groups,
      unresolved,
    }
  }

  pruneRetained(projectId: string, now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - INSTRUCTION_FAILURE_RETENTION_DAYS * 86_400_000)
    return prjctDb.run(
      projectId,
      `DELETE FROM instruction_failures
       WHERE project_id = ? AND disposition IN ('resolved', 'false_positive') AND occurred_at < ?`,
      projectId,
      cutoff.toISOString()
    ).changes
  }
}

export const instructionFailureStorage = new InstructionFailureStorage()
export { InstructionFailureStorage }
