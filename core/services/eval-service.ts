/**
 * Product eval harness.
 *
 * This is deliberately deterministic by default: every run yields structured
 * metrics, actionables, and files that can be compared between versions or
 * published to the prjct cloud API without invoking an LLM.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveCliHome } from '../infrastructure/cli-home'
import configManager from '../infrastructure/config-manager'
import type { EvalActionable, EvalComparison, EvalRun, EvalScenario } from '../schemas/eval'
import { EvalComparisonSchema, EvalRunSchema } from '../schemas/eval'
import authConfig from '../sync/auth-config'
import syncClient from '../sync/sync-client'
import type { BenchmarkPublishPayload, SyncClientError } from '../types/sync'
import { execFileAsync } from '../utils/exec'
import { getVersion } from '../utils/version'

export interface EvalRunOptions {
  baseline?: string
  candidate?: string
  source?: 'local' | 'ci' | 'agent'
}

export interface EvalCompareOptions {
  baseline?: string
  candidate?: string
}

export interface EvalPublishOptions {
  target?: string
  file?: string
  dryRun?: boolean
}

export interface EvalPublishResult {
  target: 'cloud'
  dryRun: boolean
  artifactType: 'run' | 'comparison'
  artifactId: string
  runId?: string
  comparisonId?: string
  projectId: string
  repo: string
  endpoint: string
  payloadBytes: number
  remoteId?: string
  publishedAt?: string
  url?: string
}

interface GitInfo {
  repo: string
  ownerRepo?: string
  branch?: string
  commit?: string
  dirty: boolean
}

interface ScenarioContext {
  projectPath: string
  git: GitInfo
}

const EVAL_SCHEMA_VERSION = 1
const SCORE_REGRESSION_THRESHOLD = -5
const SCORE_IMPROVEMENT_THRESHOLD = 5

export async function runEval(projectPath: string, options: EvalRunOptions = {}): Promise<EvalRun> {
  const createdAt = new Date().toISOString()
  const git = await detectGit(projectPath)
  const context: ScenarioContext = { projectPath, git }
  const scenarios = await runScenarios(context)
  const summary = summarizeScenarios(scenarios)
  const run: EvalRun = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    runId: runId(createdAt),
    createdAt,
    runner: {
      source: options.source ?? detectSource(),
      user: await detectRunnerUser(projectPath),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      bun: await detectBunVersion(),
    },
    project: {
      repo: git.repo,
      branch: git.branch,
      commit: git.commit,
      dirty: git.dirty,
    },
    versions: {
      current: getVersion(),
      baseline: options.baseline,
      candidate: options.candidate ?? getVersion(),
    },
    scenarios,
    summary,
  }

  return saveEvalRun(run)
}

export async function loadLatestEvalRun(projectPath: string): Promise<EvalRun | null> {
  const latestPath = path.join(evalProjectDir(await detectGit(projectPath)), 'latest.json')
  return readRunFile(latestPath)
}

export async function loadLatestEvalComparison(
  projectPath: string
): Promise<EvalComparison | null> {
  const latestPath = path.join(
    evalProjectDir(await detectGit(projectPath)),
    'latest-comparison.json'
  )
  return readComparisonFile(latestPath)
}

export async function loadEvalRunByVersion(
  projectPath: string,
  version: string | undefined
): Promise<EvalRun | null> {
  if (!version) return loadLatestEvalRun(projectPath)
  const dir = path.join(evalProjectDir(await detectGit(projectPath)), 'runs')
  const entries = await fs.readdir(dir).catch(() => null)
  if (!entries) return null

  const runs = (
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => readRunFile(path.join(dir, entry)))
    )
  ).filter((run): run is EvalRun => Boolean(run))

  return (
    runs
      .filter((run) => run.versions.current === version || run.versions.candidate === version)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  )
}

export async function compareEvalRuns(
  projectPath: string,
  options: EvalCompareOptions = {}
): Promise<EvalComparison> {
  const baseline = await loadEvalRunByVersion(projectPath, options.baseline)
  const candidate = options.candidate
    ? await loadEvalRunByVersion(projectPath, options.candidate)
    : await loadLatestEvalRun(projectPath)

  const scenarioIds = new Set<string>([
    ...(baseline?.scenarios.map((scenario) => scenario.id) ?? []),
    ...(candidate?.scenarios.map((scenario) => scenario.id) ?? []),
  ])

  const scenarios = [...scenarioIds].sort().map((id) => {
    const b = baseline?.scenarios.find((scenario) => scenario.id === id)
    const c = candidate?.scenarios.find((scenario) => scenario.id === id)
    const delta = b && c ? Math.round((c.score - b.score) * 10) / 10 : undefined
    const actionables: EvalActionable[] = []
    const status: EvalComparison['scenarios'][number]['status'] = !b
      ? 'missing-baseline'
      : !c
        ? 'missing-candidate'
        : (delta ?? 0) <= SCORE_REGRESSION_THRESHOLD
          ? 'regressed'
          : (delta ?? 0) >= SCORE_IMPROVEMENT_THRESHOLD
            ? 'improved'
            : 'unchanged'

    if (!b) {
      actionables.push({
        severity: 'warning',
        title: `No baseline result for ${id}`,
        recommendation:
          'Run `prjct eval run --candidate <baseline-version>` before comparing releases.',
      })
    } else if (!c) {
      actionables.push({
        severity: 'blocking',
        title: `No candidate result for ${id}`,
        recommendation:
          'Run `prjct eval run` for the candidate version before publishing a comparison.',
      })
    } else if ((delta ?? 0) <= SCORE_REGRESSION_THRESHOLD) {
      actionables.push({
        severity: 'blocking',
        title: `${id} regressed by ${Math.abs(delta ?? 0)} points`,
        recommendation: regressionRecommendation(id),
      })
    } else if ((delta ?? 0) >= SCORE_IMPROVEMENT_THRESHOLD) {
      actionables.push({
        severity: 'info',
        title: `${id} improved by ${delta} points`,
        recommendation: 'Keep this scenario in PR checks so the improvement is protected.',
      })
    } else if (b && c) {
      actionables.push({
        severity: 'info',
        title: `${id} stayed within the regression threshold`,
        recommendation:
          'Keep collecting this scenario so future optimizations have a stable baseline.',
      })
    }

    return {
      id,
      baselineScore: b?.score,
      candidateScore: c?.score,
      delta,
      status,
      actionables,
    }
  })

  const regressions = scenarios.filter((scenario) => scenario.status === 'regressed').length
  const improvements = scenarios.filter((scenario) => scenario.status === 'improved').length
  const createdAt = new Date().toISOString()
  const baselineVersion =
    baseline?.versions.candidate ?? baseline?.versions.current ?? options.baseline
  const candidateVersion =
    candidate?.versions.candidate ?? candidate?.versions.current ?? options.candidate
  const comparison: EvalComparison = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    comparisonId: comparisonId(createdAt, baselineVersion, candidateVersion),
    createdAt,
    baselineRunId: baseline?.runId,
    candidateRunId: candidate?.runId,
    baselineVersion,
    candidateVersion,
    summary: {
      baselineScore: baseline?.summary.score,
      candidateScore: candidate?.summary.score,
      delta:
        baseline && candidate
          ? Math.round((candidate.summary.score - baseline.summary.score) * 10) / 10
          : undefined,
      regressions,
      improvements,
      actionables: scenarios.reduce((sum, scenario) => sum + scenario.actionables.length, 0),
    },
    scenarios,
  }
  return saveEvalComparison(projectPath, comparison)
}

export async function publishEvalRun(
  projectPath: string,
  options: EvalPublishOptions = {}
): Promise<EvalPublishResult> {
  const target = normalizePublishTarget(options.target)
  const run = options.file
    ? await readRequiredRunFile(options.file)
    : await loadLatestRequired(projectPath)
  const project = await resolveBenchmarkProject(projectPath, options.dryRun === true)
  const payload: BenchmarkPublishPayload = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    artifactType: 'run',
    artifactId: run.runId,
    repo: run.project.repo,
    createdAt: run.createdAt,
    run,
    reportMarkdown: formatEvalRunMarkdown(run),
  }

  return publishBenchmarkPayload(project.projectId, target, options.dryRun === true, payload, {
    artifactType: 'run',
    artifactId: run.runId,
    runId: run.runId,
  })
}

export async function publishEvalComparison(
  projectPath: string,
  comparison: EvalComparison,
  options: EvalPublishOptions = {}
): Promise<EvalPublishResult> {
  const target = normalizePublishTarget(options.target)
  const project = await resolveBenchmarkProject(projectPath, options.dryRun === true)
  const git = await detectGit(projectPath)
  const payload: BenchmarkPublishPayload = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    artifactType: 'comparison',
    artifactId: comparison.comparisonId,
    repo: git.repo,
    createdAt: comparison.createdAt,
    comparison,
    reportMarkdown: formatEvalComparisonMarkdown(comparison),
  }

  return publishBenchmarkPayload(project.projectId, target, options.dryRun === true, payload, {
    artifactType: 'comparison',
    artifactId: comparison.comparisonId,
    comparisonId: comparison.comparisonId,
  })
}

export function formatEvalRunMarkdown(run: EvalRun): string {
  const actionables = run.scenarios.flatMap((scenario) =>
    scenario.actionables.map((actionable) => ({ scenario: scenario.id, actionable }))
  )
  const scenarioRows = run.scenarios
    .map(
      (scenario) =>
        `| \`${scenario.id}\` | ${scenario.status} | ${scenario.score} | ${scenario.actionables.length} |`
    )
    .join('\n')
  const actionableRows =
    actionables.length === 0
      ? '_No actionables._'
      : actionables
          .map(
            ({ scenario, actionable }) =>
              `- **${actionable.severity}** \`${scenario}\`: ${actionable.title}. ${actionable.recommendation}`
          )
          .join('\n')

  return `# prjct eval run

Run: \`${run.runId}\`
Version: \`${run.versions.current}\`
Repo: \`${run.project.repo}\`
Commit: \`${run.project.commit ?? 'unknown'}\`

## Summary

| Metric | Value |
|---|---:|
| Score | ${run.summary.score} |
| Pass | ${run.summary.pass} |
| Warn | ${run.summary.warn} |
| Fail | ${run.summary.fail} |
| Actionables | ${run.summary.actionables} |

## Scenarios

| Scenario | Status | Score | Actionables |
|---|---|---:|---:|
${scenarioRows}

## Actionables

${actionableRows}
`
}

export function formatEvalComparisonMarkdown(comparison: EvalComparison): string {
  const rows = comparison.scenarios
    .map(
      (scenario) =>
        `| \`${scenario.id}\` | ${scenario.status} | ${scenario.baselineScore ?? '-'} | ${scenario.candidateScore ?? '-'} | ${scenario.delta ?? '-'} |`
    )
    .join('\n')
  const actionables = comparison.scenarios.flatMap((scenario) =>
    scenario.actionables.map(
      (actionable) =>
        `- **${actionable.severity}** \`${scenario.id}\`: ${actionable.title}. ${actionable.recommendation}`
    )
  )

  return `# prjct eval comparison

Comparison: \`${comparison.comparisonId}\`
Baseline: \`${comparison.baselineVersion ?? 'missing'}\`
Candidate: \`${comparison.candidateVersion ?? 'missing'}\`

## Summary

| Metric | Value |
|---|---:|
| Baseline score | ${comparison.summary.baselineScore ?? '-'} |
| Candidate score | ${comparison.summary.candidateScore ?? '-'} |
| Delta | ${comparison.summary.delta ?? '-'} |
| Improvements | ${comparison.summary.improvements} |
| Regressions | ${comparison.summary.regressions} |
| Actionables | ${comparison.summary.actionables} |

## Scenarios

| Scenario | Status | Baseline | Candidate | Delta |
|---|---|---:|---:|---:|
${rows || '| _none_ | - | - | - | - |'}

## Actionables

${actionables.length > 0 ? actionables.join('\n') : '_No actionables._'}
`
}

function summarizeScenarios(scenarios: EvalScenario[]): EvalRun['summary'] {
  const score =
    scenarios.length === 0
      ? 0
      : Math.round(scenarios.reduce((sum, scenario) => sum + scenario.score, 0) / scenarios.length)
  return {
    score,
    pass: scenarios.filter((scenario) => scenario.status === 'pass').length,
    warn: scenarios.filter((scenario) => scenario.status === 'warn').length,
    fail: scenarios.filter((scenario) => scenario.status === 'fail').length,
    improvements: 0,
    regressions: scenarios.filter((scenario) => scenario.status === 'fail').length,
    actionables: scenarios.reduce((sum, scenario) => sum + scenario.actionables.length, 0),
  }
}

async function runScenarios(context: ScenarioContext): Promise<EvalScenario[]> {
  return Promise.all([
    scenario('agent-surface-readiness', 'Agent surface readiness', () =>
      evalAgentSurface(context.projectPath)
    ),
    scenario('project-sync-readiness', 'Project sync readiness', () =>
      evalProjectSyncReadiness(context.projectPath)
    ),
    scenario('stale-command-guidance', 'Stale command guidance', () =>
      evalStaleCommandGuidance(context.projectPath)
    ),
    scenario('quality-command-readiness', 'Quality command readiness', () =>
      evalQualityCommandReadiness(context.projectPath)
    ),
    scenario('cloud-benchmark-readiness', 'Cloud benchmark readiness', () =>
      evalCloudBenchmarkReadiness(context.projectPath)
    ),
    scenario('project-facts-freshness', 'Project facts freshness', () =>
      evalProjectFactsFreshness(context.projectPath)
    ),
  ])
}

async function scenario(
  id: string,
  name: string,
  run: () => Promise<Omit<EvalScenario, 'id' | 'name' | 'durationMs'>>
): Promise<EvalScenario> {
  const started = Date.now()
  const result = await run()
  return { id, name, durationMs: Date.now() - started, ...result }
}

async function evalAgentSurface(
  projectPath: string
): Promise<Omit<EvalScenario, 'id' | 'name' | 'durationMs'>> {
  const agents = await exists(path.join(projectPath, 'AGENTS.md'))
  const claude = await exists(path.join(projectPath, 'CLAUDE.md'))
  const score = agents ? 100 : claude ? 70 : 20
  return {
    status: score >= 90 ? 'pass' : 'warn',
    score,
    metrics: { agentsMd: agents, claudeMd: claude },
    actionables:
      score >= 90
        ? [
            {
              severity: 'info',
              title: 'Portable agent surface is present',
              recommendation: 'Keep `prjct agents doctor --fix` in release smoke checks.',
              command: 'prjct agents doctor --fix',
            },
          ]
        : [
            {
              severity: 'warning',
              title: 'Portable AGENTS.md surface is missing',
              recommendation:
                'Run `prjct agents doctor --fix` so future agents start with the same project contract.',
              command: 'prjct agents doctor --fix',
            },
          ],
  }
}

async function evalProjectSyncReadiness(
  projectPath: string
): Promise<Omit<EvalScenario, 'id' | 'name' | 'durationMs'>> {
  const config = await exists(path.join(projectPath, '.prjct', 'prjct.config.json'))
  return {
    status: config ? 'pass' : 'warn',
    score: config ? 100 : 40,
    metrics: { projectConfig: config },
    actionables: [
      config
        ? {
            severity: 'info',
            title: 'Project has a prjct identity',
            recommendation:
              'Use `prjct sync --md` in eval smoke runs to keep generated context measurable.',
            command: 'prjct sync --md',
          }
        : {
            severity: 'warning',
            title: 'Project is not registered with prjct',
            recommendation:
              'Run `prjct sync` before comparing eval runs so metrics map to a stable project id.',
            command: 'prjct sync',
          },
    ],
  }
}

async function evalStaleCommandGuidance(
  projectPath: string
): Promise<Omit<EvalScenario, 'id' | 'name' | 'durationMs'>> {
  const files = await collectTextFiles(projectPath, 250)
  const staleCommandPattern = /\/p:\s*[a-z][a-z0-9-]*/i
  const staleHits: string[] = []
  await Promise.all(
    files.map(async (file) => {
      const text = await fs.readFile(path.join(projectPath, file), 'utf-8').catch(() => '')
      if (staleCommandPattern.test(text)) staleHits.push(file)
    })
  )
  return {
    status: staleHits.length === 0 ? 'pass' : 'warn',
    score: staleHits.length === 0 ? 100 : Math.max(20, 100 - staleHits.length * 10),
    metrics: { scannedFiles: files.length, staleHits: staleHits.length },
    actionables:
      staleHits.length === 0
        ? [
            {
              severity: 'info',
              title: 'No stale `/p:` command guidance found',
              recommendation: 'Keep this scan in evals to prevent user-facing command drift.',
            },
          ]
        : [
            {
              severity: 'warning',
              title: `Found ${staleHits.length} stale command guidance file(s)`,
              recommendation: 'Replace stale `/p:` examples with `p. <verb>` or `prjct <verb>`.',
              files: staleHits.slice(0, 10),
            },
          ],
  }
}

