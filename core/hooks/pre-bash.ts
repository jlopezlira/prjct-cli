/**
 * Consolidated PreToolUse(Bash) hook.
 *
 * One host event now starts one prjct process instead of three. The security
 * decision stays first, then package legitimacy, while commit memory and the
 * advisory package message are combined into one context payload.
 */

import { broadProcessTerminationDenial } from '../services/instruction-guidance'
import { type HookIo, runHook } from './_runner'
import { buildPreCommitContext, type CommitHookInput, isCommitInput } from './pre-commit'
import {
  evaluatePrePackageInput,
  type PackageHookInput,
  type PrePackageEvaluation,
} from './pre-package'
import { decideSecrets, type SecretHookInput } from './pre-secrets'

type BashHookInput = SecretHookInput & CommitHookInput & PackageHookInput

const packageEvaluationCache = new WeakMap<object, Promise<PrePackageEvaluation | null>>()

function extractCommand(input: BashHookInput): string {
  const toolInput = (input.tool_input ?? input.toolInput) as Record<string, unknown> | undefined
  if (toolInput && typeof toolInput.command === 'string') return toolInput.command
  if (typeof input.command === 'string') return input.command
  // Some hosts send `command_line` instead of `command` — pre-package.ts
  // already handles this; missing it here silently no-ops the broad
  // process-termination gate for any such host, since `decideBroadProcessTermination`
  // treats an empty extracted command as "nothing to evaluate".
  if (toolInput && typeof toolInput.command_line === 'string') return toolInput.command_line
  return ''
}

export function decideBroadProcessTermination(input: BashHookInput): { deny: string } | null {
  const command = extractCommand(input)
  const denial = command ? broadProcessTerminationDenial(command) : null
  return denial ? { deny: denial } : null
}

function evaluatePackageOnce(
  projectPath: string,
  input: BashHookInput
): Promise<PrePackageEvaluation | null> {
  const key = input as object
  const cached = packageEvaluationCache.get(key)
  if (cached) return cached
  const evaluation = evaluatePrePackageInput(projectPath, input)
  packageEvaluationCache.set(key, evaluation)
  return evaluation
}

export function runPreBashHook(projectPath: string = process.cwd(), io?: HookIo): Promise<void> {
  return runHook<BashHookInput>(
    {
      event: 'PreToolUse',
      projectPath,
      decide: async (input, p) => {
        try {
          const secretDecision = decideSecrets(input)
          if (secretDecision) return secretDecision
          const processDecision = decideBroadProcessTermination(input)
          if (processDecision) return processDecision
          const evaluation = await evaluatePackageOnce(p, input)
          return evaluation?.strict ? { deny: evaluation.message } : null
        } catch {
          return null
        }
      },
      build: async (input, p) => {
        try {
          const [commitContext, packageEvaluation] = await Promise.all([
            isCommitInput(input) ? buildPreCommitContext(p) : null,
            evaluatePackageOnce(p, input),
          ])
          const packageContext =
            packageEvaluation && !packageEvaluation.strict
              ? `# prjct: package legitimacy (advisory)\n${packageEvaluation.message}`
              : null
          const context = [commitContext, packageContext].filter(Boolean).join('\n\n')
          return context || null
        } catch {
          return null
        } finally {
          packageEvaluationCache.delete(input as object)
        }
      },
    },
    io
  )
}
