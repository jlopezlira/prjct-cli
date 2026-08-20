/**
 * Workflow Engine (v2)
 *
 * Unified rule execution for hooks, gates, steps, and instructions.
 *
 * Current capabilities:
 *   - conditional rules via `when_expr` (see when-evaluator.ts)
 *   - parallel hook execution (opt-out per rule)
 *   - action prefixes that route to specialized handlers:
 *       `status:<value>` → state machine transition
 *       `script:<path>`  → run a bash script from `.prjct/workflows/<path>`
 *       `mcp:<server>:<tool>[:<json>]` → emit an MCP-call instruction to
 *         the LLM (prjct-cli can't hold an MCP connection; we declare
 *         the QUÉ and let Claude call the CÓMO)
 *       `persona:context`  → re-inject the project persona into output
 *       `verify:<command>` → deterministic Stop-Slop gate: run <command>;
 *         a non-zero exit blocks the lifecycle with actionable stop-the-line
 *         guidance (the harness catching what a degraded model would ship).
 *         `verify:auto` auto-detects the project's test command.
 *
 * Alpha.10 removed: gate result caching and the Spanish/English NL
 * intent parser in `core/commands/workflow.ts`. Both were harness —
 * cache made "gate didn't run" invisible; NL parser guessed intent
 * instead of letting Claude (or the human) author rules directly.
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import chalk from 'chalk'
import { STATUS_CHANGE_ACTION, TAG_EVENT_TYPE } from '../memory/events'
import { ChangelogService } from '../services/changelog-service'
import { memoryService } from '../services/memory-service'
import { inferBumpLevel, VersionService } from '../services/version-service'
import { getGitBranch } from '../session/git-helpers'
import prjctDb from '../storage/database'
import { stateStorage } from '../storage/state-storage'
import { workflowRuleStorage } from '../storage/workflow-rule-storage'
import type { LocalConfig, ProjectPersona } from '../types/config'
import { getErrorMessage } from '../types/fs'
import type { WorkflowRule } from '../types/storage/extended'
import type { WorkflowExecutionResult, WorkflowRunContext } from '../types/workflow.js'
import { execAsync, execFileAsync, matchProc, runProc } from '../utils/exec'
import { detectProjectCommands } from '../utils/project-commands'
import {
  finishWorkflowRun,
  recordGateEvaluation,
  recordRunStep,
  startWorkflowRun,
} from './run-recorder'
import { evaluateWhen, type WhenContext } from './when-evaluator'

const STATUS_ACTION_PREFIX = 'status:'
const SCRIPT_ACTION_PREFIX = 'script:'
const MCP_ACTION_PREFIX = 'mcp:'
const PERSONA_CONTEXT_ACTION = 'persona:context'
const VERSION_BUMP_PREFIX = 'version:bump'
const CHANGELOG_ADD_ACTION = 'changelog:add'
const GIT_COMMIT_PREFIX = 'git:commit'
const GIT_PUSH_ACTION = 'git:push'
const PR_ENSURE_ACTION = 'pr:ensure'
const VERIFY_ACTION_PREFIX = 'verify:'

async function runStatusTransition(
  projectId: string,
  projectPath: string,
  target: string
): Promise<void> {
  const active = await stateStorage.getCurrentTask(projectId)
  if (!active) {
    throw new Error(`Cannot transition to '${target}': no active work cycle`)
  }
  await memoryService.log(projectPath, STATUS_CHANGE_ACTION, {
    taskId: active.id,
    from: active.type ?? null,
    to: target,
    source: 'workflow',
  })
}

async function runShellAction(rule: WorkflowRule, projectPath: string): Promise<void> {
  // Trust boundary: imported (cloud/shared-template) rules never auto-execute.
  const { evaluateWorkflowRuleExecutable } = await import('../services/trust-boundary')
  const trust = evaluateWorkflowRuleExecutable(rule.trustSource, rule.description || rule.action)
  if (!trust.allow) throw new Error(trust.denyMessage)
  await execAsync(rule.action, {
    timeout: rule.timeoutMs,
    cwd: projectPath,
    env: { ...process.env },
  })
}

/**
 * `verify:<command>` — a deterministic Stop-Slop gate. Runs <command> as a
 * blocking check in the project; a non-zero exit throws a STANDARDIZED
 * stop-the-line error. As a `gate` rule it lands in `gatesFailed` and blocks
 * the lifecycle verb (e.g. `ship`), and the wrapped message tells a possibly
 * degraded model exactly what to do: do not proceed, fix, re-run. This is the
 * harness compensating for the brain — structure catches the slop a weaker
 * model would otherwise ship. Unlike `script:<path>` it runs an inline
 * command; unlike a raw shell rule it turns exit≠0 into actionable guidance.
 */