async function evalQualityCommandReadiness(
  projectPath: string
): Promise<Omit<EvalScenario, 'id' | 'name' | 'durationMs'>> {
  const pkgPath = path.join(projectPath, 'package.json')
  const scripts = await (async (): Promise<Record<string, unknown>> => {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as {
        scripts?: Record<string, unknown>
      }
      return pkg.scripts ?? {}
    } catch {
      return {}
    }
  })()
  const hasTest = typeof scripts.test === 'string'
  const hasCheck = typeof scripts.check === 'string' || typeof scripts.lint === 'string'
  const score = (hasTest ? 50 : 0) + (hasCheck ? 50 : 0)
  return {
    status: score >= 100 ? 'pass' : 'warn',
    score,
    metrics: { hasTest, hasCheck },
    actionables:
      score >= 100
        ? [
            {
              severity: 'info',
              title: 'Quality commands are discoverable',
              recommendation:
                'Use these commands as eval scenario gates before publishing results.',
            },
          ]
        : [
            {
              severity: 'warning',
              title: 'Quality commands are incomplete',
              recommendation:
                'Expose `test` and `check`/`lint` scripts so eval reports can tie regressions to real verification.',
              files: ['package.json'],
            },
          ],
  }
}

async function evalCloudBenchmarkReadiness(
  projectPath: string
): Promise<Omit<EvalScenario, 'id' | 'name' | 'durationMs'>> {
  const config = await configManager.readConfig(projectPath)
  const authenticated = await authConfig.hasAuth()
  const hasProject = Boolean(config?.projectId)
  const cloudLinked = Boolean(config?.cloud?.enabled)
  const cloudActive = cloudLinked && !config?.cloud?.paused
  const score = (hasProject ? 34 : 0) + (authenticated ? 33 : 0) + (cloudActive ? 33 : 0)

  return {
    status: score >= 100 ? 'pass' : 'warn',
    score,
    metrics: { hasProject, authenticated, cloudLinked, cloudActive },
    actionables:
      score >= 100
        ? [
            {
              severity: 'info',
              title: 'Cloud benchmark publishing is active',
              recommendation:
                'Run `prjct eval publish --target cloud` after release evals to store shared benchmark history.',
              command: 'prjct eval publish --target cloud',
            },
          ]
        : [
            {
              severity: 'warning',
              title: 'Cloud benchmark publishing is not active',
              recommendation:
                'Run `prjct init`, `prjct login`, and `prjct cloud link` before publishing benchmark results.',
              command: 'prjct cloud status',
            },
          ],
  }
}

