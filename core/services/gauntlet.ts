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

import configManager from '../infrastructure/config-manager'
import prjctDb from '../storage/database'
import { gitStdout, listChangedFiles, matchProc, runProc } from '../utils/exec'
import { detectVerifiedCommands } from './project-command-facts'

const GAUNTLET_DOC_KEY = 'gauntlet:latest'
const GAUNTLET_EVENT = 'gauntlet-run'
const GAUNTLET_OVERRIDE_EVENT = 'gauntlet-override'
const GAUNTLET_RUNNING_KEY = 'gauntlet:running'
/** A background warm marker older than this is a dead run — spawn again. */
const RUNNING_STALE_MS = 15 * 60 * 1000
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
  /**
   * The command could not RUN here (binary absent, toolchain component not
   * installed, deps not fetched) — an environment gap, never a code defect.
   * A ship must not be blocked because `cargo clippy` or `mvn` is missing on
   * this machine, so these do not fail the gate — but they are reported
   * loudly, because a receipt that hides what it skipped is a fake green.
   */
  unavailable?: boolean
}

/**
 * Addressed to the AGENT, not the human: when neither the manifest nor CI
 * names a verify command, the agent reading the repo is the one thing that
 * always knows the language, so it registers the command itself. That is what
 * makes the gate real for an ecosystem nobody hardcoded, without anyone having
 * to remember a config file.
 */
const VACUOUS_BOOTSTRAP =
  'No machine gate for this project yet — NOTHING verifies the work, in any language. ' +
  'AGENT: you are reading this repo, so YOU decide how it verifies itself — read its CI, ' +
  'build files, docs, scripts — and register what you find: ' +
  '`prjct gauntlet set test "<command>"` (also lint / typecheck). One time, then the gate is real.'

/**
 * SessionStart cue — the division of labor this harness runs on: prjct states
 * the requirement and owns the mechanism (run · receipt · refuse red ships);
 * the MODEL decides what the commands are. Whatever the manifests happen to
 * declare is passed along as raw evidence for the agent to confirm or
 * override — never as prjct's own conclusion about the project.
 */
export async function gauntletBootstrapCue(projectPath: string): Promise<string | null> {
  try {
    if (await projectHasGauntletCommands(projectPath)) return null
    // Terse by mandate: this rides the always-on SessionStart block, whose
    // char ceiling is a release gate (it caught this line 129 chars over).
    // The instruction belongs here; the evidence and the full explanation
    // belong in `prjct gauntlet` output, where bytes are cheap.
    return '# prjct: no machine gate\nNothing verifies this project. AGENT: identify its test/lint/typecheck commands and register them — `prjct gauntlet set test "<cmd>"`.'
  } catch {
    return null
  }
}

/**
 * POSIX "command not found" — the ONLY signal used to call a check
 * unavailable, because it is decided by the shell, not by us.
 *
 * An earlier version also pattern-matched the output for phrases like "not
 * installed". It misfired on this very repo: a real red test suite whose
 * output happened to contain such a phrase was reported as ⊘ not-installed,
 * turning a genuine failure into a silent pass. Guessing intent from output
 * text is the model's job, and a gate that guesses wrong is worse than no
 * gate — so the heuristic is gone.
 */
