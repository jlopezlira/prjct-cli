/**
 * Package legitimacy gate — SUPERIOR to GSD slopcheck:
 *   1. PreToolUse Bash: flag/deny unknown packages BEFORE install
 *   2. Ship gate: new deps vs HEAD (existing)
 *
 * Precision over recall: only flags *new* dep names not previously in
 * package.json history (git show HEAD:package.json). Never auto-installs
 * alternatives (anti-slopsquatting). Strict packs can block ship / install.
 * Override ship with `--allow-new-deps` (not `--no-spec-gate`).
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileAsync } from '../utils/exec'

export interface PackageLegitimacyResult {
  newDependencies: string[]
  /** True when any new dep was introduced vs HEAD. */
  risky: boolean
  message: string | null
}

export interface ParsedPackageInstall {
  manager: 'npm' | 'pnpm' | 'yarn' | 'bun'
  packages: string[]
}

export interface PackageInstallDecision {
  risky: boolean
  newPackages: string[]
  message: string | null
}

/**
 * Parse a shell command for package-manager installs that add named packages.
 * Bare `npm install` / `pnpm i` (lockfile restore) → null.
 */
export function parsePackageInstallCommand(command: string): ParsedPackageInstall | null {
  const raw = command.trim()
  if (!raw) return null
  // First pipeline segment only (avoid false positives after &&).
  const segment = raw.split(/&&|\|\||;/)[0]?.trim() ?? raw
  const tokens = segment.split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return null

  const managerTok = tokens[0]!.replace(/\.cmd$/i, '')
  const manager =
    managerTok === 'npm' || managerTok === 'npx'
      ? 'npm'
      : managerTok === 'pnpm'
        ? 'pnpm'
        : managerTok === 'yarn'
          ? 'yarn'
          : managerTok === 'bun'
            ? 'bun'
            : null
  if (!manager) return null

  const verb = tokens[1]!
  const isInstall =
    verb === 'install' ||
    verb === 'i' ||
    verb === 'add' ||
    (manager === 'npm' && verb === 'install') ||
    (manager === 'yarn' && (verb === 'add' || verb === 'install'))
  if (!isInstall) return null

  const packages: string[] = []
  for (const i of tokens.slice(2).keys()) {
    const t = tokens[i + 2]!
    if (t.startsWith('-')) continue
    if (t.startsWith('.') || t.startsWith('/') || t.startsWith('file:') || t.startsWith('http')) {
      continue
    }
    const name = normalizePackageToken(t)
    if (name) packages.push(name)
  }

  const unique = [...new Set(packages)]
  if (unique.length === 0) return null
  return { manager, packages: unique }
}

/** `lodash`, `lodash@4`, `@types/node`, `@types/node@1.0.0` → bare package name. */
function normalizePackageToken(token: string): string | null {
  if (token.startsWith('@')) {
    const m = token.match(/^(@[\w.-]+\/[\w.-]+)/)
    return m ? m[1]! : null
  }
  const base = token.split('@')[0] ?? ''
  if (!base || !/^[\w.-]+$/.test(base)) return null
  return base
}

/**
 * Compare requested install packages to already-declared deps (working tree).
 */
export function decidePackageInstall(
  packages: string[],
  knownDeps: ReadonlySet<string>
): PackageInstallDecision {
  const neu = packages.filter((p) => !knownDeps.has(p)).sort()
  if (neu.length === 0) {
    return { risky: false, newPackages: [], message: null }
  }
  return {
    risky: true,
    newPackages: neu,
    message: [
      `Package legitimacy (pre-install): ${neu.length} new package${neu.length === 1 ? '' : 's'} not in package.json:`,
      ...neu.map((n) => `  - ${n}`),
      'Verify each on the registry (age, downloads, maintainers). Do not install look-alike names.',
      'Strict packs DENY the install until verified. Override ship later with `prjct ship --allow-new-deps` only after human consent.',
    ].join('\n'),
  }
}

/** Load declared dependency names from working-tree package.json (sync-friendly). */
export async function loadKnownDependencyNames(projectPath: string): Promise<Set<string>> {
  const pkgPath = path.join(projectPath, 'package.json')
  if (!existsSync(pkgPath)) return new Set()
  const current = await readJsonFile(pkgPath)
  return depNames(current)
}

interface PkgJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function depNames(pkg: PkgJson | null): Set<string> {
  const out = new Set<string>()
  if (!pkg) return out
  for (const key of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ] as const) {
    const block = pkg[key]
    if (block) for (const name of Object.keys(block)) out.add(name)
  }
  return out
}

async function readJsonFile(file: string): Promise<PkgJson | null> {
  try {
    const raw = await readFile(file, 'utf-8')
    return JSON.parse(raw) as PkgJson
  } catch {
    return null
  }
}

async function headPackageJson(projectPath: string): Promise<PkgJson | null> {
  try {
    const { stdout } = await execFileAsync('git', ['show', 'HEAD:package.json'], {
      cwd: projectPath,
    })
    return JSON.parse(stdout) as PkgJson
  } catch {
    return null
  }
}

/**
 * Compare working-tree package.json to HEAD. No git / no package.json → clean.
 */
export async function checkPackageLegitimacy(
  projectPath: string
): Promise<PackageLegitimacyResult> {
  const pkgPath = path.join(projectPath, 'package.json')
  if (!existsSync(pkgPath)) {
    return { newDependencies: [], risky: false, message: null }
  }
  if (!existsSync(path.join(projectPath, '.git'))) {
    return { newDependencies: [], risky: false, message: null }
  }

  const current = await readJsonFile(pkgPath)
  const baseline = await headPackageJson(projectPath)
  const now = depNames(current)
  const before = depNames(baseline)
  const added = [...now].filter((n) => !before.has(n)).sort()

  if (added.length === 0) {
    return { newDependencies: [], risky: false, message: null }
  }

  return {
    newDependencies: added,
    risky: true,
    message: [
      `Package legitimacy: ${added.length} new dependenc${added.length === 1 ? 'y' : 'ies'} vs HEAD:`,
      ...added.map((n) => `  - ${n}`),
      'Verify each on the registry (age, downloads, source). Do not substitute similar names.',
      'Strict packs block ship until you confirm or revert.',
      'Override with explicit consent: `prjct ship --allow-new-deps` (not `--no-spec-gate`).',
    ].join('\n'),
  }
}