/**
 * Manual-only, like every other scenario here — no automatic wiring into
 * sync/install/hooks/daemon/CI. Missing PRJCT.md is a neutral warn (opt-in
 * by design, clean-repo doctrine); when present, staleness can only mean
 * the manifest changed since the last explicit `agents doctor --fix` — no
 * CI-workflow-vs-command validation here, that's a separately-scoped
 * feature (nothing in this codebase reads .github/workflows/*.yml today).
 */
async function evalProjectFactsFreshness(
  projectPath: string
): Promise<Omit<EvalScenario, 'id' | 'name' | 'durationMs'>> {
  const prjctMdPath = path.join(projectPath, 'PRJCT.md')
  const hasPrjctMd = await exists(prjctMdPath)
  if (!hasPrjctMd) {
    return {
      status: 'warn',
      score: 50,
      metrics: { prjctMd: false },
      actionables: [
        {
          severity: 'info',
          title: 'PRJCT.md not opted into yet',
          recommendation:
            'Run `prjct agents doctor --fix` to generate the verified-facts hub (opt-in, clean-repo doctrine).',
          command: 'prjct agents doctor --fix',
        },
      ],
    }
  }

  const { buildPrjctMdBody } = await import('./prjct-md')
  const [onDisk, fresh] = await Promise.all([
    fs.readFile(prjctMdPath, 'utf-8').catch(() => ''),
    buildPrjctMdBody(projectPath),
  ])
  const stale = !onDisk.includes(fresh)

  return {
    status: stale ? 'warn' : 'pass',
    score: stale ? 40 : 100,
    metrics: { prjctMd: true, stale },
    actionables: stale
      ? [
          {
            severity: 'warning',
            title: 'PRJCT.md is stale',
            recommendation:
              'Re-run `prjct agents doctor --fix` to refresh verified commands/stack after a manifest change (package.json / Cargo.toml / go.mod / pyproject.toml).',
            command: 'prjct agents doctor --fix',
          },
        ]
      : [
          {
            severity: 'info',
            title: 'PRJCT.md matches verified project facts',
            recommendation:
              'Keep `prjct agents doctor --fix` in release smoke checks to catch drift early.',
            command: 'prjct agents doctor --fix',
          },
        ],
  }
}

