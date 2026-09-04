/**
 * QA runner — executes the plan's probes (and any OPTIONAL extra command the
 * project already owns), records a receipt bound to git HEAD, and marks the
 * flows `machine`-verified. Mirrors the gauntlet: receipt in SQLite, fresh for
 * 30 min on the same HEAD, `unavailable` never a defect, vacuous said loudly.
 */

import path from 'node:path'
import configManager from '../infrastructure/config-manager'
import {
  QA_EXTRA_COMMAND_KINDS,
  type QaCheck,
  type QaExtraCommandKind,
  type QaMode,
  type QaPlan,
  type QaProbeResult,
  type QaReceipt,
  QaReceiptSchema,
} from '../schemas/qa'
import type { HarnessLevel } from '../schemas/state'
import prjctDb from '../storage/database'
import type { LocalConfig } from '../types/config'
import { fileExists, readJson } from '../utils/file-helper'
import { gitBinding, isReceiptFresh, runVerifyCommand } from './gauntlet'
import { detectVerifiedCommands } from './project-command-facts'
import { withApp } from './qa-app'
import { effectiveQaMode, type QaShipGateVerdict, qaAppliesTo, qaShipVerdict } from './qa-gate'
import { getQaPlan, markFlow } from './qa-plan'
import { runProbe } from './qa-probes'
import {
  unchangedDuringVerification,
  type VerificationBinding,
  verificationBinding,
} from './verification-binding'

const QA_LATEST_KEY = 'qa:latest'
const receiptKey = (taskId: string): string => `qa:receipt:${taskId}`
const QA_RUN_EVENT = 'qa-run'
const QA_OVERRIDE_EVENT = 'qa-override'
/** Extra e2e suites can be slow; probes have their own budgets. */
const QA_EXTRA_TIMEOUT_MS = 1_200_000

export type QaSetKey =
  | 'app.start'
  | 'app.baseUrl'
  | 'app.readyPath'
  | 'app.readyTimeoutMs'
  | QaExtraCommandKind

export const QA_SET_KEYS: readonly QaSetKey[] = [
  'app.start',
  'app.baseUrl',
  'app.readyPath',
  'app.readyTimeoutMs',
  ...QA_EXTRA_COMMAND_KINDS,
]

export function qaExtraCommands(
  config: LocalConfig | null
): Array<{ kind: string; command: string }> {
  return (config?.qa?.commands ?? [])
    .filter((entry) => typeof entry?.command === 'string' && entry.command.trim().length > 0)
    .map(({ kind, command }) => ({ kind, command: command.trim() }))
}

export interface QaCandidate {
  kind: QaExtraCommandKind
  command: string
  source: string
}

/**
 * Suggestions only — surfaced in `prjct qa` status so the agent can register
 * what it confirms. Nothing here is executed on its own.
 */
