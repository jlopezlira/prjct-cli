/**
 * QA plan — the per-cycle artifact: acceptance criteria + the flows that
 * verify them. Lives in SQLite as kv doc `qa:plan:<taskId>`. prjct owns
 * persistence and invariants (stable ids, Nyquist check, who verified what);
 * the model writes the content.
 */

import {
  type QaCriterion,
  type QaCriterionStatus,
  type QaFlow,
  type QaFlowStatus,
  type QaMode,
  type QaPlan,
  type QaPlanInputRaw,
  QaPlanInputSchema,
  QaPlanSchema,
  type QaReport,
  type QaVerifiedBy,
  qaId,
} from '../schemas/qa'
import prjctDb from '../storage/database'
import type { Spec } from '../types/spec'
import {
  assessAcceptanceCriteria,
  isVerifiableAcceptance,
  type NyquistLiteReport,
} from './nyquist-lite'

const PLAN_KEY = (taskId: string): string => `qa:plan:${taskId}`
const PLAN_UPSERT_EVENT = 'qa-plan-upsert'
const MARK_EVENT = 'qa-mark'
const REPORT_EVENT = 'qa-report'

/** Compact shape hint reused by the work directive and `prjct qa plan`. */
export const QA_PLAN_JSON_HINT =
  `{"criteria":["<observable outcome + how it is checked>"],` +
  `"flows":[{"name":"<user-visible path>","kind":"ui|api|cli|integration|manual",` +
  `"given":[],"when":[],"then":[],` +
  `"probe":{"type":"http","path":"/health","expect":{"status":200,"bodyIncludes":["ok"]}}}]}` +
  ` — probe types: http · cli {"command","expect":{"exitCode"}} · file {"path"} · browser {"steps":[{"do":"goto|fill|click|expectText|expectUrl|screenshot",…}]} · "remove":["fl-…"] drops entries`