async function saveEvalRun(run: EvalRun): Promise<EvalRun> {
  const projectDir = evalProjectDir({ repo: run.project.repo })
  const runsDir = path.join(projectDir, 'runs')
  await fs.mkdir(runsDir, { recursive: true })
  const jsonPath = path.join(runsDir, `${run.runId}.json`)
  const reportPath = path.join(runsDir, `${run.runId}.md`)
  const withArtifacts: EvalRun = {
    ...run,
    artifacts: { jsonPath, reportPath },
  }
  EvalRunSchema.parse(withArtifacts)
  await fs.writeFile(jsonPath, `${JSON.stringify(withArtifacts, null, 2)}\n`, 'utf-8')
  await fs.writeFile(reportPath, formatEvalRunMarkdown(withArtifacts), 'utf-8')
  await fs.writeFile(
    path.join(projectDir, 'latest.json'),
    `${JSON.stringify(withArtifacts, null, 2)}\n`,
    'utf-8'
  )
  return withArtifacts
}

async function saveEvalComparison(
  projectPath: string,
  comparison: EvalComparison
): Promise<EvalComparison> {
  const projectDir = evalProjectDir(await detectGit(projectPath))
  const comparisonsDir = path.join(projectDir, 'comparisons')
  await fs.mkdir(comparisonsDir, { recursive: true })
  const jsonPath = path.join(comparisonsDir, `${comparison.comparisonId}.json`)
  const reportPath = path.join(comparisonsDir, `${comparison.comparisonId}.md`)
  const withArtifacts: EvalComparison = {
    ...comparison,
    artifacts: { jsonPath, reportPath },
  }
  EvalComparisonSchema.parse(withArtifacts)
  await fs.writeFile(jsonPath, `${JSON.stringify(withArtifacts, null, 2)}\n`, 'utf-8')
  await fs.writeFile(reportPath, formatEvalComparisonMarkdown(withArtifacts), 'utf-8')
  await fs.writeFile(
    path.join(projectDir, 'latest-comparison.json'),
    `${JSON.stringify(withArtifacts, null, 2)}\n`,
    'utf-8'
  )
  return withArtifacts
}

