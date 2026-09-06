/**
 * Proof-carrying verify — the red→green contract that makes a fix a measurement,
 * not a claim (the T4 confabulation lesson: the model that invents a cause also
 * argues for it, so require the SAME command to flip from failing to passing
 * across a real tree change).
 *
 *   recordRepro(cmd) — run cmd, REQUIRE a non-zero exit (a repro must fail),
 *                      bind the receipt to the current tree (verificationBinding).
 *   recordFix(cmd)   — require a prior repro, run cmd, REQUIRE exit 0 AND a
 *                      different treeHash (the working tree actually changed).
 *
 * The proof is the exit-code flip bound to two distinct trees. A green with the
 * same tree as the repro is refused — nothing changed, so nothing was fixed.
 */

import { createHash } from 'node:crypto'
import prjctDb from '../storage/database'
import { type VerificationBinding, verificationBinding } from './verification-binding'
import { runVerifyCommand } from './verify-runner'

export type VerifyPhase = 'repro' | 'green'

export interface VerifyReceipt {
  version: 1
  command: string
  phase: VerifyPhase
  binding: VerificationBinding | null
  exitCode: number | null
  detail: string
  at: string
}

export interface ReproResult {
  ok: boolean
  reason?: string
  receipt?: VerifyReceipt
}

export interface FixResult {
  ok: boolean
  reason?: string
  repro?: VerifyReceipt
  green?: VerifyReceipt
}

function docKey(command: string): string {
  return `verify:contract:${createHash('sha256').update(command).digest('hex').slice(0, 16)}`
}

export function latestContract(projectId: string, command: string): VerifyReceipt | null {
  return prjctDb.getDoc<VerifyReceipt>(projectId, docKey(command))
}

/**
 * Record a reproduction: the command MUST fail. A passing command is not a
 * repro — there is nothing to fix — so it is refused rather than stored.
 */
export async function recordRepro(
  projectId: string,
  projectPath: string,
  command: string,
  opts: { timeoutMs?: number } = {}
): Promise<ReproResult> {
  const run = await runVerifyCommand(projectPath, command, opts)
  if (run.ok) {
    return {
      ok: false,
      reason: `\`${command}\` already passes — a reproduction must fail. Nothing to fix.`,
    }
  }
  const receipt: VerifyReceipt = {
    version: 1,
    command,
    phase: 'repro',
    binding: await verificationBinding(projectPath, ['verify', command]),
    exitCode: run.exitCode,
    detail: run.detail.slice(-2000),
    at: new Date().toISOString(),
  }
  prjctDb.setDoc(projectId, docKey(command), receipt)
  return { ok: true, receipt }
}

/**
 * Record a fix: requires a prior repro for the same command, the command must
 * now pass, AND the tree must differ from the repro's (a real change). On
 * success the receipt flips to `green`.
 */
export async function recordFix(
  projectId: string,
  projectPath: string,
  command: string,
  opts: { timeoutMs?: number } = {}
): Promise<FixResult> {
  const repro = latestContract(projectId, command)
  if (!repro || repro.phase !== 'repro') {
    return {
      ok: false,
      reason: `No reproduction recorded for \`${command}\`. Run \`prjct verify repro "${command}"\` first.`,
    }
  }
  const run = await runVerifyCommand(projectPath, command, opts)
  if (!run.ok) {
    return {
      ok: false,
      reason: `\`${command}\` still fails — not fixed yet.\n${run.detail}`,
      repro,
    }
  }
  const binding = await verificationBinding(projectPath, ['verify', command])
  if (binding && repro.binding && binding.treeHash === repro.binding.treeHash) {
    return {
      ok: false,
      reason: `\`${command}\` passes but the working tree is unchanged from the reproduction — a fix must change the code. Edit, then re-run.`,
      repro,
    }
  }
  const green: VerifyReceipt = {
    version: 1,
    command,
    phase: 'green',
    binding,
    exitCode: 0,
    detail: '',
    at: new Date().toISOString(),
  }
  prjctDb.setDoc(projectId, docKey(command), green)
  return { ok: true, repro, green }
}
