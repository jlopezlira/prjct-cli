/**
 * The gauntlet — Uncle Bob's agentic discipline as a prjct mechanism.
 *
 * "Move enforcement into tools": the work counts when the MACHINE says so,
 * not when the agent narrates success. `prjct gauntlet` runs the project's
 * own registered verify commands (typecheck · lint · test — the same set
 * PRJCT.md advertises), records a receipt bound to git HEAD in SQLite, and
 * `ship` demands that receipt fresh and green. A red receipt always blocks
 * (override is explicit and recorded); a missing/stale receipt blocks under
 * code-strict and warns otherwise. No commands registered → vacuous pass,
 * said loudly — never a fake green.
 */

import prjctDb from '../storage/database'
import { gitStdout, listChangedFiles, matchProc, runProc } from '../utils/exec'
import { detectVerifiedCommands } from './project-command-facts'

const GAUNTLET_DOC_KEY = 'gauntlet:latest'
const GAUNTLET_EVENT = 'gauntlet-run'
const GAUNTLET_OVERRIDE_EVENT = 'gauntlet-override'
/** A green receipt is trusted for this long on the same HEAD. */
export const GAUNTLET_FRESH_MS = 30 * 60 * 1000
const OUTPUT_TAIL_CHARS = 400
const MAX_BUFFER = 32 * 1024 * 1024
const CHECK_TIMEOUT_MS: Record<string, number> = { typecheck: 240_000, lint: 240_000 }
const TEST_TIMEOUT_MS = 900_000

/** The verify kinds the gauntlet runs — read-only, in this order. */
const GAUNTLET_KINDS = ['typecheck', 'lint', 'test'] as const

export interface GauntletCheck {
  kind: string
  command: string
  ok: boolean
  /** 'ok' | 'exit:<code>' | 'timeout' | 'spawn' | 'overflow' */
  outcome: string
  durationMs: number
  /** Output tail on failure — enough to see why, never the full log. */
  detail?: string
}

export interface GauntletReceipt {
  version: 1
  ranAt: string
  headSha: string | null
  dirty: boolean | null
  passed: boolean
  /** True when the project has no registered verify commands — a pass that proves nothing. */
  vacuous: boolean
  checks: GauntletCheck[]
}

async function gauntletCommands(
  projectPath: string
): Promise<Array<{ kind: string; command: string }>> {
  const facts = await detectVerifiedCommands(projectPath)
  const byKind = new Map<string, string>()
  for (const cmd of facts.commands) {
    if (cmd.mutating) continue
    if (!GAUNTLET_KINDS.includes(cmd.kind as (typeof GAUNTLET_KINDS)[number])) continue
    if (!byKind.has(cmd.kind)) byKind.set(cmd.kind, cmd.command)
  }
  return GAUNTLET_KINDS.flatMap((kind) => {
    const command = byKind.get(kind)
    return command ? [{ kind, command }] : []
  })
}

export async function projectHasGauntletCommands(projectPath: string): Promise<boolean> {
  try {
    return (await gauntletCommands(projectPath)).length > 0
  } catch {
    return false
  }
}

async function gitBinding(
  projectPath: string
): Promise<{ headSha: string | null; dirty: boolean | null }> {
  try {
    const out = await gitStdout(projectPath, ['rev-parse', 'HEAD'])
    const headSha = out?.trim() || null
    if (!headSha) return { headSha: null, dirty: null }
    const dirty = (await listChangedFiles(projectPath)).length > 0
    return { headSha, dirty }
  } catch {
    return { headSha: null, dirty: null } // non-git projects still gauntlet
  }
}