function evalProjectDir(git: Pick<GitInfo, 'repo'>): string {
  const slug = git.repo.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
  return path.join(resolveCliHome(), 'evals', slug)
}

async function readRunFile(filePath: string): Promise<EvalRun | null> {
  try {
    return EvalRunSchema.parse(JSON.parse(await fs.readFile(filePath, 'utf-8')))
  } catch {
    return null
  }
}

async function readComparisonFile(filePath: string): Promise<EvalComparison | null> {
  try {
    return EvalComparisonSchema.parse(JSON.parse(await fs.readFile(filePath, 'utf-8')))
  } catch {
    return null
  }
}

async function readRequiredRunFile(filePath: string): Promise<EvalRun> {
  const run = await readRunFile(filePath)
  if (!run) throw new Error(`Invalid or missing eval run file: ${filePath}`)
  return run
}

async function loadLatestRequired(projectPath: string): Promise<EvalRun> {
  const latest = await loadLatestEvalRun(projectPath)
  if (!latest) throw new Error('No eval run found. Run `prjct eval run` first.')
  return latest
}

async function detectGit(projectPath: string): Promise<GitInfo> {
  const [branch, commit, remote, status] = await Promise.all([
    git(projectPath, ['branch', '--show-current']),
    git(projectPath, ['rev-parse', 'HEAD']),
    git(projectPath, ['config', '--get', 'remote.origin.url']),
    git(projectPath, ['status', '--porcelain']),
  ])
  const ownerRepo = parseGitHubOwnerRepo(remote)
  return {
    repo: ownerRepo ?? hashedRepo(projectPath),
    ownerRepo,
    branch: branch || undefined,
    commit: commit || undefined,
    dirty: status.trim().length > 0,
  }
}

