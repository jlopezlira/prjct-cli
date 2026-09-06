/**
 * `prjct ab` — live with/without-harness A/B, per model and task class.
 *
 * The harness's own release evidence: it does not assert it helps, it measures
 * it. `run` sweeps the versioned corpus (evals/ab/tasks) through the model
 * under test in both arms; `import` folds an existing results.jsonl (e.g. the
 * fable-5.1 corpus) into `.prjct/evaluations/paired-outcomes.json`; `report`
 * renders the table + provisional Δ that `prjct harness score` also surfaces.
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  abEnvironment,
  assertAbHarnessObserved,
  prepareAbEnvironment,
} from '../eval/ab-environment'
import { type AbRow, parseResultsJsonl, renderAbMd, toOutcomeRuns } from '../eval/ab-report'
import { type AbRunnerDeps, type RunContext, runAb } from '../eval/ab-runner'
import { type AbTask, findPackageRoot, loadTasks, loadTasksById } from '../eval/ab-tasks'
import { evaluateLiveOutcome, type OutcomeRun } from '../services/outcome-evidence'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

const run = promisify(execFile)
const PAIRED_OUTCOMES_REL = ['.prjct', 'evaluations', 'paired-outcomes.json']

/**
 * Spawn with stdin CLOSED (the runner contract: a headless `claude -p` must
 * never wait on a pipe), collect stdout/stderr, honour a wall-clock budget.
 */
function spawnCollect(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', () => undefined)
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(out).toString('utf-8'), code: -1 })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(out).toString('utf-8'), code: code ?? -1 })
    })
  })
}

interface AbOptions {
  md?: boolean
  models?: string
  tasks?: string
  reps?: string | number
  out?: string
  grader?: string
  'budget-usd'?: string | number
}

function pairedOutcomesPath(projectPath: string): string {
  return path.join(projectPath, ...PAIRED_OUTCOMES_REL)
}

/** Merge new runs into the store, de-duped by (model, task, arm, rep, head). */
function mergeRuns(existing: OutcomeRun[], incoming: OutcomeRun[]): OutcomeRun[] {
  const keyOf = (r: OutcomeRun) =>
    `${r.model}|${r.taskId}|${r.arm}|${r.repetition}|${r.configurationHash}`
  const merged = new Map(existing.map((r) => [keyOf(r), r]))
  for (const r of incoming) merged.set(keyOf(r), r)
  return [...merged.values()]
}

async function readExisting(file: string): Promise<OutcomeRun[]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf-8'))
    return Array.isArray(parsed) ? (parsed as OutcomeRun[]) : []
  } catch {
    return []
  }
}

async function writePairedOutcomes(projectPath: string, runs: OutcomeRun[]): Promise<string> {
  const file = pairedOutcomesPath(projectPath)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, `${JSON.stringify(runs, null, 2)}\n`)
  return file
}

function liveSummaryMd(runs: OutcomeRun[]): string {
  const live = evaluateLiveOutcome(runs)
  const lines = [`### Live outcome: ${live.status}`, '', live.summary, '']
  if (live.byClass.length) {
    lines.push('| class | pairs | baseline acc | harness acc | Δ acc | Δ tokens | Δ latency ms |')
    lines.push('|---|---:|---:|---:|---:|---:|---:|')
    for (const s of live.byClass) {
      lines.push(
        `| ${s.key} | ${s.pairs} | ${s.baselineAccuracy.toFixed(2)} | ${s.harnessAccuracy.toFixed(2)} | ${s.deltaAccuracy >= 0 ? '+' : ''}${s.deltaAccuracy.toFixed(2)} | ${s.deltaTokens >= 0 ? '+' : ''}${s.deltaTokens.toFixed(0)} | ${s.deltaLatencyMs >= 0 ? '+' : ''}${s.deltaLatencyMs.toFixed(0)} |`
      )
    }
    lines.push('')
  }
  lines.push(`_Grader disagreements: ${live.disagreements}._`)
  return lines.join('\n')
}

/** Real side effects for a live sweep. `with` copies a home template (env
 *  PRJCT_AB_HOME_TEMPLATE) and seeds the task's memories; `without` empties the
 *  home, removes `.prjct`, and shims `prjct` out of PATH. */
