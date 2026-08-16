import type {
  CurrentTask,
  HarnessEvidence,
  HarnessGate,
  HarnessKind,
  HarnessLevel,
  HarnessRisk,
  TaskHarness,
} from '../schemas/state'
import { getTimestamp } from '../utils/date-helper'
import { GitInfraError, runGit, throwProc } from '../utils/exec'

const PUBLIC_SURFACE_TERMS = [
  'cli',
  'command',
  'install',
  'setup',
  'doctor',
  'mcp',
  'codex',
  'claude',
  'statusline',
  'statusbar',
  'output',
  'help',
]

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'task',
  'implement',
  'implementa',
  'fix',
  'bug',
  'add',
  'agrega',
  'crear',
  'hacer',
  'esto',
  'debe',
])

export interface HarnessCompletionEvaluation {
  changedFiles: string[]
  observedEvidence: string[]
  warnings: string[]
  /** Changed-line count of the completion diff (estimation-loop input). */
  diffSize: number
}

export function buildTaskHarness(description: string): TaskHarness {
  const text = description.toLowerCase()
  const kind = detectKind(text)
  const publicSurface = PUBLIC_SURFACE_TERMS.some((term) => text.includes(term))
  const highRisk = hasAny(text, [
    'security',
    'seguridad',
    'auth',
    'permission',
    'secret',
    'migration',
    'sqlite',
    'database',
    'arquitectura',
    'architecture',
    'must',
    'critical',
    'critico',
    'crítico',
  ])

  const level = detectLevel(kind, text, highRisk)
  const risk = detectRisk(level, highRisk)
  const expectedEvidence = expectedEvidenceFor(kind, level, publicSurface)
  const gates = gatesFor(level)
  const scopeHints = extractScopeHints(description)

  return {
    level,
    kind,
    risk,
    expectedEvidence,
    scopeHints,
    gates,
    rationale: rationaleFor(level, kind, risk),
    createdAt: getTimestamp(),
  }
}

export async function evaluateHarnessCompletion(
  projectPath: string,
  task: CurrentTask
): Promise<HarnessCompletionEvaluation> {
  const harness = task.harness
  if (!harness || harness.level === 'H0') {
    return { changedFiles: [], observedEvidence: [], warnings: [], diffSize: 0 }
  }

  // Evidence is advisory. A typed git EXIT is a valid answer ("no diff");
  // a git INFRA failure (timeout/spawn) must not fabricate "0 files / no
  // tests changed" — it surfaces as its own warning instead.
  const gitEvidence = await Promise.all([readChangedFiles(projectPath), readDiffSize(projectPath)])
    .then(([changedFiles, diffSize]) => ({ changedFiles, diffSize, gitUnavailable: null }))
    .catch((error) => {
      if (error instanceof GitInfraError) {
        return { changedFiles: [], diffSize: 0, gitUnavailable: error }
      }
      throw error
    })
  const { changedFiles, diffSize, gitUnavailable } = gitEvidence

  const observedEvidence = observedEvidenceFromFiles(changedFiles)
  const warnings: string[] = []

  if (gitUnavailable) {
    warnings.push(
      `git ${gitUnavailable.kind}: change evidence unavailable — completion checks skipped, not failed.`
    )
    return { changedFiles, observedEvidence, warnings, diffSize }
  }

  if (
    harness.expectedEvidence.includes('regression-test') &&
    !observedEvidence.includes('tests-changed')
  ) {
    warnings.push(`${harness.level} expects a regression test; no test file changed in the diff.`)
  }

  if (
    harness.expectedEvidence.includes('docs-if-public-behavior') &&
    touchesPublicSurface(changedFiles) &&
    !observedEvidence.includes('docs-changed')
  ) {
    warnings.push('Public-facing files changed; no README/docs/changelog file changed.')
  }

  if (diffSize > 400) {
    warnings.push(`Diff is ${diffSize} changed lines; consider splitting or justify the scope.`)
  }

  return { changedFiles, observedEvidence, warnings, diffSize }
}