async function git(projectPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: projectPath })
    return String(stdout).trim()
  } catch {
    return ''
  }
}

function parseGitHubOwnerRepo(remote: string): string | undefined {
  const trimmed = remote.trim()
  const https = trimmed.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/)
  if (!https) return undefined
  return `${https[1]}/${https[2]}`
}

function hashedRepo(projectPath: string): string {
  return `local-${crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 12)}`
}

function runId(createdAt: string): string {
  const stamp = createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)
  return `eval_${stamp}_${crypto.randomBytes(4).toString('hex')}`
}

function comparisonId(
  createdAt: string,
  baselineVersion: string | undefined,
  candidateVersion: string | undefined
): string {
  const stamp = createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)
  const baseline = slugPart(baselineVersion ?? 'missing-baseline')
  const candidate = slugPart(candidateVersion ?? 'missing-candidate')
  return `comparison_${stamp}_${baseline}_to_${candidate}`
}

function slugPart(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'unknown'
  )
}

function detectSource(): 'local' | 'ci' | 'agent' {
  if (process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true') return 'ci'
  if (process.env.CODEX_SANDBOX || process.env.CLAUDECODE) return 'agent'
  return 'local'
}

async function detectRunnerUser(projectPath: string): Promise<string | undefined> {
  const gh = await execFileMaybe('gh', ['api', 'user', '--jq', '.login'], projectPath)
  if (gh) return `github:${gh}`
  const email = await git(projectPath, ['config', 'user.email'])
  return email ? `git:${email}` : undefined
}

async function detectBunVersion(): Promise<string | undefined> {
  return execFileMaybe('bun', ['--version'], process.cwd())
}

async function execFileMaybe(
  cmd: string,
  args: string[],
  cwd: string
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd })
    const value = String(stdout).trim()
    return value || undefined
  } catch {
    return undefined
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function collectTextFiles(projectPath: string, maxFiles: number): Promise<string[]> {
  const result: string[] = []
  const skip = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.prjct',
    '__tests__',
    '__fixtures__',
    'fixtures',
  ])

  async function walk(dir: string): Promise<void> {
    if (result.length >= maxFiles) return
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (result.length >= maxFiles) break
      if (skip.has(entry.name)) continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(fullPath)
      else if (
        entry.isFile() &&
        !entry.name.includes('.test.') &&
        !entry.name.includes('.spec.') &&
        /\.(md|mdc|txt|toml|json|ya?ml|sh|ts|tsx|js|jsx)$/.test(entry.name)
      ) {
        result.push(path.relative(projectPath, fullPath))
      }
    }
  }

  await walk(projectPath)
  return result
}