function defaultDeps(
  repo: string,
  outDir: string,
  graderModel: string,
  resultsFile: string
): AbRunnerDeps {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-ab-'))
  const template = process.env.PRJCT_AB_HOME_TEMPLATE
  const packageRoot = findPackageRoot(__dirname)
  const entry = packageRoot ? path.join(packageRoot, 'dist', 'bin', 'prjct.mjs') : ''
  if (!fs.existsSync(entry)) throw new Error('ab: build prjct before running the live evaluation')
  const cliArgs = [
    ...(path.basename(process.execPath).includes('bun') ? [] : ['--experimental-sqlite']),
    entry,
  ]
  return {
    async head() {
      const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: repo })
      return stdout.trim()
    },
    async setup(ctx) {
      const id = `${ctx.model}-${ctx.task.id}-${ctx.arm}-r${ctx.rep}`
      const worktree = path.join(workRoot, 'wt', id)
      const home = path.join(workRoot, 'home', id)
      await fsp.mkdir(path.dirname(worktree), { recursive: true })
      await run('git', ['worktree', 'add', '-q', '--detach', worktree, ctx.head], { cwd: repo })
      if (ctx.arm === 'with' && template) {
        await fsp.cp(template, home, { recursive: true })
      } else {
        await fsp.mkdir(home, { recursive: true })
        if (ctx.arm === 'without') {
          await fsp.rm(path.join(worktree, '.prjct'), { recursive: true, force: true })
        }
      }
      try {
        const environment = await prepareAbEnvironment({ worktree, home, arm: ctx.arm }, [
          process.execPath,
          ...cliArgs,
        ])
        // Seed the harness arm's memory with the task's declared entries so a
        // PROJECT_KNOWLEDGE task measures recall of knowledge that IS recorded,
        // not the accident of what a template happened to hold.
        if (ctx.arm === 'with' && ctx.task.seed?.length) {
          for (const seed of ctx.task.seed) {
            const tagArg = seed.tags
              ? Object.entries(seed.tags)
                  .map(([k, v]) => `${k}:${v}`)
                  .join(',')
              : ''
            const args = [
              'remember',
              seed.type,
              seed.content,
              ...(tagArg ? ['--tags', tagArg] : []),
            ]
            const res = await spawnCollect(process.execPath, [...cliArgs, ...args], {
              cwd: worktree,
              env: environment,
              timeoutMs: 60_000,
            })
            // A cell whose seed did not land is NOT a "harness with memory"
            // sample; fail the setup so the sweep stops instead of scoring it.
            if (res.code !== 0) {
              throw new Error(
                `ab: seed failed for ${ctx.task.id} (${seed.type}): exit ${res.code} — the with-arm would be measured without its recorded knowledge`
              )
            }
          }
        }
      } catch (error) {
        // setup runs before runCell's try/finally, so it owns its own cleanup:
        // never leave a registered worktree behind in the user's repo.
        await run('git', ['worktree', 'remove', '--force', worktree], { cwd: repo }).catch(
          () => undefined
        )
        await fsp.rm(home, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      return { worktree, home }
    },
    async runAgent(ctx, prompt, budgetUsd) {
      const shimDir = path.join(workRoot, 'shim')
      const args = [
        '-p',
        prompt,
        '--model',
        ctx.model,
        '--output-format',
        'stream-json',
        '--verbose',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--settings',
        path.join(ctx.home, 'claude-settings.json'),
        '--tools',
        'Read,Grep,Glob',
        '--allowedTools',
        'Read,Grep,Glob',
        '--max-budget-usd',
        String(budgetUsd),
      ]
      if (ctx.arm === 'without') {
        await fsp.mkdir(shimDir, { recursive: true })
        const shim = path.join(shimDir, 'prjct')
        await fsp.writeFile(shim, '#!/bin/sh\necho "prjct: command not found" >&2\nexit 127\n', {
          mode: 0o755,
        })
      }
      const env = abEnvironment(ctx)
      if (ctx.arm === 'without') env.PATH = `${shimDir}:${process.env.PATH ?? ''}`
      const started = Date.now()
      const result = await spawnCollect('claude', args, {
        cwd: ctx.worktree,
        env,
        timeoutMs: 1_200_000,
      })
      if (ctx.arm === 'with') await assertAbHarnessObserved(ctx.home)
      return { stdout: result.stdout, wallMs: Date.now() - started, rc: result.code }
    },
    async runGrader(prompt, jsonSchema) {
      const { stdout } = await spawnCollect(
        'claude',
        [
          '-p',
          prompt,
          '--model',
          graderModel,
          '--output-format',
          'json',
          '--strict-mcp-config',
          '--setting-sources',
          'project,local',
          '--json-schema',
          jsonSchema,
          '--max-budget-usd',
          '0.5',
        ],
        { cwd: repo, env: process.env, timeoutMs: 300_000 }
      )
      return stdout
    },
    async teardown(ctx: RunContext) {
      await run('git', ['worktree', 'remove', '--force', ctx.worktree], { cwd: repo }).catch(
        () => undefined
      )
      await fsp.rm(ctx.home, { recursive: true, force: true }).catch(() => undefined)
    },
    async writeRow(row: AbRow) {
      await fsp.mkdir(outDir, { recursive: true })
      await fsp.appendFile(resultsFile, `${JSON.stringify(row)}\n`)
    },
  }
}