function detectKind(text: string): HarnessKind {
  // Short ambiguous stems appear with their word families spelled out because
  // hasAny only prefix-matches terms >=5 chars: bare `doc` used to substring-
  // match "docker" (→ docs → H0 → cheap-model directive on a real code task),
  // `auth` matched "author" (→ security → H3), `bug` matched "debug".
  if (
    hasAny(text, ['security', 'seguridad', 'auth', 'authent', 'authoriz', 'permission', 'secret'])
  ) {
    return 'security'
  }
  if (
    hasAny(text, [
      'bug',
      'bugs',
      'fix',
      'fixes',
      'fixed',
      'fixing',
      'falla',
      'fallo',
      'error',
      'broken',
      'regression',
      'no se',
    ])
  ) {
    return 'bug'
  }
  // Research/investigation BEFORE feature: "analiza/investiga/compara X" is
  // read-only sweep work — the meta-finding from the 2026-07 harness research
  // was our own triage classifying a 3-way competitive investigation as
  // "do it yourself — no subagents".
  //
  // "revisa/review" was missing from this list — a live case ("revisa qué
  // otras mejoras... podemos hacer") fell through past this check (no match)
  // and hit 'mejora' in the feature branch below → H2 → discuss-lock fired
  // on a pure research ask, forcing the full intent→audit-spec ceremony for
  // something with no code diff. Adding the verb alone would cut the other
  // way though: "review" is common enough to appear IN a real code-changing
  // ask ("review and refactor X"), and research is checked before
  // feature/refactor below — so a bare match would let "review" smuggle a
  // code-change task past H2 ceremony (the exact gaming risk the strategic
  // reviewer flagged on this spec). Gate it: research wins only when no
  // code-intent verb rides along in the same text.
  const hasCodeIntent = hasAny(text, [
    'implement',
    'implementa',
    'refactor',
    'restructure',
    'cleanup',
    'crear',
    'agrega',
    'construir',
    'build',
  ])
  if (
    hasAny(text, [
      'research',
      'investiga',
      'investigate',
      'analiza',
      'analyze',
      'analysis',
      'análisis',
      'compare',
      'compara',
      'survey',
      'explore',
      'explora',
      'revisa',
      'revisar',
      'review',
      'reviewing',
      'repasa',
      'repasar',
    ]) &&
    !hasCodeIntent
  ) {
    return 'research'
  }
  // `split` as a refactor verb only when free-token (not hyphen-compound).
  // JS `\b` treats `-` as a boundary, so `\bsplit\b` matches "split-home"
  // and discuss-lock blocked e2e smokes (dominance false-positive class).
  if (
    hasAny(text, ['refactor', 'cleanup', 'restructure']) ||
    /(?:^|[^a-z0-9_-])split(?:[^a-z0-9_-]|$)/.test(text)
  ) {
    return 'refactor'
  }
  if (hasAny(text, ['doc', 'docs', 'document', 'readme', 'changelog', 'typo'])) return 'docs'
  if (hasAny(text, ['chore', 'format', 'lint', 'linting', 'linter'])) return 'chore'
  if (hasAny(text, ['add', 'agrega', 'crear', 'implement', 'implementa', 'feature', 'mejora'])) {
    return 'feature'
  }
  return 'unknown'
}

function detectLevel(kind: HarnessKind, text: string, highRisk: boolean): HarnessLevel {
  if (kind === 'docs' || kind === 'chore') return 'H0'
  if (kind === 'security') return 'H3'
  // Research is H1 execution risk (read-only, no prod code) but its
  // orchestration is special-cased to parallel fan-out (see orchestrationFor).
  if (kind === 'research') return 'H1'
  if (
    highRisk &&
    hasAny(text, ['migration', 'sqlite', 'database', 'architecture', 'arquitectura'])
  ) {
    return 'H3'
  }
  if (kind === 'feature' || kind === 'refactor') return 'H2'
  if (kind === 'bug') return 'H1'
  return 'H1'
}

function detectRisk(level: HarnessLevel, highRisk: boolean): HarnessRisk {
  if (level === 'H3' || highRisk) return 'high'
  if (level === 'H2' || level === 'H1') return 'medium'
  return 'low'
}