async function runCheck(
  projectPath: string,
  kind: string,
  command: string
): Promise<GauntletCheck> {
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
  const localBin = `${projectPath}/node_modules/.bin`
  const result = await runProc(shell, shellArgs, {
    cwd: projectPath,
    env: { ...process.env, PATH: `${localBin}:${process.env.PATH ?? ''}` },
    timeoutMs: kind === 'test' ? TEST_TIMEOUT_MS : (CHECK_TIMEOUT_MS[kind] ?? 240_000),
    maxBuffer: MAX_BUFFER,
  })
  return matchProc<GauntletCheck>(result, {
    ok: (r) => ({ kind, command, ok: true, outcome: 'ok', durationMs: r.durationMs }),
    exit: (r) => ({
      kind,
      command,
      ok: false,
      outcome: `exit:${r.code ?? 'signal'}`,
      durationMs: r.durationMs,
      detail: `${r.stdout}\n${r.stderr}`.trim().slice(-OUTPUT_TAIL_CHARS),
    }),
    timeout: (r) => ({
      kind,
      command,
      ok: false,
      outcome: 'timeout',
      durationMs: r.durationMs,
      detail: `timed out after ${r.budgetMs}ms`,
    }),
    spawn: (r) => ({
      kind,
      command,
      ok: false,
      outcome: 'spawn',
      durationMs: r.durationMs,
      detail: r.cause.message,
    }),
    overflow: (r) => ({
      kind,
      command,
      ok: false,
      outcome: 'overflow',
      durationMs: r.durationMs,
      detail: `output exceeded ${r.maxBuffer} bytes`,
    }),
  })
}

export async function runGauntlet(
  projectPath: string,
  projectId: string
): Promise<GauntletReceipt> {
  const commands = await gauntletCommands(projectPath)
  const binding = await gitBinding(projectPath)

  const checks: GauntletCheck[] = []
  for (const { kind, command } of commands) {
    checks.push(await runCheck(projectPath, kind, command))
  }

  const receipt: GauntletReceipt = {
    version: 1,
    ranAt: new Date().toISOString(),
    headSha: binding.headSha,
    dirty: binding.dirty,
    passed: checks.every((c) => c.ok),
    vacuous: commands.length === 0,
    checks,
  }

  try {
    prjctDb.setDoc(projectId, GAUNTLET_DOC_KEY, receipt)
    prjctDb.appendEvent(projectId, GAUNTLET_EVENT, {
      passed: receipt.passed,
      vacuous: receipt.vacuous,
      headSha: receipt.headSha,
      kinds: checks.map((c) => `${c.kind}:${c.outcome}`),
    })
  } catch {
    /* receipt storage is best-effort — the printed result is still true */
  }

  return receipt
}

export function readGauntletReceipt(
  projectId: string
): { data: GauntletReceipt; updatedAt: string } | null {
  try {
    return prjctDb.getDocWithStamp<GauntletReceipt>(projectId, GAUNTLET_DOC_KEY)
  } catch {
    return null
  }
}

export function recordGauntletOverride(projectId: string): void {
  try {
    prjctDb.appendEvent(projectId, GAUNTLET_OVERRIDE_EVENT, { at: new Date().toISOString() })
  } catch {
    /* best-effort */
  }
}

export interface GauntletVerdictInput {
  receipt: GauntletReceipt | null
  nowMs: number
  /** Current HEAD at gate time (null = unknown/non-git). */
  headSha: string | null
  hasCommands: boolean
  /** code-strict pack: missing/stale receipt blocks instead of warning. */
  strict: boolean
  override: boolean
}

export interface GauntletVerdict {
  blocked: boolean
  message: string | null
}

function receiptFresh(input: GauntletVerdictInput): boolean {
  const receipt = input.receipt
  if (!receipt) return false
  const age = input.nowMs - Date.parse(receipt.ranAt)
  if (!Number.isFinite(age) || age > GAUNTLET_FRESH_MS) return false
  if (receipt.headSha && input.headSha && receipt.headSha !== input.headSha) return false
  return true
}