/**
 * Resolve `verify:auto` to the project's own verification command so a
 * Stop-Slop gate is one token, no hardcoding. Reuses the canonical detector
 * (DRY) — JS/TS package-manager `scripts.test` AND Python/pytest. Returns null
 * when no convention is found; the caller turns that into actionable guidance.
 */
export async function detectVerifyCommand(projectPath: string): Promise<string | null> {
  const { test } = await detectProjectCommands(projectPath)
  return test?.command ?? null
}

async function runVerifyAction(rule: WorkflowRule, projectPath: string): Promise<void> {
  const { evaluateWorkflowRuleExecutable } = await import('../services/trust-boundary')
  const trust = evaluateWorkflowRuleExecutable(rule.trustSource, rule.description || rule.action)
  if (!trust.allow) throw new Error(trust.denyMessage)
  const configuredCommand = rule.action.slice(VERIFY_ACTION_PREFIX.length).trim()
  if (!configuredCommand) throw new Error(`Empty command in verify action '${rule.action}'`)
  const command =
    configuredCommand === 'auto'
      ? await detectVerifyCommand(projectPath).then((detected) => {
          if (!detected) {
            throw new Error(
              'verify:auto found no test script (package.json `scripts.test`). ' +
                'Specify an explicit check, e.g. `verify:bun test` or `verify:npm run typecheck`.'
            )
          }
          return detected
        })
      : configuredCommand
  // runProc (not exec): stdin ignored so bun test does not hang in watch/pipe
  // mode; tree-kill on timeout; overflow is infra not a silent 1MB crash.
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
  const result = await runProc(shell, shellArgs, {
    timeoutMs: rule.timeoutMs,
    cwd: projectPath,
    env: { ...process.env },
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.ok) return
  const detail = matchProc(result, {
    ok: () => '',
    exit: (r) => {
      const out = `${r.stderr}\n${r.stdout}`.trim()
      return out ? out.slice(-4000) : `exit ${r.code}`
    },
    timeout: (r) => `timed out after ${r.budgetMs}ms`,
    spawn: (r) => r.cause.message,
    overflow: (r) => `output exceeded ${r.maxBuffer} bytes`,
  })
  throw new Error(
    `Verification failed: \`${command}\`\n${detail}\n` +
      'Stop-the-line: do not proceed. Fix the failure and re-run this check — ' +
      'unverified output must not advance.'
  )
}

/**
 * Run a user-authored bash script stored under `.prjct/workflows/<path>`.
 * The script receives the rule args via env so users/Claude can author
 * scripts that react to whatever tags/branch/description the task
 * carried. We deliberately don't pass the action inline — the script
 * path is the contract; everything else comes via env.
 */
async function runScriptAction(
  rule: WorkflowRule,
  projectPath: string,
  whenCtx: WhenContext
): Promise<void> {
  const { evaluateWorkflowRuleExecutable } = await import('../services/trust-boundary')
  const trust = evaluateWorkflowRuleExecutable(rule.trustSource, rule.description || rule.action)
  if (!trust.allow) throw new Error(trust.denyMessage)
  const relativePath = rule.action.slice(SCRIPT_ACTION_PREFIX.length).trim()
  if (!relativePath) throw new Error(`Empty script path in action '${rule.action}'`)
  // Reject absolute paths and null bytes before resolve — no host-root scripts.
  if (path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error(`Script path escapes workflows dir: ${relativePath}`)
  }

  const workflowsRoot = path.resolve(projectPath, '.prjct/workflows')
  const candidate = path.resolve(workflowsRoot, relativePath)
  // relative() + ".." is robust against startsWith prefix tricks; realpath
  // collapses symlinks that would otherwise jump outside the workflows tree.
  const relToRoot = path.relative(workflowsRoot, candidate)
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new Error(`Script path escapes workflows dir: ${relativePath}`)
  }
  const scriptPath = await fs.realpath(candidate).catch(() => {
    throw new Error(`Script not found: .prjct/workflows/${relativePath}`)
  })
  const resolvedRoot = await fs.realpath(workflowsRoot).catch(() => workflowsRoot)
  const relAfterReal = path.relative(resolvedRoot, scriptPath)
  if (relAfterReal.startsWith('..') || path.isAbsolute(relAfterReal)) {
    throw new Error(`Script path escapes workflows dir: ${relativePath}`)
  }

  // execFile — no shell, argv only (script path is a single resolved file).
  await execFileAsync('bash', [scriptPath], {
    timeout: rule.timeoutMs,
    cwd: projectPath,
    env: {
      ...process.env,
      PRJCT_BRANCH: whenCtx.branch,
      PRJCT_FILES_CHANGED: whenCtx.filesChanged.join(','),
      PRJCT_TAGS: Object.entries(whenCtx.tags)
        .map(([k, v]) => `${k}=${v}`)
        .join(','),
    },
  })
}