export async function detectQaCandidates(projectPath: string): Promise<QaCandidate[]> {
  const out: QaCandidate[] = []
  const pkg = await readJson<{ scripts?: Record<string, string> } | null>(
    path.join(projectPath, 'package.json'),
    null
  )
  const scripts = pkg?.scripts ?? {}
  const pm = (await detectVerifiedCommands(projectPath)).packageManager ?? 'npm'
  const run = (script: string): string =>
    pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`
  const scriptKinds: Array<[string, QaExtraCommandKind]> = [
    ['test:e2e', 'e2e'],
    ['e2e', 'e2e'],
    ['test:integration', 'integration'],
    ['integration', 'integration'],
    ['smoke', 'smoke'],
  ]
  for (const [script, kind] of scriptKinds) {
    if (scripts[script])
      out.push({ kind, command: run(script), source: `package.json scripts.${script}` })
  }
  for (const ext of ['ts', 'js', 'mjs', 'cjs']) {
    if (await fileExists(path.join(projectPath, `playwright.config.${ext}`))) {
      out.push({ kind: 'e2e', command: 'npx playwright test', source: `playwright.config.${ext}` })
      break
    }
  }
  for (const ext of ['ts', 'js', 'mjs', 'cjs']) {
    if (await fileExists(path.join(projectPath, `cypress.config.${ext}`))) {
      out.push({ kind: 'e2e', command: 'npx cypress run', source: `cypress.config.${ext}` })
      break
    }
  }
  return out
}

export async function setQaValue(
  projectPath: string,
  key: string,
  value: string
): Promise<{ ok: boolean; error?: string }> {
  const normalizedKey = key.trim()
  if (!(QA_SET_KEYS as readonly string[]).includes(normalizedKey)) {
    return { ok: false, error: `key must be one of: ${QA_SET_KEYS.join(', ')}` }
  }
  const normalizedValue = value.trim()
  if (!normalizedValue) return { ok: false, error: 'value is empty' }
  try {
    const config = await configManager.readConfig(projectPath)
    if (!config) return { ok: false, error: 'No prjct project here — run `prjct init` first.' }
    const qa = { ...(config.qa ?? {}) }
    if (normalizedKey.startsWith('app.')) {
      const field = normalizedKey.slice('app.'.length) as
        | 'start'
        | 'baseUrl'
        | 'readyPath'
        | 'readyTimeoutMs'
      if (field === 'readyTimeoutMs') {
        const ms = Number.parseInt(normalizedValue, 10)
        if (!Number.isFinite(ms) || ms <= 0)
          return { ok: false, error: 'readyTimeoutMs must be a positive integer' }
        qa.app = { ...(qa.app ?? {}), readyTimeoutMs: ms }
      } else {
        qa.app = { ...(qa.app ?? {}), [field]: normalizedValue }
      }
    } else {
      const kind = normalizedKey as QaExtraCommandKind
      qa.commands = [
        ...(qa.commands ?? []).filter((c) => c.kind !== kind),
        { kind, command: normalizedValue },
      ]
    }
    await configManager.writeConfig(projectPath, { ...config, qa })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function readQaReceipt(
  projectId: string,
  taskId?: string | null
): { data: QaReceipt; updatedAt: string } | null {
  try {
    const stamped =
      (taskId ? prjctDb.getDocWithStamp<unknown>(projectId, receiptKey(taskId)) : null) ??
      prjctDb.getDocWithStamp<unknown>(projectId, QA_LATEST_KEY)
    if (!stamped) return null
    const parsed = QaReceiptSchema.safeParse(stamped.data)
    return parsed.success ? { data: parsed.data, updatedAt: stamped.updatedAt } : null
  } catch {
    return null
  }
}

export function recordQaOverride(projectId: string, taskId?: string | null): void {
  try {
    prjctDb.appendEvent(
      projectId,
      QA_OVERRIDE_EVENT,
      { at: new Date().toISOString() },
      taskId ?? undefined
    )
  } catch {
    /* best-effort */
  }
}

export interface RunQaOptions {
  plan: QaPlan | null
  flowId?: string
  /** Start `qa.app.start` for http/browser probes (default true). */
  serve?: boolean
}

export async function runQa(
  projectPath: string,
  projectId: string,
  opts: RunQaOptions
): Promise<QaReceipt> {
  const config = await configManager.readConfig(projectPath).catch(() => null)
  const app = config?.qa?.app
  const extras = qaExtraCommands(config)
  const flows = (opts.plan?.flows ?? []).filter(
    (f) => f.probe && (!opts.flowId || f.id === opts.flowId)
  )
  const needsApp = flows.some((f) => f.probe?.type === 'http' || f.probe?.type === 'browser')
  const binding = await gitBinding(projectPath)
  const before = await currentQaVerification(projectPath, opts.plan, opts)

  const execute = async (baseUrl: string | null) => {
    const checks: QaCheck[] = []
    for (const { kind, command } of extras) {
      checks.push(
        await runVerifyCommand(projectPath, kind, command, { timeoutMs: QA_EXTRA_TIMEOUT_MS })
      )
    }
    const probes: QaProbeResult[] = []
    for (const flow of flows) {
      if (!flow.probe) continue
      const result = await runProbe(flow.probe, { projectPath, baseUrl, projectId })
      probes.push({ ...result, flowId: flow.id })
      if (opts.plan) {
        markFlow(projectId, opts.plan.taskId, flow.id, {
          status: result.ok ? 'passed' : result.unavailable ? 'skipped' : 'failed',
          evidence: result.ok ? `probe ${result.type} ok (${result.durationMs}ms)` : result.detail,
          verifiedBy: 'machine',
        })
      }
    }
    return { checks, probes }
  }

  const serve = opts.serve !== false && needsApp && Boolean(app?.start)
  const ran = serve
    ? await withApp(projectPath, app, async (ready) =>
        ready.error
          ? { checks: [], probes: [], appError: ready.error }
          : execute(ready.baseUrl ?? null)
      )
    : {
        result: await execute(app?.baseUrl ?? null),
        app: { started: false, baseUrl: app?.baseUrl },
      }
  const { checks, probes } = ran.result
  const appError = 'appError' in ran.result ? ran.result.appError : undefined
  const all = [...checks, ...probes]
  const currentPlan = opts.plan ? (getQaPlan(projectId, opts.plan.taskId) ?? opts.plan) : null
  const after = await currentQaVerification(projectPath, currentPlan, opts)
  const stable = unchangedDuringVerification(before, after)
  const receipt: QaReceipt = {
    verification: stable ? before : null,
    version: 1,
    taskId: opts.plan?.taskId ?? null,
    ranAt: new Date().toISOString(),
    headSha: binding.headSha,
    dirty: binding.dirty,
    passed: (stable || all.length === 0) && !appError && all.every((r) => r.ok || r.unavailable),
    vacuous: all.length === 0 || all.every((r) => r.unavailable),
    app: { ...ran.app, ...(appError ? { error: appError } : {}) },
    checks,
    probes,
  }
  try {
    prjctDb.setDoc(projectId, QA_LATEST_KEY, receipt)
    if (receipt.taskId) prjctDb.setDoc(projectId, receiptKey(receipt.taskId), receipt)
    prjctDb.appendEvent(
      projectId,
      QA_RUN_EVENT,
      {
        passed: receipt.passed,
        vacuous: receipt.vacuous,
        headSha: receipt.headSha,
        probes: probes.map((p) => `${p.flowId ?? p.type}:${p.outcome}`),
        checks: checks.map((c) => `${c.kind}:${c.outcome}`),
      },
      receipt.taskId ?? undefined
    )
  } catch {
    /* receipt storage is best-effort — the printed result is still true */
  }
  return receipt
}

/**
 * Ship-time self-provisioning (gauntlet parity): when the plan has probes and
 * the receipt is missing/stale, run them inline and gate on the REAL result.
 */
export async function ensureShipQa(
  projectPath: string,
  projectId: string,
  opts: {
    taskId: string | null
    harnessLevel?: HarnessLevel
    headSha: string | null
    mode: QaMode
    override: boolean
  }
): Promise<QaShipGateVerdict> {
  // No cycle ⇒ nothing to plan against; the gate cannot apply.
  if (!opts.taskId) return { blocked: false, message: null, checklist: [] }
  const plan = getQaPlan(projectId, opts.taskId)
  const existing = readQaReceipt(projectId, opts.taskId)?.data ?? null
  const base = {
    mode: opts.mode,
    harnessLevel: opts.harnessLevel,
    plan,
    headSha: opts.headSha,
    verification: await currentQaVerification(projectPath, plan),
  }
  const hasProbes = Boolean(plan?.flows.some((f) => f.probe))
  const fresh =
    existing !== null &&
    existing.taskId === (plan?.taskId ?? null) &&
    isReceiptFresh(existing, Date.now(), opts.headSha, base.verification)
  if (opts.override || !qaAppliesTo(opts.harnessLevel, opts.mode) || !hasProbes || fresh) {
    return qaShipVerdict({ ...base, receipt: existing, nowMs: Date.now(), override: opts.override })
  }
  console.log('QA receipt missing or stale — running probes now…')
  const receipt = await runQa(projectPath, projectId, { plan })
  if (!receipt.verification)
    return {
      blocked: true,
      message:
        'QA content or plan changed during execution, or could not be read. Re-run prjct qa run on a stable checkout.',
      checklist: [],
    }
  return qaShipVerdict({
    ...base,
    verification: await currentQaVerification(projectPath, getQaPlan(projectId, opts.taskId)),
    plan: opts.taskId ? getQaPlan(projectId, opts.taskId) : null,
    receipt,
    nowMs: Date.now(),
    override: false,
  })
}

/** SessionStart cue: the phase is on but prjct cannot reach the app yet. */
export async function qaBootstrapCue(
  projectPath: string,
  config: LocalConfig | null
): Promise<string | null> {
  try {
    if (effectiveQaMode(config) === 'off') return null
    if (config?.qa?.app?.baseUrl) return null
    const facts = await detectVerifiedCommands(projectPath)
    const looksLikeApp = facts.commands.some((c) => c.kind === 'dev')
    if (!looksLikeApp) return null
    return '# prjct: QA cannot reach this app yet\nAGENT: register how it runs — `prjct qa set app.start "<cmd>"` + `prjct qa set app.baseUrl <url>` — so QA probes verify real flows.'
  } catch {
    return null
  }
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

export function renderQaReceiptMd(receipt: QaReceipt): string {
  const state = receipt.vacuous ? 'VACUOUS' : receipt.passed ? 'PASS' : 'RED'
  const head = receipt.headSha
    ? `${receipt.headSha.slice(0, 8)}${receipt.dirty ? ' (dirty)' : ' (clean)'}`
    : 'no git'
  const mark = (ok: boolean, unavailable: boolean | undefined, outcome: string): string =>
    ok ? '✓' : unavailable ? `⊘ ${outcome}` : `✗ ${outcome}`
  const rows = [
    ...receipt.checks.map(
      (c) =>
        `| ${c.kind} | \`${c.command}\` | ${mark(c.ok, c.unavailable, c.outcome)} | ${secs(c.durationMs)} |`
    ),
    ...receipt.probes.map(
      (p) =>
        `| ${p.flowId ?? '—'} | ${p.type} | ${mark(p.ok, p.unavailable, p.outcome)} | ${secs(p.durationMs)} |`
    ),
  ]
  const failures = [...receipt.checks, ...receipt.probes]
    .filter((r) => !r.ok && r.detail)
    .map(
      (r) =>
        `**${'flowId' in r && r.flowId ? r.flowId : 'kind' in r ? r.kind : r.type}**\n\`\`\`\n${r.detail}\n\`\`\``
    )
  const appLine = receipt.app.started
    ? `- App started from \`qa.app.start\`${receipt.app.readyMs !== undefined ? ` · ready in ${secs(receipt.app.readyMs)}` : ''}${receipt.app.error ? ` · ✗ ${receipt.app.error}` : ''}`
    : receipt.app.baseUrl
      ? `- App assumed running at ${receipt.app.baseUrl}`
      : '- No app configured (`prjct qa set app.start` / `app.baseUrl`) — http/browser probes cannot run'
  return [
    `## QA — ${state}`,
    '',
    `- HEAD ${head} · ran ${receipt.ranAt}`,
    appLine,
    '',
    ...(rows.length > 0
      ? ['| flow / check | probe | result | time |', '|---|---|---|---|', ...rows, '']
      : []),
    ...(failures.length > 0 ? [...failures, ''] : []),
    receipt.vacuous
      ? '_Nothing was verified by machine — attach probes to flows, or let the QA subagent verify them (`prjct qa next`)._'
      : receipt.passed
        ? '_Machine-verified. The receipt gates `prjct ship` for this HEAD (30min)._'
        : '_RED — the work does not count yet. Fix and re-run `prjct qa run`._',
    '',
  ].join('\n')
}