function regressionRecommendation(id: string): string {
  if (id.includes('sync'))
    return 'Inspect sync incrementality and generated context freshness before shipping.'
  if (id.includes('cloud')) return 'Check cloud auth/link status and benchmark publisher setup.'
  if (id.includes('command'))
    return 'Audit user-facing command copy and generated templates for stale instructions.'
  return 'Open the latest eval report, inspect scenario metrics, and add a focused regression test.'
}

function normalizePublishTarget(target: string | undefined): 'cloud' {
  const normalized = target ?? 'cloud'
  if (normalized === 'github') {
    throw new Error(
      'GitHub eval publishing was removed. Use `prjct eval publish --target cloud` after `prjct login` and `prjct cloud link`.'
    )
  }
  if (normalized !== 'cloud') {
    throw new Error(`Unsupported eval publish target: ${normalized}. Use --target cloud.`)
  }
  return 'cloud'
}

async function resolveBenchmarkProject(
  projectPath: string,
  dryRun: boolean
): Promise<{ projectId: string }> {
  const config = await configManager.readConfig(projectPath)
  if (!config?.projectId) {
    throw new Error('Cloud benchmark publish requires a prjct project. Run `prjct init` first.')
  }

  if (dryRun) return { projectId: config.projectId }

  if (!(await authConfig.hasAuth())) {
    throw new Error(
      'Cloud benchmark publish requires authentication. Run `prjct login`, then `prjct cloud link`.'
    )
  }
  if (!config.cloud?.enabled) {
    throw new Error('Cloud benchmark publish requires cloud to be active. Run `prjct cloud link`.')
  }
  if (config.cloud.paused) {
    throw new Error('Cloud sync is paused. Run `prjct cloud resume` before publishing benchmarks.')
  }

  return { projectId: config.projectId }
}