/**
 * MCP actions are **declarative** — prjct-cli runs outside the MCP
 * connection Claude has open in the host, so we can't actually invoke
 * the tool ourselves. We surface the intended call as an instruction so
 * Claude (who IS connected) picks it up and executes it. Keeps us
 * firmly in "QUÉ not CÓMO" territory.
 *
 * Format: `mcp:<server>:<tool>[:<json-args>]`
 * Example: `mcp:linear:list_issues:{"state":"open"}`
 */
function buildMcpInstruction(rule: WorkflowRule): string {
  const rest = rule.action.slice(MCP_ACTION_PREFIX.length).trim()
  const firstColon = rest.indexOf(':')
  if (firstColon === -1) {
    return `Call MCP tool ${JSON.stringify(rest)} (server unspecified — re-author rule with format \`mcp:<server>:<tool>[:<args>]\`).`
  }
  const server = rest.slice(0, firstColon)
  const rest2 = rest.slice(firstColon + 1)
  const argsColon = rest2.indexOf(':')
  const tool = argsColon === -1 ? rest2 : rest2.slice(0, argsColon)
  const args = argsColon === -1 ? '' : rest2.slice(argsColon + 1)

  const label = rule.description ? ` (${rule.description})` : ''
  return args
    ? `Call MCP \`${server}.${tool}\` with args ${args}${label}.`
    : `Call MCP \`${server}.${tool}\`${label}.`
}

/**
 * `persona:context` emits the project persona as an instruction so a
 * long-running workflow can re-anchor Claude mid-run (useful after
 * several steps that might drift the context).
 */
async function buildPersonaInstruction(projectPath: string): Promise<string> {
  try {
    const { default: configManager } = await import('../infrastructure/config-manager')
    const config = (await configManager.readConfig(projectPath)) as LocalConfig | null
    const persona = config?.persona as ProjectPersona | undefined
    if (!persona) {
      return 'No persona declared for this project — `.prjct/prjct.config.json` has no `persona` field.'
    }
    const parts: string[] = [`You are **${persona.role}** in this project.`]
    if (persona.focus) parts.push(`Focus: ${persona.focus}.`)
    if (persona.mcps && persona.mcps.length > 0) {
      parts.push(`MCPs available: ${persona.mcps.join(', ')}.`)
    }
    if (persona.packs && persona.packs.length > 0) {
      parts.push(`Active packs: ${persona.packs.join(', ')}.`)
    }
    return parts.join(' ')
  } catch (error) {
    return `Could not resolve persona: ${getErrorMessage(error)}`
  }
}