export class AbCommands extends PrjctCommandsBase {
  async ab(
    sub: string | null = null,
    projectPath: string = process.cwd(),
    options: AbOptions = {}
  ): Promise<CommandResult> {
    const md = options.md === true
    const action = (sub ?? 'report').trim()
    try {
      if (action === 'import') return await this.import(projectPath, options, md)
      if (action === 'report') return await this.report(projectPath, options, md)
      if (action === 'run') return await this.run(projectPath, options, md)
      out.info('Usage: prjct ab <run|report|import> [--models h,s] [--tasks ...] [--reps N]')
      return { success: false, error: `Unknown ab action '${action}'` }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  }

  private async import(
    projectPath: string,
    options: AbOptions,
    md: boolean
  ): Promise<CommandResult> {
    const src = options.out ? String(options.out) : options.tasks ? String(options.tasks) : null
    // Accept the source path as the first positional via --out or a bare path arg.
    const source = src && fs.existsSync(src) ? src : null
    if (!source) {
      out.info('Usage: prjct ab import <results.jsonl> (or --out <path>)')
      return { success: false, error: 'results.jsonl path required' }
    }
    const rows = parseResultsJsonl(await fsp.readFile(source, 'utf-8'))
    const tasks = loadTasks()
    const runs = toOutcomeRuns(rows, tasks)
    const existing = await readExisting(pairedOutcomesPath(projectPath))
    const merged = mergeRuns(existing, runs)
    const file = await writePairedOutcomes(projectPath, merged)
    const body = `${renderAbMd(rows, tasks)}\n\n${liveSummaryMd(merged)}\n\n_Wrote ${runs.length} runs → ${path.relative(projectPath, file)} (${merged.length} total)._`
    if (md) console.log(body)
    else out.done(`Imported ${runs.length} runs into ${path.relative(projectPath, file)}`)
    return { success: true, message: body }
  }

  private async report(
    projectPath: string,
    options: AbOptions,
    md: boolean
  ): Promise<CommandResult> {
    const source = options.out ? String(options.out) : pairedOutcomesPath(projectPath)
    const tasks = loadTasks()
    // Report reads either a paired-outcomes.json (OutcomeRun[]) or a raw jsonl.
    const runs = source.endsWith('.json')
      ? await readExisting(source)
      : toOutcomeRuns(parseResultsJsonl(await fsp.readFile(source, 'utf-8')), tasks)
    if (!runs.length) {
      out.info('No A/B runs yet. Run `prjct ab run` or `prjct ab import <results.jsonl>`.')
      return { success: false, error: 'no runs' }
    }
    const body = liveSummaryMd(runs)
    if (md) console.log(body)
    else out.info(body)
    return { success: true, message: body }
  }

  private async run(projectPath: string, options: AbOptions, md: boolean): Promise<CommandResult> {
    const models = String(options.models ?? 'haiku')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    const taskIds = options.tasks
      ? String(options.tasks)
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : []
    const tasks: AbTask[] = taskIds.length ? loadTasksById(taskIds) : loadTasks()
    if (!tasks.length) return { success: false, error: 'no tasks matched' }
    const reps = Math.max(1, Number(options.reps ?? 3) || 3)
    const graderModel = String(options.grader ?? 'sonnet')
    const outDir = options.out ? String(options.out) : path.join(projectPath, 'evals', 'ab', 'out')
    const resultsFile = path.join(outDir, 'results.jsonl')
    const cap = options['budget-usd'] !== undefined ? Number(options['budget-usd']) : undefined

    out.info(
      `Running A/B: models=${models.join(',')} tasks=${tasks.map((t) => t.id).join(',')} reps=${reps} (this spawns \`claude\` and costs API budget)`
    )
    const deps = defaultDeps(projectPath, outDir, graderModel, resultsFile)
    const rows = await runAb(
      {
        models,
        tasks,
        reps,
        graderModel,
        budgetUsd: cap !== undefined ? () => cap : undefined,
      },
      deps
    )
    const allRuns = toOutcomeRuns(rows, tasks)
    const existing = await readExisting(pairedOutcomesPath(projectPath))
    const merged = mergeRuns(existing, allRuns)
    await writePairedOutcomes(projectPath, merged)
    const body = `${renderAbMd(rows, tasks)}\n\n${liveSummaryMd(merged)}`
    if (md) console.log(body)
    else out.done(`A/B complete: ${rows.length} runs`)
    return { success: true, message: body }
  }
}
