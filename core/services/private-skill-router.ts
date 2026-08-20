import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveCliHome } from '../infrastructure/cli-home'
import type { TaskHarness } from '../schemas/state'
import { PACKAGE_ROOT } from '../utils/version'
import { EMBEDDED_PRIVATE_SKILL_BODIES } from './private-skill-assets'

export type PrivateSkillKind = 'workflow' | 'reference'
export type PrivateSkillId =
  | 'diagnosing-bugs'
  | 'tdd'
  | 'code-review'
  | 'resolving-merge-conflicts'
  | 'research'
  | 'writing-for-agents'
  | 'comment-discipline'
  | 'domain-modeling'
  | 'codebase-design'
export type OutputProfile = 'compact' | 'standard' | 'expanded'

interface PrivateSkillManifestEntry {
  readonly id: PrivateSkillId
  readonly kind: PrivateSkillKind
  readonly file: string
}

const freezeEntry = (entry: PrivateSkillManifestEntry): Readonly<PrivateSkillManifestEntry> =>
  Object.freeze(entry)

/** Package-owned allowlist. Prompts can select IDs, never paths. */
export const PRIVATE_SKILL_MANIFEST: Readonly<
  Record<PrivateSkillId, Readonly<PrivateSkillManifestEntry>>
> = Object.freeze({
  'diagnosing-bugs': freezeEntry({
    id: 'diagnosing-bugs',
    kind: 'workflow',
    file: 'diagnosing-bugs.md',
  }),
  tdd: freezeEntry({ id: 'tdd', kind: 'workflow', file: 'tdd.md' }),
  'code-review': freezeEntry({ id: 'code-review', kind: 'workflow', file: 'code-review.md' }),
  'resolving-merge-conflicts': freezeEntry({
    id: 'resolving-merge-conflicts',
    kind: 'workflow',
    file: 'resolving-merge-conflicts.md',
  }),
  research: freezeEntry({ id: 'research', kind: 'workflow', file: 'research.md' }),
  'writing-for-agents': freezeEntry({
    id: 'writing-for-agents',
    kind: 'reference',
    file: 'writing-for-agents.md',
  }),
  'comment-discipline': freezeEntry({
    id: 'comment-discipline',
    kind: 'reference',
    file: 'comment-discipline.md',
  }),
  'domain-modeling': freezeEntry({
    id: 'domain-modeling',
    kind: 'reference',
    file: 'domain-modeling.md',
  }),
  'codebase-design': freezeEntry({
    id: 'codebase-design',
    kind: 'reference',
    file: 'codebase-design.md',
  }),
})

export const PRIVATE_SKILL_ASSET_ROOT = path.join(
  PACKAGE_ROOT,
  'assets',
  'private-engineering-skills'
)

function embeddedAssetRoot(): string {
  const digest = createHash('sha256')
    .update(Object.values(EMBEDDED_PRIVATE_SKILL_BODIES).join('\0'))
    .digest('hex')
    .slice(0, 12)
  return path.join(resolveCliHome(), 'cache', 'private-engineering-skills', digest)
}

/** Materialize one immutable embedded body for a standalone binary. */
export function materializeEmbeddedPrivateSkillPath(
  relativeFile: string,
  cacheRoot = embeddedAssetRoot()
): string {
  const body = EMBEDDED_PRIVATE_SKILL_BODIES[relativeFile]
  if (!body) throw new Error(`Private skill asset is missing: ${relativeFile}`)
  const requestedRoot = path.resolve(cacheRoot)
  fs.mkdirSync(requestedRoot, { recursive: true, mode: 0o700 })
  const root = fs.realpathSync.native(requestedRoot)
  const target = path.join(root, relativeFile)
  if (!isWithin(root, target)) throw new Error('Private skill path escapes the embedded cache.')
  const current = (() => {
    try {
      return fs.readFileSync(target, 'utf8')
    } catch {
      return null
    }
  })()
  if (current !== body) {
    const temporary = `${target}.${process.pid}.tmp`
    fs.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, target)
  }
  return fs.realpathSync.native(target)
}

export interface ResolvedPrivateSkill {
  readonly id: PrivateSkillId
  readonly kind: PrivateSkillKind
  readonly path: string
}

export interface PrivateSkillRoute {
  readonly workflow?: ResolvedPrivateSkill
  readonly reference?: ResolvedPrivateSkill
}