async function runVersionBump(projectPath: string, runCtx: WorkflowRunContext): Promise<void> {
  const service = new VersionService(projectPath)
  // A ship is a feature by default → minor; a `fix:`/`chore:`-prefixed feature
  // name → patch; `!`/"BREAKING CHANGE" → major. Previously every ship bumped
  // patch regardless, so feature releases landed as 2.32.x instead of 2.33.0.
  const level = inferBumpLevel(typeof runCtx.feature === 'string' ? runCtx.feature : undefined)
  const next = await service.bump(level)
  runCtx.version = next
}

async function runChangelogAdd(projectPath: string, runCtx: WorkflowRunContext): Promise<void> {
  const version = typeof runCtx.version === 'string' ? runCtx.version : null
  const feature = typeof runCtx.feature === 'string' ? runCtx.feature : null
  if (!version) {
    throw new Error('changelog:add requires a prior version:bump step (no version in runContext)')
  }
  if (!feature) {
    throw new Error(
      'changelog:add requires a feature name in runContext (set by ship before rules run)'
    )
  }
  const service = new ChangelogService(projectPath)
  await service.addFeature(version, feature)
}

function expandTemplate(template: string, runCtx: WorkflowRunContext): string {
  return template.replace(/\$([A-Z_]+)/g, (_match, name: string) => {
    const key = name.toLowerCase()
    const value = runCtx[key]
    return typeof value === 'string' ? value : ''
  })
}

async function runGitCommit(
  action: string,
  projectPath: string,
  runCtx: WorkflowRunContext
): Promise<void> {
  // Accept optional `git:commit:<template>` suffix. Default template uses
  // the feature (and version, if set) from runContext.
  const rawTemplate = action.slice(GIT_COMMIT_PREFIX.length).replace(/^:/, '').trim()
  const template = rawTemplate || (runCtx.version ? 'feat: $FEATURE (v$VERSION)' : 'feat: $FEATURE')
  const msg = `${expandTemplate(template, runCtx)}\n\nGenerated with [p/](https://www.prjct.app/)`

  await execFileAsync('git', ['add', '.'], { cwd: projectPath })
  await execFileAsync('git', ['commit', '-m', msg], { cwd: projectPath })
}

/**
 * Decide the `git push` args from the current branch and its configured
 * upstream.
 *
 * A bare `git push` fails on a branch with no upstream (any fresh feature
 * branch) — and it fails AFTER git:commit already ran, leaving the ship
 * half-done. So respect a configured upstream when one exists (custom remotes
 * keep working), but set `-u origin HEAD` otherwise so new branches ship
 * cleanly.
 *
 * CRITICAL: only trust an upstream that tracks THIS branch. Git worktrees
 * created from `main` inherit `origin/main` as the new branch's upstream; a
 * bare `git push` there would push the feature commits straight to `main`.
 * When the upstream points at a differently-named branch, treat it as "no
 * usable upstream" and push `-u origin HEAD` so the branch tracks its own ref.
 */
export function decideGitPushArgs(currentBranch: string, upstream: string): string[] {
  const branch = currentBranch.trim()
  const up = upstream.trim()
  // Upstream looks like "origin/<branch>"; only a same-named branch is safe.
  const upstreamBranch = up.includes('/') ? up.slice(up.indexOf('/') + 1) : ''
  const upstreamTracksThisBranch = !!branch && upstreamBranch === branch
  return upstreamTracksThisBranch ? ['push'] : ['push', '-u', 'origin', 'HEAD']
}

async function runGitPush(projectPath: string): Promise<void> {
  const currentBranch = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: projectPath,
  })
    .then((r) => r.stdout.trim())
    .catch(() => '')

  const upstream = await execFileAsync(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { cwd: projectPath }
  )
    .then((r) => r.stdout.trim())
    .catch(() => '')

  const args = decideGitPushArgs(currentBranch, upstream)

  try {
    await execFileAsync('git', args, {
      cwd: projectPath,
      timeout: 30000,
    })
  } catch (error) {
    const message = getErrorMessage(error)
    // Surface real git error (no remote, permission, etc.) instead of generic failure
    throw new Error(`git push failed: ${message}`)
  }
}