function expectedEvidenceFor(
  kind: HarnessKind,
  level: HarnessLevel,
  publicSurface: boolean
): HarnessEvidence[] {
  const evidence = new Set<HarnessEvidence>()
  if (kind === 'bug') {
    evidence.add('regression-test')
    evidence.add('focused-tests')
    evidence.add('edge-cases')
  }
  if (kind === 'feature' || kind === 'refactor') {
    evidence.add('focused-tests')
    evidence.add('scope-check')
  }
  if (publicSurface) evidence.add('docs-if-public-behavior')
  if (level === 'H2' || level === 'H3') evidence.add('spec-or-design')
  if (level === 'H3') evidence.add('config-preservation')
  return [...evidence]
}

function gatesFor(level: HarnessLevel): HarnessGate[] {
  if (level === 'H0') return []
  if (level === 'H1') return ['verify-before-done']
  if (level === 'H2') return ['verify-before-done', 'scope-check']
  return ['spec-before-implementation', 'verify-before-done', 'scope-check', 'review-before-ship']
}

function rationaleFor(level: HarnessLevel, kind: HarnessKind, risk: HarnessRisk): string {
  if (level === 'H0') return `Low-risk ${kind}; keep the task direct and low-friction.`
  return `${level} ${kind}/${risk}; define expected evidence up front and verify before closure.`
}

function extractScopeHints(description: string): string[] {
  const terms = description
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^a-z0-9_.-]+/u)
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term))
  return [...new Set(terms)].slice(0, 8)
}

/**
 * Word-aware term matching. Bare `includes` classified "docker" as docs (via
 * `doc`) and "author" as security (via `auth`) — and the resulting H0/H3
 * levels now DRIVE the orchestration directive (model tier, ceremony), so a
 * mid-word false positive strips tests off a real code task. Rules:
 *  - terms >=5 chars match at a word START (`implement` → "implementation")
 *  - shorter terms must match a WHOLE word (`doc` ≠ "docker", `fix` ≠ "fixture")
 *  - multi-word terms (e.g. 'no se') keep plain substring semantics
 */
function hasAny(text: string, terms: string[]): boolean {
  return terms.some((term) => {
    if (term.includes(' ')) return text.includes(term)
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = term.length >= 5 ? `\\b${escaped}` : `\\b${escaped}\\b`
    return new RegExp(pattern).test(text)
  })
}

function observedEvidenceFromFiles(files: string[]): string[] {
  const observed = new Set<string>()
  if (files.some(isTestFile)) observed.add('tests-changed')
  if (files.some(isDocsFile)) observed.add('docs-changed')
  return [...observed]
}

function isTestFile(file: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?)\//.test(file) || /\.(test|spec)\.[cm]?[tj]sx?$/.test(file)
}

function isDocsFile(file: string): boolean {
  return /(^|\/)(README|CHANGELOG|docs\/)/i.test(file)
}

function touchesPublicSurface(files: string[]): boolean {
  return files.some(
    (file) =>
      file.startsWith('core/commands/') ||
      file.startsWith('core/mcp/') ||
      file.startsWith('templates/') ||
      file === 'README.md'
  )
}

async function readChangedFiles(projectPath: string): Promise<string[]> {
  const files = new Set<string>()
  const diff = await runGit(['diff', '--name-only', 'HEAD'], { cwd: projectPath })
  if (diff.ok) {
    for (const line of diff.stdout.split('\n')) {
      const value = line.trim()
      if (value) files.add(value)
    }
  } else if (diff.kind !== 'exit') {
    // Typed exit → no diff answer; still collect untracked below.
    throwProc(diff)
  }
  const untracked = await runGit(['ls-files', '--others', '--exclude-standard'], {
    cwd: projectPath,
  })
  if (untracked.ok) {
    for (const line2 of untracked.stdout.split('\n')) {
      const value = line2.trim()
      if (value) files.add(value)
    }
  } else if (untracked.kind !== 'exit') {
    throwProc(untracked)
  }
  return [...files].sort()
}

async function readDiffSize(projectPath: string): Promise<number> {
  const res = await runGit(['diff', '--shortstat', 'HEAD'], { cwd: projectPath })
  if (!res.ok) {
    // Typed exit = no diff info (fresh repo) → 0; infra failure propagates.
    if (res.kind === 'exit') return 0
    throwProc(res)
  }
  const insertions = Number.parseInt(res.stdout.match(/(\d+) insertions?/)?.[1] ?? '0', 10)
  const deletions = Number.parseInt(res.stdout.match(/(\d+) deletions?/)?.[1] ?? '0', 10)
  return insertions + deletions
}