export interface PrivateSkillRoutingInput {
  intent: string
  harness?: Pick<TaskHarness, 'level' | 'kind'>
  tddMode?: 'off' | 'assist' | 'strict'
  /** Surface intent, when known. */
  purpose?: 'status' | 'plan' | 'review' | 'diagnosis'
  /** Repository facts supplied by a caller that has already inspected git/diff state. */
  hasMergeConflicts?: boolean
  changedCommentLines?: number
  /** A caller-confirmed need to consult sources outside the repository. */
  needsExternalResearch?: boolean
}

/** Preserve explicit config/env preferences while leaving true absence eligible for auto-assist. */
export function tddRoutingMode(
  configured?: 'off' | 'assist' | 'strict',
  environment = process.env.PRJCT_TDD_MODE
): 'off' | 'assist' | 'strict' | undefined {
  if (configured) return configured
  if (environment === undefined) return undefined
  const normalized = environment.trim().toLowerCase()
  return normalized === 'assist' || normalized === 'strict' || normalized === 'off'
    ? normalized
    : 'off'
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Resolve a package-owned relative asset and enforce the canonical trust boundary.
 * Exported for security tests; routing itself only supplies immutable manifest files.
 */
export function resolvePrivateSkillPath(
  relativeFile: string,
  assetRoot = PRIVATE_SKILL_ASSET_ROOT
): string {
  if (!relativeFile || path.isAbsolute(relativeFile)) {
    throw new Error('Private skill path must be a package-owned relative path.')
  }
  const normalized = path.normalize(relativeFile)
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error('Private skill path escapes the private asset root.')
  }

  let canonicalRoot: string
  let canonicalFile: string
  try {
    canonicalRoot = fs.realpathSync.native(assetRoot)
    canonicalFile = fs.realpathSync.native(path.join(canonicalRoot, normalized))
  } catch {
    if (assetRoot === PRIVATE_SKILL_ASSET_ROOT) {
      return materializeEmbeddedPrivateSkillPath(normalized)
    }
    throw new Error(`Private skill asset is missing: ${relativeFile}`)
  }
  if (assetRoot === PRIVATE_SKILL_ASSET_ROOT) {
    let canonicalPackageAssets: string
    try {
      canonicalPackageAssets = fs.realpathSync.native(path.join(PACKAGE_ROOT, 'assets'))
    } catch {
      throw new Error('Private skill package asset root is missing.')
    }
    if (!isWithin(canonicalPackageAssets, canonicalRoot)) {
      throw new Error('Private skill root escapes the canonical package assets directory.')
    }
  }
  if (!isWithin(canonicalRoot, canonicalFile)) {
    throw new Error('Private skill path escapes the private asset root.')
  }
  if (!fs.statSync(canonicalFile).isFile()) {
    throw new Error(`Private skill asset is not a file: ${relativeFile}`)
  }
  return canonicalFile
}

export function resolvePrivateSkill(
  id: PrivateSkillId,
  assetRoot = PRIVATE_SKILL_ASSET_ROOT
): ResolvedPrivateSkill {
  const entry = PRIVATE_SKILL_MANIFEST[id]
  if (!entry) throw new Error(`Unknown private skill id: ${String(id)}`)
  return Object.freeze({
    id: entry.id,
    kind: entry.kind,
    path: resolvePrivateSkillPath(entry.file, assetRoot),
  })
}

const matches = (text: string, pattern: RegExp): boolean => pattern.test(text)

const DIAGNOSIS_SIGNAL =
  /\b(?:hard\s+bug|flak(?:e|ey|y)|regression|crash(?:es|ing)?|hang(?:s|ing)?|deadlock|memory\s+leak|performance\s+(?:failure|bug|issue|regression|degradation)|latency\s+regression|throughput\s+drop|timeout|root\s+cause(?:\s+analysis)?|rca|debug\s+(?:this|the\s+(?:bug|failure|error))|diagnos(?:e|ing)\s+(?:a\s+)?(?:bug|failure)|(?:fix|repair|resolve)\b.{0,80}\b(?:bug|error|failure)|(?:bug|error|fall[ao])\s+dif[ií]cil|intermitente|regresi[oó]n|crashe?[ao]?|cuelg(?:ue|a|ues|an|ado|ada)|bloqueo|fuga\s+de\s+memoria|(?:fall[ao]|degradaci[oó]n)\s+de\s+rendimiento|lentitud|tiempo\s+de\s+espera|an[aá]lisis\s+de\s+causa\s+ra[ií]z|depurar\s+(?:este|el|un[ao]?)\s+(?:bug|error|fall[ao])|diagnosticar\s+(?:un[ao]?\s+)?(?:bug|error|fall[ao])|(?:arreglar|reparar|resolver)\b.{0,80}\b(?:bug|error|fall[ao]))\b/