export function getQaPlan(projectId: string, taskId: string): QaPlan | null {
  try {
    const raw = prjctDb.getDoc<unknown>(projectId, PLAN_KEY(taskId))
    if (!raw) return null
    const parsed = QaPlanSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function savePlan(projectId: string, plan: QaPlan): QaPlan {
  const next = { ...plan, updatedAt: new Date().toISOString() }
  prjctDb.setDoc(projectId, PLAN_KEY(plan.taskId), next)
  return next
}

function newPlan(taskId: string, opts: { workspaceId?: string; specId?: string }): QaPlan {
  const now = new Date().toISOString()
  return {
    version: 1,
    taskId,
    workspaceId: opts.workspaceId,
    specId: opts.specId,
    seededFromSpec: false,
    createdAt: now,
    updatedAt: now,
    criteria: [],
    flows: [],
  }
}

function criterionFrom(text: string, partial: Partial<QaCriterion> = {}): QaCriterion {
  return {
    id: qaId('ac', text),
    text: text.trim(),
    verifiable: isVerifiableAcceptance(text),
    status: 'pending',
    ...partial,
  }
}

function flowFrom(name: string, partial: Partial<QaFlow> = {}): QaFlow {
  return {
    id: qaId('fl', name),
    name: name.trim(),
    kind: 'ui',
    given: [],
    when: [],
    // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
    then: [],
    status: 'pending',
    ...partial,
  }
}

/**
 * A linked spec already holds acceptance criteria and GIVEN/WHEN/THEN
 * scenarios — materialize them so the cycle starts with a plan instead of a
 * blank directive. `test_plan` lines become `manual` flows.
 */
export function seedQaPlanFromSpec(spec: Spec, taskId: string, workspaceId?: string): QaPlan {
  const base = newPlan(taskId, { workspaceId, specId: spec.id })
  const criteria = spec.content.acceptance_criteria.map((text) => criterionFrom(text))
  const scenarioFlows = Object.entries(spec.content.scenarios ?? {}).flatMap(([slug, scenarios]) =>
    scenarios.map((scenario) =>
      flowFrom(`${slug}: ${scenario.name}`, {
        given: scenario.given,
        when: scenario.when,
        // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
        then: scenario.then,
      })
    )
  )
  const manualFlows = (spec.content.test_plan ?? [])
    .filter((line) => line.trim().length > 0)
    .map((line) => flowFrom(line, { kind: 'manual' }))
  return {
    ...base,
    seededFromSpec: true,
    criteria: dedupeById(criteria),
    flows: dedupeById([...scenarioFlows, ...manualFlows]),
  }
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

export function saveSeededPlan(projectId: string, plan: QaPlan): QaPlan {
  const saved = savePlan(projectId, plan)
  appendEvent(projectId, PLAN_UPSERT_EVENT, plan.taskId, {
    seeded: true,
    criteria: plan.criteria.length,
    flows: plan.flows.length,
  })
  return saved
}

export interface UpsertQaPlanResult {
  plan: QaPlan | null
  report: NyquistLiteReport
  /** Set when strict mode refused vague criteria — nothing was written. */
  rejected?: string
}

/**
 * Merge agent input into the cycle's plan by stable id. Existing statuses and
 * evidence survive a re-upsert unless the input sets them; entries the input
 * does not mention are kept — the plan only shrinks through explicit `remove`.
 */
export function upsertQaPlan(
  projectId: string,
  taskId: string,
  rawInput: QaPlanInputRaw,
  opts: { workspaceId?: string; specId?: string; mode: QaMode }
): UpsertQaPlanResult {
  // Parse here so probe defaults apply no matter which front-end called.
  const input = QaPlanInputSchema.parse(rawInput)
  const existing = getQaPlan(projectId, taskId) ?? newPlan(taskId, opts)
  const criteriaById = new Map(existing.criteria.map((c) => [c.id, c]))
  for (const entry of input.criteria ?? []) {
    const text = typeof entry === 'string' ? entry : entry.text
    const prev = criteriaById.get(qaId('ac', text))
    const next = criterionFrom(text, {
      ...(prev ?? {}),
      ...(typeof entry !== 'string' && entry.status ? { status: entry.status } : {}),
      ...(typeof entry !== 'string' && entry.evidence ? { evidence: entry.evidence } : {}),
    })
    criteriaById.set(next.id, next)
  }
  const flowsById = new Map(existing.flows.map((f) => [f.id, f]))
  for (const entry of input.flows ?? []) {
    const prev = flowsById.get(qaId('fl', entry.name))
    const next = flowFrom(entry.name, {
      ...(prev ?? {}),
      ...(entry.kind ? { kind: entry.kind } : {}),
      ...(entry.given ? { given: entry.given } : {}),
      ...(entry.when ? { when: entry.when } : {}),
      // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
      ...(entry.then ? { then: entry.then } : {}),
      ...(entry.probe ? { probe: entry.probe } : {}),
      ...(entry.testFile ? { testFile: entry.testFile } : {}),
    })
    // A changed probe invalidates a machine verdict: it verified something else.
    const probeChanged = prev?.probe && JSON.stringify(prev.probe) !== JSON.stringify(next.probe)
    flowsById.set(
      next.id,
      probeChanged && prev?.verifiedBy === 'machine'
        ? { ...next, status: 'pending', verifiedBy: undefined, evidence: undefined }
        : next
    )
  }

  for (const id of input.remove ?? []) {
    criteriaById.delete(id)
    flowsById.delete(id)
  }

  const merged: QaPlan = {
    ...existing,
    specId: existing.specId ?? opts.specId,
    criteria: [...criteriaById.values()],
    flows: [...flowsById.values()],
  }
  const report = assessAcceptanceCriteria(merged.criteria.map((c) => c.text))
  if (opts.mode === 'strict' && !report.ok) {
    return { plan: null, report, rejected: report.message ?? 'vague acceptance criteria' }
  }
  const saved = savePlan(projectId, merged)
  appendEvent(projectId, PLAN_UPSERT_EVENT, taskId, {
    criteria: saved.criteria.length,
    flows: saved.flows.length,
    vague: report.vague.length,
  })
  return { plan: saved, report }
}

export function markCriterion(
  projectId: string,
  taskId: string,
  id: string,
  mark: { status: QaCriterionStatus; evidence?: string; verifiedBy: QaVerifiedBy }
): QaPlan | null {
  const plan = getQaPlan(projectId, taskId)
  if (!plan || !plan.criteria.some((c) => c.id === id)) return null
  const now = new Date().toISOString()
  const saved = savePlan(projectId, {
    ...plan,
    criteria: plan.criteria.map((c) =>
      c.id === id
        ? {
            ...c,
            status: mark.status,
            evidence: mark.evidence,
            verifiedBy: mark.verifiedBy,
            updatedAt: now,
          }
        : c
    ),
  })
  appendEvent(projectId, MARK_EVENT, taskId, { id, ...mark })
  return saved
}

export function markFlow(
  projectId: string,
  taskId: string,
  id: string,
  mark: { status: QaFlowStatus; evidence?: string; verifiedBy: QaVerifiedBy; testFile?: string }
): QaPlan | null {
  const plan = getQaPlan(projectId, taskId)
  if (!plan || !plan.flows.some((f) => f.id === id)) return null
  const now = new Date().toISOString()
  const saved = savePlan(projectId, {
    ...plan,
    flows: plan.flows.map((f) =>
      f.id === id
        ? {
            ...f,
            status: mark.status,
            evidence: mark.evidence,
            verifiedBy: mark.verifiedBy,
            lastRunAt: now,
            ...(mark.testFile ? { testFile: mark.testFile } : {}),
          }
        : f
    ),
  })
  appendEvent(projectId, MARK_EVENT, taskId, { id, ...mark })
  return saved
}

export interface ApplyQaReportResult {
  plan: QaPlan | null
  applied: string[]
  unknown: string[]
}

/** Verdicts from the blind QA subagent — the only path that yields `agent`. */
export function applyQaReport(
  projectId: string,
  taskId: string,
  report: QaReport
): ApplyQaReportResult {
  const plan = getQaPlan(projectId, taskId)
  if (!plan) return { plan: null, applied: [], unknown: report.map((r) => r.id) }
  const now = new Date().toISOString()
  const applied: string[] = []
  const unknown: string[] = []
  const criteria = plan.criteria.map((c) => ({ ...c }))
  const flows = plan.flows.map((f) => ({ ...f }))
  for (const entry of report) {
    const criterion = criteria.find((c) => c.id === entry.id)
    const flow = flows.find((f) => f.id === entry.id)
    if (criterion && (entry.verdict === 'met' || entry.verdict === 'unmet')) {
      criterion.status = entry.verdict
      criterion.evidence = entry.evidence
      criterion.verifiedBy = 'agent'
      criterion.updatedAt = now
      applied.push(entry.id)
      continue
    }
    if (flow && entry.verdict !== 'met' && entry.verdict !== 'unmet') {
      flow.status = entry.verdict === 'blocked' ? 'skipped' : entry.verdict
      flow.evidence = entry.verdict === 'blocked' ? `BLOCKED: ${entry.evidence}` : entry.evidence
      flow.verifiedBy = 'agent'
      flow.lastRunAt = now
      if (entry.testFile) flow.testFile = entry.testFile
      applied.push(entry.id)
      continue
    }
    unknown.push(entry.id)
  }
  const saved = savePlan(projectId, { ...plan, criteria, flows })
  appendEvent(projectId, REPORT_EVENT, taskId, { applied, unknown })
  return { plan: saved, applied, unknown }
}

export interface QaPlanSummary {
  criteria: { total: number; met: number; unmet: number; pending: number; vague: number }
  flows: {
    total: number
    passed: number
    failed: number
    pending: number
    skipped: number
    withProbe: number
  }
}

export function qaPlanSummary(plan: QaPlan): QaPlanSummary {
  const count = <T extends string>(items: Array<{ status: T }>, status: T): number =>
    items.filter((i) => i.status === status).length
  return {
    criteria: {
      total: plan.criteria.length,
      met: count(plan.criteria, 'met'),
      unmet: count(plan.criteria, 'unmet'),
      pending: count(plan.criteria, 'pending'),
      vague: plan.criteria.filter((c) => !c.verifiable).length,
    },
    flows: {
      total: plan.flows.length,
      passed: count(plan.flows, 'passed'),
      failed: count(plan.flows, 'failed'),
      pending: count(plan.flows, 'pending'),
      skipped: count(plan.flows, 'skipped'),
      withProbe: plan.flows.filter((f) => f.probe).length,
    },
  }
}

const verifiedMark = (by: QaVerifiedBy | undefined): string =>
  by === 'machine' ? '✓ machine' : by === 'agent' ? '✓ agent' : by === 'author' ? '~ author' : ''

export function renderQaChecklistMd(plan: QaPlan): string[] {
  const lines: string[] = []
  if (plan.criteria.length > 0) {
    lines.push('**Acceptance criteria**')
    for (const c of plan.criteria) {
      const box = c.status === 'met' ? 'x' : ' '
      const tag =
        c.status === 'unmet'
          ? ' ✗ unmet'
          : c.status === 'met'
            ? ` ${verifiedMark(c.verifiedBy)}`
            : ''
      const vague = c.verifiable ? '' : ' _(vague — name a signal)_'
      lines.push(`- [${box}] \`${c.id}\` ${c.text}${tag}${vague}`)
    }
  }
  if (plan.flows.length > 0) {
    lines.push('**Flows**')
    for (const f of plan.flows) {
      const box = f.status === 'passed' ? 'x' : ' '
      const state =
        f.status === 'passed'
          ? ` ${verifiedMark(f.verifiedBy)}`
          : f.status === 'failed'
            ? ' ✗ failed'
            : f.status === 'skipped'
              ? ' ⊘ skipped'
              : ''
      const probe = f.probe ? ` · probe:${f.probe.type}` : ''
      lines.push(`- [${box}] \`${f.id}\` ${f.name} (${f.kind}${probe})${state}`)
    }
  }
  return lines
}

function appendEvent(
  projectId: string,
  type: string,
  taskId: string,
  data: Record<string, unknown>
): void {
  try {
    prjctDb.appendEvent(projectId, type, data, taskId)
  } catch {
    /* events are best-effort telemetry */
  }
}