/** Pure ship-gate verdict — mirrors the judgment gate's shape. */
export function gauntletShipVerdict(input: GauntletVerdictInput): GauntletVerdict {
  if (input.override) {
    return { blocked: false, message: 'Gauntlet gate overridden (--no-gauntlet) — recorded.' }
  }
  if (!input.hasCommands) {
    return {
      blocked: false,
      message:
        'Gauntlet is vacuous: no verify commands registered (typecheck/lint/test) — nothing machine-checked this ship.',
    }
  }
  const fresh = receiptFresh(input)
  if (input.receipt && !input.receipt.vacuous && !input.receipt.passed && fresh) {
    const red = input.receipt.checks.filter((c) => !c.ok).map((c) => `${c.kind} ${c.outcome}`)
    return {
      blocked: true,
      message: `Machine gauntlet is RED (${red.join(', ')}). Fix and re-run \`prjct gauntlet\`, or override explicitly with --no-gauntlet.`,
    }
  }
  if (!fresh) {
    const why = input.receipt ? 'stale (HEAD moved or older than 30min)' : 'missing'
    if (input.strict) {
      return {
        blocked: true,
        message: `No fresh green gauntlet for this HEAD (receipt ${why}). Run \`prjct gauntlet\` first, or override with --no-gauntlet.`,
      }
    }
    return {
      blocked: false,
      message: `⚠ Gauntlet receipt ${why} — this ship is not machine-verified. Run \`prjct gauntlet\` before shipping.`,
    }
  }
  return { blocked: false, message: '✓ Gauntlet green for HEAD — machine-verified.' }
}

/** Non-blocking `status done` warning: done without a machine-green HEAD. */
export async function gauntletDoneWarning(
  projectPath: string,
  projectId: string
): Promise<string | null> {
  try {
    if (!(await projectHasGauntletCommands(projectPath))) return null
    const stamped = readGauntletReceipt(projectId)
    const binding = await gitBinding(projectPath)
    const verdict = gauntletShipVerdict({
      receipt: stamped?.data ?? null,
      nowMs: Date.now(),
      headSha: binding.headSha,
      hasCommands: true,
      strict: false,
      override: false,
    })
    if (verdict.blocked) return verdict.message
    if (verdict.message?.startsWith('⚠')) return verdict.message
    if (stamped && !stamped.data.passed && !stamped.data.vacuous) {
      return 'Machine gauntlet is RED for an earlier HEAD — re-run `prjct gauntlet` before shipping.'
    }
    return null
  } catch {
    return null
  }
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

export function renderGauntletMd(receipt: GauntletReceipt): string {
  const state = receipt.vacuous ? 'VACUOUS' : receipt.passed ? 'PASS' : 'RED'
  const head = receipt.headSha
    ? `${receipt.headSha.slice(0, 8)}${receipt.dirty ? ' (dirty)' : ' (clean)'}`
    : 'no git'
  const rows = receipt.checks.map(
    (c) => `| ${c.kind} | ${c.ok ? '✓' : `✗ ${c.outcome}`} | ${secs(c.durationMs)} |`
  )
  const failures = receipt.checks
    .filter((c) => !c.ok && c.detail)
    .map((c) => `**${c.kind}**\n\`\`\`\n${c.detail}\n\`\`\``)
  return [
    `## Gauntlet — ${state}`,
    '',
    `- HEAD ${head} · ran ${receipt.ranAt}`,
    '',
    ...(receipt.checks.length > 0
      ? ['| check | result | time |', '|---|---|---|', ...rows, '']
      : []),
    ...(failures.length > 0 ? [...failures, ''] : []),
    receipt.vacuous
      ? '_No verify commands registered — this pass proves nothing. Add typecheck/lint/test scripts._'
      : receipt.passed
        ? '_Machine-verified. The receipt gates `prjct ship` for this HEAD (30min)._'
        : '_RED — the work does not count yet. Fix and re-run._',
    '',
  ].join('\n')
}

export function renderGauntletText(receipt: GauntletReceipt): string {
  const state = receipt.vacuous ? 'VACUOUS' : receipt.passed ? 'PASS' : 'RED'
  const head = receipt.headSha ? receipt.headSha.slice(0, 8) : 'no-git'
  const lines = [`Gauntlet ${state} · HEAD ${head}${receipt.dirty ? ' (dirty)' : ''}`]
  for (const c of receipt.checks) {
    lines.push(
      `  ${c.ok ? '✓' : '✗'} ${c.kind.padEnd(9)} ${c.ok ? '' : c.outcome} ${secs(c.durationMs)}`
    )
    if (!c.ok && c.detail) lines.push(`      ${c.detail.split('\n').slice(-3).join('\n      ')}`)
  }
  if (receipt.vacuous) lines.push('  (no verify commands registered — nothing was checked)')
  return lines.join('\n')
}