/** Shared high-precision predicate for workflow routing and output profiling. */
export function isDiagnosisIntent(input: PrivateSkillRoutingInput, normalized?: string): boolean {
  return (
    input.purpose === 'diagnosis' || DIAGNOSIS_SIGNAL.test(normalized ?? input.intent.toLowerCase())
  )
}

function workflowFor(input: PrivateSkillRoutingInput, text: string): PrivateSkillId | null {
  if (
    input.hasMergeConflicts ||
    matches(
      text,
      /\b(?:resolve|resolving|fix)\s+(?:(?:git|merge|rebase)\s+)?conflicts?\b|\b(?:merge|rebase)\s+conflicts?\b|\b(?:resolver|resolviendo|solucionar)\s+conflictos?\s+(?:de\s+)?(?:git|merge|fusi[oó]n|rebase)\b|\bconflictos?\s+(?:de\s+)?(?:merge|fusi[oó]n|rebase)\b/
    )
  ) {
    return 'resolving-merge-conflicts'
  }
  if (isDiagnosisIntent(input, text)) return 'diagnosing-bugs'
  if (input.harness?.kind === 'bug' && input.harness.level !== 'H0') return 'diagnosing-bugs'

  if (
    matches(
      text,
      /\b(?:code review|review (?:the |this )?.{0,40}\b(?:diff|branch|pr|pull request|changes)|review since|revisi[oó]n de c[oó]digo|revisar (?:el |este )?.{0,40}\b(?:diff|cambio|cambios|branch|rama|pr|pull request)|revisar desde)\b/
    )
  ) {
    return 'code-review'
  }

  if (
    input.needsExternalResearch ||
    matches(
      text,
      /\b(?:research|look up (?:the |this )?(?:official )?(?:documentation|docs|api)|primary sources?|official (?:documentation|docs|specification)|investigar?|buscar (?:en )?(?:la )?(?:documentaci[oó]n|fuentes? primarias?)|fuentes? (?:oficiales|primarias)|documentaci[oó]n oficial)\b/
    )
  ) {
    return 'research'
  }

  const behaviorChanging =
    input.harness?.kind === 'feature' ||
    input.harness?.kind === 'refactor' ||
    input.harness?.kind === 'bug' ||
    input.harness?.kind === 'security' ||
    matches(
      text,
      /\b(?:implement|add|change|fix|refactor|rewrite)\b.*\b(?:behavior|code|feature|api)\b/
    )
  const tddRequested = input.tddMode === 'assist' || input.tddMode === 'strict'
  const tddAutoAssist =
    input.tddMode === undefined && (input.harness?.level === 'H2' || input.harness?.level === 'H3')
  if (behaviorChanging && (tddRequested || tddAutoAssist)) return 'tdd'
  return null
}

function referenceFor(input: PrivateSkillRoutingInput, text: string): PrivateSkillId | null {
  if (
    matches(
      text,
      /\b(?:AGENTS|CLAUDE|GEMINI)\.md\b|\bSKILL\.md\b|\.cursorrules\b|\bcopilot-instructions\.md\b|\b(?:agent instructions?|system prompt|prompt instructions?|instrucciones? (?:del agente|para (?:el |los )?agentes?)|prompt del sistema)\b/i
    )
  ) {
    return 'writing-for-agents'
  }
  if (
    (input.changedCommentLines ?? 0) > 0 ||
    matches(
      text,
      /\b(?:code comments?|inline comments?|docblocks?|jsdoc|verbose comments?|comment discipline|commentary in code|comentarios? (?:de c[oó]digo|inline|verbosos?|innecesarios?)|disciplina de comentarios|documentar (?:el |este )?c[oó]digo)\b/
    )
  ) {
    return 'comment-discipline'
  }
  if (
    matches(
      text,
      /\b(?:domain model(?:ing)?|domain language|ubiquitous language|bounded context|aggregate root|value object|(?:domain |business )?invariants?|modelo de dominio|lenguaje (?:ubicuo|de dominio)|contexto delimitado|ra[ií]z de agregado|objeto de valor|invariantes?)\b/
    )
  ) {
    return 'domain-modeling'
  }
  if (
    matches(
      text,
      /\b(?:architecture|architectural|interface|seam|codebase design|arquitectura|interfaz|costura|punto de extensi[oó]n|diseño (?:del c[oó]digo|de la base de c[oó]digo))\b/
    )
  ) {
    return 'codebase-design'
  }
  return null
}

