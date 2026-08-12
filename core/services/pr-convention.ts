/**
 * Detects how a project wants ship's PR step to behave: does it already
 * have a PR template (use it), a clear non-GitHub/no-remote signal (skip
 * auto-PR — pr:ensure only knows `gh`), or a genuinely ambiguous GitHub
 * remote with no template (worth asking a human, when one is present).
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { execFileAsync } from '../utils/exec'

export type PrConvention = 'auto' | 'manual'

export type PrConventionSignal =
  | { kind: 'template'; templatePath: string }
  | { kind: 'github-ambiguous' }
  | { kind: 'non-github' }
  | { kind: 'no-remote' }

const TEMPLATE_CANDIDATES = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/PULL_REQUEST_TEMPLATE/default.md',
  'docs/pull_request_template.md',
  '.gitlab/merge_request_templates/default.md',
]

function findPrTemplate(projectPath: string): string | null {
  for (const candidate of TEMPLATE_CANDIDATES) {
    if (existsSync(path.join(projectPath, candidate))) return candidate
  }
  return null
}

async function getRemoteHost(projectPath: string): Promise<'github' | 'other' | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectPath,
      timeout: 3000,
    })
    const url = stdout.toString().trim()
    if (!url) return null
    return /(^|[./@])github\.com([/:]|$)/.test(url) ? 'github' : 'other'
  } catch {
    return null
  }
}

export async function detectPrConventionSignal(projectPath: string): Promise<PrConventionSignal> {
  const templatePath = findPrTemplate(projectPath)
  if (templatePath) return { kind: 'template', templatePath }

  const host = await getRemoteHost(projectPath)
  if (host === 'github') return { kind: 'github-ambiguous' }
  if (host === 'other') return { kind: 'non-github' }
  return { kind: 'no-remote' }
}

/**
 * Non-interactive default for a signal — used by any caller that can't
 * ask a human (CI, ship's own migration auto-seed). Preserves the
 * previous unconditional-auto behavior for the one case that used to
 * work today (GitHub remote); every other case defaults to manual
 * rather than guessing at a host pr:ensure doesn't speak yet.
 */
export function defaultPrConventionFor(signal: PrConventionSignal): PrConvention {
  if (signal.kind === 'non-github') return 'manual'
  if (signal.kind === 'no-remote') return 'manual'
  return 'auto'
}