async function publishBenchmarkPayload(
  projectId: string,
  target: 'cloud',
  dryRun: boolean,
  payload: BenchmarkPublishPayload,
  artifact: Pick<EvalPublishResult, 'artifactType' | 'artifactId' | 'runId' | 'comparisonId'>
): Promise<EvalPublishResult> {
  const apiUrl = await authConfig.getApiUrl()
  const endpoint = `${apiUrl}/benchmarks/evals`
  const body = { projectId, ...payload }
  const payloadBytes = Buffer.byteLength(JSON.stringify(body), 'utf-8')

  if (dryRun) {
    return {
      target,
      dryRun,
      ...artifact,
      projectId,
      repo: payload.repo,
      endpoint,
      payloadBytes,
    }
  }

  try {
    const result = await syncClient.publishBenchmark(projectId, payload)
    return {
      target,
      dryRun,
      ...artifact,
      projectId,
      repo: payload.repo,
      endpoint,
      payloadBytes,
      remoteId: result.benchmarkId,
      publishedAt: result.publishedAt ?? new Date().toISOString(),
      url: result.url,
    }
  } catch (error) {
    throw new Error(cloudPublishErrorMessage(error))
  }
}

function cloudPublishErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const syncError = error as SyncClientError
    if (syncError.code === 'PAYMENT_REQUIRED') {
      return `${syncError.message} Run \`prjct cloud status\` for account details.`
    }
    return syncError.message
  }
  return 'Cloud benchmark publish failed.'
}