/** Deterministic, offline router. Default is an empty route. */
export function routePrivateSkills(input: PrivateSkillRoutingInput): PrivateSkillRoute {
  const text = input.intent.toLowerCase()
  const workflowId = workflowFor(input, text)
  const referenceId = referenceFor(input, text)
  const route: PrivateSkillRoute = {
    ...(workflowId ? { workflow: resolvePrivateSkill(workflowId) } : {}),
    ...(referenceId ? { reference: resolvePrivateSkill(referenceId) } : {}),
  }
  return Object.freeze(route)
}

export function outputProfileFor(input: PrivateSkillRoutingInput): OutputProfile {
  const text = input.intent.toLowerCase()
  if (
    /\b(?:give|provide|write|explain|analy[sz]e|describe|review|document|summarize)\b.{0,60}\b(?:in detail|in[- ]depth|comprehensively|exhaustively)\b/.test(
      text
    ) ||
    /\b(?:full|detailed|in[- ]depth|comprehensive|exhaustive|expanded)\s+(?:answer|response|summary|status|output|report|analysis|explanation|details?|review|plan)\b/.test(
      text
    ) ||
    /\b(?:analiza|analizar|explica|explicar|describe|describir|detalla|detallar|revisa|revisar|rev[ií]salo|documenta|documentar|resume|resumir|dame|proporciona)\b.{0,60}\b(?:a detalle|en detalle|detalladamente|a fondo|exhaustivamente)\b/.test(
      text
    ) ||
    /\b(?:respuesta|informe|an[aá]lisis|explicaci[oó]n|salida|revisi[oó]n|plan)\s+(?:complet[oa]|detallad[oa]|exhaustiv[oa]|ampliad[oa])\b/.test(
      text
    )
  ) {
    return 'expanded'
  }
  if (
    /\b(?:brief|concise|compact|short)\s+(?:answer|response|summary|output|report)\b|\b(?:keep it|be)\s+(?:brief|concise|short)\b|\b(?:respuesta|salida|resumen|informe)\s+(?:breve|concis[oa]|cort[oa]|compact[oa])\b|\b(?:s[eé]|mant[eé]nlo)\s+(?:breve|concis[oa]|cort[oa])\b/.test(
      text
    )
  ) {
    return 'compact'
  }
  if (
    input.purpose === 'plan' ||
    input.purpose === 'review' ||
    isDiagnosisIntent(input, text) ||
    input.harness?.level === 'H2' ||
    input.harness?.level === 'H3' ||
    /\b(?:plan|review|diagnos(?:e|is|tic)|investigat(?:e|ion))\b/.test(text)
  ) {
    return 'standard'
  }
  return 'compact'
}

const OUTPUT_GUIDANCE: Readonly<Record<OutputProfile, string>> = Object.freeze({
  compact:
    'Output: compact (soft target: 120 words). Lead with outcome; include distinct evidence only. Preserve errors, security, acceptance criteria, and requested full output.',
  standard:
    'Output: standard (soft target: 300 words). Lead with outcome; include distinct evidence only. Preserve errors, security, acceptance criteria, and requested full output.',
  expanded: 'Output: expanded because detailed/full output was explicitly requested.',
})

/** Exact package pointers only; prompt hooks use this zero-prose pull cue. */
export function formatPrivateSkillPointers(route: PrivateSkillRoute): string | null {
  const selected = [route.workflow, route.reference].filter(
    (skill): skill is ResolvedPrivateSkill => Boolean(skill)
  )
  return selected.length > 0
    ? `Private guidance (auto; read on demand): ${selected.map((skill) => `${skill.kind}:${skill.id}=\`${skill.path}\``).join(' · ')}`
    : null
}

/** Canonical model-only block used by CLI work, MCP work, owned agents, and prompts. */
export function formatModelOnlyGuidance(route: PrivateSkillRoute, profile: OutputProfile): string {
  return [formatPrivateSkillPointers(route), OUTPUT_GUIDANCE[profile]].filter(Boolean).join('\n')
}