/**
 * Ensure a PR exists (or already exists) for the current branch after
 * `git:push`. Every step before this one (bump/changelog/commit/push) is
 * genuinely consequential if it fails — this one is bookkeeping. A ship
 * that already landed the commit and pushed it must never be reported as
 * failed just because `gh` is missing, unauthenticated, or rate-limited —
 * so every failure path here is caught and reported as an instruction
 * line, never thrown. Idempotent: skips cleanly when a PR already exists
 * (the push above already updated it) so repeated ships on the same
 * branch don't error on `gh pr create`'s own "already exists" failure.
 */
async function runPrEnsure(
  projectPath: string,
  runCtx: WorkflowRunContext,
  result: WorkflowExecutionResult
): Promise<void> {
  try {
    const currentBranch = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectPath,
    }).then((r) => r.stdout.trim())
    if (!currentBranch || currentBranch === 'main' || currentBranch === 'master') return

    const ghAvailable = await execFileAsync('gh', ['--version'], { cwd: projectPath })
      .then(() => true)
      .catch(() => false)
    if (!ghAvailable) {
      result.instructions.push(
        '# prjct: pr:ensure skipped — `gh` CLI not found. Install it or open the PR manually.'
      )
      return
    }

    const existingCount = await execFileAsync(
      'gh',
      ['pr', 'list', '--head', currentBranch, '--json', 'number', '--jq', 'length'],
      { cwd: projectPath }
    )
      .then((r) => Number(r.stdout.trim()))
      .catch(() => -1)
    if (existingCount < 0) {
      result.instructions.push(
        '# prjct: pr:ensure could not check for an existing PR (gh not authenticated?) — skipped.'
      )
      return
    }
    if (existingCount > 0) return // Already has an open PR — the push above already updated it.

    const title = expandTemplate(
      runCtx.version ? 'feat: $FEATURE (v$VERSION)' : 'feat: $FEATURE',
      runCtx
    )
    const created = await execFileAsync(
      'gh',
      ['pr', 'create', '--fill', ...(title ? ['--title', title] : [])],
      { cwd: projectPath, timeout: 30000 }
    ).then((r) => r.stdout.trim())
    result.instructions.push(`# prjct: opened PR — ${created}`)
  } catch (error) {
    result.instructions.push(`# prjct: pr:ensure failed (non-blocking) — ${getErrorMessage(error)}`)
  }
}

async function runRuleAction(
  rule: WorkflowRule,
  projectId: string,
  projectPath: string,
  whenCtx: WhenContext,
  result: WorkflowExecutionResult,
  runCtx: WorkflowRunContext
): Promise<void> {
  const action = rule.action

  if (action.startsWith(STATUS_ACTION_PREFIX)) {
    const target = action.slice(STATUS_ACTION_PREFIX.length).trim()
    if (!target) throw new Error(`Empty status target in action '${action}'`)
    await runStatusTransition(projectId, projectPath, target)
    return
  }

  if (action.startsWith(SCRIPT_ACTION_PREFIX)) {
    await runScriptAction(rule, projectPath, whenCtx)
    return
  }

  if (action.startsWith(MCP_ACTION_PREFIX)) {
    // MCP actions are declarative — surface as instructions. Claude
    // (inside the host) decides whether/when to actually call.
    result.instructions.push(buildMcpInstruction(rule))
    return
  }

  if (action === PERSONA_CONTEXT_ACTION) {
    result.instructions.push(await buildPersonaInstruction(projectPath))
    return
  }

  if (action === VERSION_BUMP_PREFIX || action.startsWith(`${VERSION_BUMP_PREFIX}:`)) {
    await runVersionBump(projectPath, runCtx)
    return
  }

  if (action === CHANGELOG_ADD_ACTION) {
    await runChangelogAdd(projectPath, runCtx)
    return
  }

  if (action === GIT_COMMIT_PREFIX || action.startsWith(`${GIT_COMMIT_PREFIX}:`)) {
    await runGitCommit(action, projectPath, runCtx)
    return
  }

  if (action === GIT_PUSH_ACTION) {
    await runGitPush(projectPath)
    return
  }

  if (action === PR_ENSURE_ACTION) {
    await runPrEnsure(projectPath, runCtx, result)
    return
  }

  if (action.startsWith(VERIFY_ACTION_PREFIX)) {
    await runVerifyAction(rule, projectPath)
    return
  }

  await runShellAction(rule, projectPath)
}