const EXIT_COMMAND_NOT_FOUND = 127

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
  // Declared commands win outright: detection can only cover ecosystems prjct
  // knows, while `gauntlet.commands` makes the gate work for ANY language —
  // including one nobody has taught it yet.
  const declared = await (async () => {
    try {
      const config = await configManager.readConfig(projectPath)
      return (config?.gauntlet?.commands ?? []).filter(
        (entry) => typeof entry?.command === 'string' && entry.command.trim().length > 0
      )
    } catch {
      return []
    }
  })()
  if (declared.length > 0) {
    return declared.map(({ kind, command }) => ({ kind, command: command.trim() }))
  }

  // Fast path ONLY, never the guarantee: a manifest whose toolchain is already
  // standardized. prjct does not try to infer commands for every language —
  // parsing CI, guessing tools, keeping a table of ecosystems is prjct
  // pretending to be the intelligence when a model that already reads this
  // repo is right there. Anything this misses is the agent's job (see
  // VACUOUS_BOOTSTRAP), and what the agent registers wins outright.
  const byKind = new Map<string, string>()
  const facts = await detectVerifiedCommands(projectPath)
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
    exit: (r) => {
      const output = `${r.stdout}\n${r.stderr}`.trim()
      const unavailable = r.code === EXIT_COMMAND_NOT_FOUND
      return {
        kind,
        command,
        ok: false,
        unavailable,
        outcome: unavailable ? 'unavailable' : `exit:${r.code ?? 'signal'}`,
        durationMs: r.durationMs,
        detail: output.slice(-OUTPUT_TAIL_CHARS),
      }
    },
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
      unavailable: true, // the shell itself could not start it
      outcome: 'unavailable',
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
    // An absent tool never fails the gate; it also never counts as verified —
    // if NOTHING could run, the receipt is vacuous, not green.
    passed: checks.every((c) => c.ok || c.unavailable),
    vacuous: commands.length === 0 || checks.every((c) => c.unavailable),
    checks,
  }

  try {
    prjctDb.setDoc(projectId, GAUNTLET_DOC_KEY, receipt)
    prjctDb.deleteDoc(projectId, GAUNTLET_RUNNING_KEY)
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

/**
 * Persist a verify command for this project — how the AGENT teaches the gate a
 * language nobody hardcoded. The agent is already reading the repo, so it can
 * name the command (`swift test`, `stack test`, `zig build test`) and register
 * it here; no human has to hand-edit JSON or remember anything.
 */
export async function setGauntletCommand(
  projectPath: string,
  kind: string,
  command: string
): Promise<{ ok: boolean; error?: string }> {
  const normalizedKind = kind.trim().toLowerCase()
  if (!GAUNTLET_KINDS.includes(normalizedKind as (typeof GAUNTLET_KINDS)[number])) {
    return { ok: false, error: `kind must be one of: ${GAUNTLET_KINDS.join(', ')}` }
  }
  const normalizedCommand = command.trim()
  if (!normalizedCommand) return { ok: false, error: 'command is empty' }
  try {
    const config = await configManager.readConfig(projectPath)
    if (!config) return { ok: false, error: 'No prjct project here — run `prjct init` first.' }
    const existing = (config.gauntlet?.commands ?? []).filter((c) => c.kind !== normalizedKind)
    await configManager.writeConfig(projectPath, {
      ...config,
      gauntlet: {
        ...config.gauntlet,
        commands: [
          ...existing,
          { kind: normalizedKind as 'typecheck' | 'lint' | 'test', command: normalizedCommand },
        ],
      },
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
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

export function isReceiptFresh(
  receipt: GauntletReceipt | null,
  nowMs: number,
  headSha: string | null
): boolean {
  if (!receipt) return false
  const age = nowMs - Date.parse(receipt.ranAt)
  if (!Number.isFinite(age) || age > GAUNTLET_FRESH_MS) return false
  if (receipt.headSha && headSha && receipt.headSha !== headSha) return false
  return true
}

function receiptFresh(input: GauntletVerdictInput): boolean {
  return isReceiptFresh(input.receipt, input.nowMs, input.headSha)
}

/** Pure ship-gate verdict — mirrors the judgment gate's shape. */
export function gauntletShipVerdict(input: GauntletVerdictInput): GauntletVerdict {
  if (input.override) {
    return { blocked: false, message: 'Gauntlet gate overridden (--no-gauntlet) — recorded.' }
  }
  if (!input.hasCommands) {
    return {
      blocked: false,
      message: VACUOUS_BOOTSTRAP,
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

/**
 * Ship-time self-provisioning: nobody has to remember to run the gauntlet —
 * when the receipt is missing or stale (and there is no explicit override),
 * ship runs the machine verification inline and gates on the REAL result.
 */
export async function ensureShipGauntlet(
  projectPath: string,
  projectId: string,
  opts: { headSha: string | null; strict: boolean; override: boolean }
): Promise<GauntletVerdict> {
  const hasCommands = await projectHasGauntletCommands(projectPath)
  const existing = readGauntletReceipt(projectId)?.data ?? null
  const base = {
    nowMs: Date.now(),
    headSha: opts.headSha,
    hasCommands,
    strict: opts.strict,
    override: opts.override,
  }
  if (opts.override || !hasCommands || isReceiptFresh(existing, base.nowMs, opts.headSha)) {
    return gauntletShipVerdict({ ...base, receipt: existing })
  }
  console.log('Gauntlet receipt missing or stale — running machine verification now…')
  const receipt = await runGauntlet(projectPath, projectId)
  return gauntletShipVerdict({ ...base, nowMs: Date.now(), receipt })
}

/**
 * Fire-and-forget background warm (done/land call this): spawns a detached
 * `prjct gauntlet` so the next ship finds a fresh receipt without anyone
 * remembering to run it. Skips when a fresh green receipt already exists,
 * when a warm is already in flight, on win32, and always under tests.
 */
export async function warmGauntletInBackground(
  projectPath: string,
  projectId: string
): Promise<boolean> {
  try {
    if (process.platform === 'win32') return false
    // Never spawn a real CLI from inside a test process: PRJCT_TEST_MODE is
    // the standard guard, but some tests clear it to cover their own branches
    // — PRJCT_TEST_HOME (the sandbox marker set by the first preload) is the
    // order-independent belt.
    if (process.env.PRJCT_TEST_MODE === '1' || process.env.PRJCT_TEST_HOME) return false
    if (!(await projectHasGauntletCommands(projectPath))) return false
    const binding = await gitBinding(projectPath)
    const stamped = readGauntletReceipt(projectId)
    const fresh = isReceiptFresh(stamped?.data ?? null, Date.now(), binding.headSha)
    if (fresh && stamped?.data.passed) return false
    const running = prjctDb.getDocWithStamp<{ startedAt: string }>(projectId, GAUNTLET_RUNNING_KEY)
    if (running && Date.now() - Date.parse(running.data.startedAt) < RUNNING_STALE_MS) return false
    prjctDb.setDoc(projectId, GAUNTLET_RUNNING_KEY, { startedAt: new Date().toISOString() })
    const { spawn } = await import('node:child_process')
    const child = spawn(
      '/bin/sh',
      ['-c', 'command -v prjct >/dev/null 2>&1 && prjct gauntlet >/dev/null 2>&1'],
      { cwd: projectPath, detached: true, stdio: 'ignore' }
    )
    child.unref()
    return true
  } catch {
    return false
  }
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
    (c) =>
      `| ${c.kind} | ${c.ok ? '✓' : c.unavailable ? '⊘ not installed here' : `✗ ${c.outcome}`} | ${secs(c.durationMs)} |`
  )
  const unavailable = receipt.checks.filter((c) => c.unavailable)
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
    ...(unavailable.length > 0
      ? [
          `⊘ **${unavailable.length} check(s) could not run here** (${unavailable.map((c) => c.kind).join(', ')}) — an absent tool is not a code defect, so the gate is not failed by it, but ${unavailable.length === receipt.checks.length ? 'NOTHING was verified' : 'those dimensions are unverified'}. Install the tool, or point the gate at what you do run via \`gauntlet.commands\`.`,
          '',
        ]
      : []),
    receipt.vacuous
      ? `_${VACUOUS_BOOTSTRAP}_`
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
    const mark = c.ok ? '✓' : c.unavailable ? '⊘' : '✗'
    const note = c.ok ? '' : c.unavailable ? 'not installed here (not a defect)' : c.outcome
    lines.push(`  ${mark} ${c.kind.padEnd(9)} ${note} ${secs(c.durationMs)}`)
    if (!c.ok && !c.unavailable && c.detail) {
      lines.push(`      ${c.detail.split('\n').slice(-3).join('\n      ')}`)
    }
  }
  if (receipt.vacuous) lines.push('  (no verify commands registered — nothing was checked)')
  return lines.join('\n')
}