export function renderQaReceiptText(receipt: QaReceipt): string {
  const state = receipt.vacuous ? 'VACUOUS' : receipt.passed ? 'PASS' : 'RED'
  const head = receipt.headSha ? receipt.headSha.slice(0, 8) : 'no-git'
  const lines = [`QA ${state} · HEAD ${head}${receipt.dirty ? ' (dirty)' : ''}`]
  if (receipt.app.error) lines.push(`  ✗ app: ${receipt.app.error}`)
  for (const c of receipt.checks) {
    lines.push(
      `  ${c.ok ? '✓' : c.unavailable ? '⊘' : '✗'} ${c.kind.padEnd(12)} ${c.ok ? '' : c.outcome} ${secs(c.durationMs)}`
    )
  }
  for (const p of receipt.probes) {
    lines.push(
      `  ${p.ok ? '✓' : p.unavailable ? '⊘' : '✗'} ${(p.flowId ?? p.type).padEnd(12)} ${p.type} ${p.ok ? '' : p.outcome} ${secs(p.durationMs)}`
    )
    if (!p.ok && p.detail) lines.push(`      ${p.detail.split('\n').slice(0, 2).join('\n      ')}`)
  }
  if (receipt.vacuous)
    lines.push('  (nothing verified by machine — add probes or dispatch the QA subagent)')
  return lines.join('\n')
}

/** Bind execution inputs only: result status/evidence updates do not alter the plan. */
export async function currentQaVerification(
  projectPath: string,
  plan: QaPlan | null,
  opts: { flowId?: string; serve?: boolean } = {}
): Promise<VerificationBinding | null> {
  try {
    const config = await configManager.readConfig(projectPath)
    return verificationBinding(projectPath, {
      taskId: plan?.taskId ?? null,
      criteria: plan?.criteria.map(({ id, text, verifiable }) => ({ id, text, verifiable })),
      flows: plan?.flows.map(({ id, name, kind, given, when, then, probe, testFile }) => ({
        id,
        name,
        kind,
        given,
        when,
        then,
        probe,
        testFile,
      })),
      extras: qaExtraCommands(config),
      app: config?.qa?.app,
      flowId: opts.flowId,
      serve: opts.serve !== false,
    })
  } catch {
    return null
  }
}