// Test-only surface for the deterministic verification gate.
export const _verify = { runVerifyAction, VERIFY_ACTION_PREFIX }

async function buildWhenContext(projectId: string, projectPath: string): Promise<WhenContext> {
  // All three sub-queries are best-effort — a missing branch or empty
  // diff shouldn't stop workflow rules from running.
  const [branch, filesChanged, tags] = await Promise.all([
    resolveBranch(projectPath),
    resolveChangedFiles(projectPath),
    resolveActiveTags(projectId),
  ])
  return { branch, filesChanged, tags }
}

async function resolveBranch(projectPath: string): Promise<string> {
  try {
    return (await getGitBranch(projectPath)) || ''
  } catch {
    return ''
  }
}

async function resolveChangedFiles(projectPath: string): Promise<string[]> {
  const opts = { cwd: projectPath, encoding: 'utf-8' as const }
  const runDiff = async (cmd: string): Promise<string[]> => {
    try {
      return execSync(cmd, opts)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }
  // Run both diffs in parallel. execSync is blocking within a task, but
  // wrapping each in Promise.resolve lets them share the event loop tick.
  const [staged, unstaged] = await Promise.all([
    runDiff('git diff --cached --name-only'),
    runDiff('git diff --name-only'),
  ])
  return [...new Set([...staged, ...unstaged])]
}

async function resolveActiveTags(projectId: string): Promise<Record<string, string>> {
  try {
    const active = await stateStorage.getCurrentTask(projectId)
    const tags: Record<string, string> = {}
    if (active?.type) tags.type = active.type
    if (!active) return tags

    // Most recent `memory.task.tagged` for this task carries the full
    // dict populated by `prjct tag`.
    type EvtRow = { data: string }
    const row = prjctDb.get<EvtRow>(
      projectId,
      'SELECT data FROM events WHERE type = ? ORDER BY id DESC LIMIT 1',
      TAG_EVENT_TYPE
    )
    if (row) {
      try {
        const parsed = JSON.parse(row.data) as { taskId?: string; tags?: Record<string, string> }
        if (parsed.taskId === active.id && parsed.tags) return { ...tags, ...parsed.tags }
      } catch {
        // malformed row — fall through
      }
    }
    return tags
  } catch {
    return {}
  }
}

export async function executeWorkflowRules(
  projectId: string,
  command: string,
  phase: 'before' | 'after',
  options: {
    projectPath?: string
    skipRules?: boolean
    runContext?: WorkflowRunContext
  } = {}
): Promise<WorkflowExecutionResult> {
  const result: WorkflowExecutionResult = {
    success: true,
    gatesFailed: [],
    hooksFailed: [],
    stepsRun: [],
    instructions: [],
    output: '',
  }

  if (options.skipRules) return result

  const runCtx: WorkflowRunContext = options.runContext ?? {}
  const allRules = workflowRuleStorage.getRulesForCommand(projectId, command)
  const phased = allRules.filter((r) => r.position === phase)
  const projectPath = options.projectPath || process.cwd()

  // Only pay for the context (git diff, tag lookup, branch) when
  // something in this phase actually reads it — conditional rules
  // (when_expr) or gates. Saves ~30ms per invocation on workflows
  // that are pure hooks + steps.
  const needsContext = phased.some((r) => r.whenExpr || r.type === 'gate')
  const whenCtx: WhenContext = needsContext
    ? await buildWhenContext(projectId, projectPath)
    : { branch: '', filesChanged: [], tags: {} }

  const rules = phased.filter((r) => evaluateWhen(r.whenExpr, whenCtx))

  // C8: persist this execution (best-effort, never affects control flow). Only
  // when there are rules to run, so empty before/after calls don't create noise.
  const runId = rules.length > 0 ? startWorkflowRun(projectId, `${phase}:${command}`) : null

  // 1. Gates — blocking. No caching: if the user wants to skip a gate
  // when nothing relevant changed, the gate script itself can short-
  // circuit (e.g. `git diff --quiet src/ || bun test`). Caching was
  // removed in alpha.10 because it silently hid "gate didn't run" and
  // added API surface that didn't earn its weight.
  const gates = rules.filter((r) => r.type === 'gate')
  for (const gate of gates) {
    const label = gate.description || gate.action

    console.log(`\n${chalk.dim(`[gate] ${phase}-${command}: ${gate.action}`)}`)
    try {
      const startTime = Date.now()
      await runRuleAction(gate, projectId, projectPath, whenCtx, result, runCtx)
      const elapsed = Date.now() - startTime
      const timeStr = elapsed > 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`
      console.log(`${chalk.green('✓')} ${chalk.dim(`gate passed (${timeStr})`)}`)
      recordGateEvaluation(projectId, runId, gate.id, true)
    } catch (error) {
      console.log(`${chalk.red('✗')} gate failed: ${label}`)
      result.gatesFailed.push(label)
      result.success = false
      result.output += `Gate failed: ${label}\n${getErrorMessage(error)}\n`
      recordGateEvaluation(projectId, runId, gate.id, false, getErrorMessage(error))
      finishWorkflowRun(projectId, runId, 'blocked')
      return result
    }
  }

  // 2. Instructions — non-blocking, no shell.
  const instructions = rules.filter((r) => r.type === 'instruction')
  for (const instr of instructions) {
    const label = instr.description || instr.action
    console.log(`\n${chalk.dim(`[instruction] ${phase}-${command}: ${label}`)}`)
    result.instructions.push(instr.action)
  }

  // 3. Hooks — non-blocking. Parallel by default (via Promise.all); hooks
  //    with `parallel: false` run sequentially ahead of the batch so
  //    order-dependent cleanups still work.
  const hooks = rules.filter((r) => r.type === 'hook')
  const serialHooks = hooks.filter((h) => h.parallel === false)
  const parallelHooks = hooks.filter((h) => h.parallel !== false)

  const runHook = async (hook: WorkflowRule): Promise<void> => {
    console.log(`\n${chalk.dim(`[hook] ${phase}-${command}: ${hook.action}`)}`)
    try {
      const startTime = Date.now()
      await runRuleAction(hook, projectId, projectPath, whenCtx, result, runCtx)
      const elapsed = Date.now() - startTime
      const timeStr = elapsed > 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`
      console.log(`${chalk.green('✓')} ${chalk.dim(`(${timeStr})`)}`)
    } catch (error) {
      console.log(`${chalk.yellow('⚠')} hook failed (non-blocking): ${hook.action}`)
      result.hooksFailed.push(hook.description || hook.action)
      result.output += `Hook failed: ${hook.action}\n${getErrorMessage(error)}\n`
    }
  }

  for (const hook of serialHooks) {
    await runHook(hook)
  }
  if (parallelHooks.length > 0) {
    await Promise.all(parallelHooks.map(runHook))
  }

  // 4. Steps — blocking, sequential. `status:<value>` steps drive the
  //    state machine instead of shelling out.
  const steps = rules.filter((r) => r.type === 'step')
  for (const [stepSeq, step] of steps.entries()) {
    console.log(`\n${chalk.dim(`[step] ${command}: ${step.action}`)}`)
    try {
      const startTime = Date.now()
      await runRuleAction(step, projectId, projectPath, whenCtx, result, runCtx)
      const elapsed = Date.now() - startTime
      const timeStr = elapsed > 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`
      console.log(`${chalk.green('✓')} ${chalk.dim(`step passed (${timeStr})`)}`)
      result.stepsRun.push(step.description || step.action)
      recordRunStep(projectId, runId, step.id, stepSeq, 'ok')
    } catch (error) {
      console.log(`${chalk.red('✗')} step failed: ${step.action}`)
      result.gatesFailed.push(step.description || step.action)
      result.success = false
      result.output += `Step failed: ${step.action}\n${getErrorMessage(error)}\n`
      recordRunStep(projectId, runId, step.id, stepSeq, 'failed', getErrorMessage(error))
      finishWorkflowRun(projectId, runId, 'failed')
      return result
    }
  }

  finishWorkflowRun(projectId, runId, 'passed')
  return result
}
