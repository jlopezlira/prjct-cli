/**
 * VersionService - Stack-aware version detection and bumping
 *
 * Detects version source files in priority order:
 * 1. package.json (Node.js)
 * 2. Cargo.toml (Rust)
 * 3. pyproject.toml (Python)
 * 4. *.csproj (C#/.NET)
 * 5. VERSION file
 * 6. version.txt file
 * 7. Git tags (v*.*.*)
 * 8. Fallback: create VERSION file with 0.1.0
 *
 * Uses file-based detection (no stack assumptions).
 * No external parsing libraries - uses regex for TOML/XML.
 */

import path from 'node:path'
import type { VersionInfo } from '../types/services/extracted'
import { execFileAsync, runGit, throwProc } from '../utils/exec'
import * as fileHelper from '../utils/file-helper'

// VersionService

export class VersionService {
  private projectPath: string

  constructor(projectPath: string) {
    this.projectPath = projectPath
  }

  /**
   * Detect the current version and compute the next patch bump.
   */
  async detect(): Promise<VersionInfo> {
    // Try each source in priority order
    const sources: Array<() => Promise<VersionInfo | null>> = [
      () => this.fromPackageJson(),
      () => this.fromCargoToml(),
      () => this.fromPyprojectToml(),
      () => this.fromCsproj(),
      () => this.fromVersionFile('VERSION'),
      () => this.fromVersionFile('version.txt'),
      () => this.fromGitTag(),
    ]

    for (const source of sources) {
      const result = await source()
      if (result) return result
    }

    // Fallback: create VERSION file with 0.1.0
    return this.createFallbackVersion()
  }

  /**
   * Bump the version in the detected source file.
   * Returns the new version string.
   *
   * Idempotent: if the working-tree version is already AHEAD of the
   * version in `git HEAD` (i.e. a previous ship run bumped but never
   * committed, or this method was already called this session), return
   * the working-tree version unchanged. Prevents the "double-bump on
   * retry" failure mode where a partial ship rerun creates v+2 instead
   * of completing the original v+1.
   */
  async bump(level: BumpLevel = 'patch'): Promise<string> {
    const info = await this.detect()

    // Idempotency check: only consult git when the version source is a
    // tracked file (package.json/Cargo.toml/etc.). The git-tag source
    // has `info.file === null` and falls through to a normal bump.
    if (info.file) {
      const headVersion = await this.readVersionFromGitHead(info.file, info.format)
      if (headVersion && this.isAheadOf(info.current, headVersion)) {
        // Working tree was already bumped (likely by a prior failed
        // ship, or a manual pre-bump); reuse it instead of bumping again.
        await this.assertGitTagAvailable(info.current)
        return info.current
      }
    }

    // `detect()` precomputes a patch bump; override with the requested level
    // (feat ships → minor, etc.) computed from the current version.
    const next = bumpVersion(info.current, level)
    await this.assertGitTagAvailable(next)
    await this.writeVersion({ ...info, next })
    return next
  }

  /**
   * Fail before touching version files when the candidate release tag already
   * exists locally or on a configured remote. A stale feature worktree must
   * never manufacture the same release number as a newer remote main.
   */
  private async assertGitTagAvailable(version: string): Promise<void> {
    const tag = `v${version}`
    const collision = (location: string): Error =>
      new Error(
        `Release ${tag} already exists ${location}. Sync the latest base branch, resolve conflicts, and retry ship so a new version is calculated.`
      )

    const local = await runGit(['tag', '--list', tag], { cwd: this.projectPath })
    if (!local.ok) {
      if (local.kind === 'exit') return
      throwProc(local)
    }
    if (local.stdout.trim().split(/\r?\n/).includes(tag)) {
      throw collision('as a local Git tag')
    }

    const configured = await runGit(['remote'], { cwd: this.projectPath })
    if (!configured.ok) {
      if (configured.kind === 'exit') return
      throwProc(configured)
    }
    const remotes = configured.stdout
      .split(/\r?\n/)
      .map((remote) => remote.trim())
      .filter(Boolean)

    for (const remote of remotes) {
      const result = await runGit(
        ['ls-remote', '--exit-code', '--tags', remote, `refs/tags/${tag}`],
        { cwd: this.projectPath }
      )
      if (result.ok) throw collision(`on Git remote ${remote}`)
      if (result.kind === 'exit' && result.code === 2) continue
      if (result.kind === 'exit') {
        throw new Error(
          `Could not verify release tag availability on Git remote ${remote}: ${result.stderr.trim() || `git exited ${result.code}`}`
        )
      }
      throwProc(result)
    }
  }

  /**
   * Read the version of `file` as it exists at `git HEAD`. Returns null
   * when the file is untracked, the repo is fresh, or git is unavailable.
   * Throws GitInfraError on git timeout/spawn — a transient git failure
   * must NOT be read as "fresh", or a version bump could reset the version.
   */
  private async readVersionFromGitHead(
    file: string,
    format: VersionInfo['format']
  ): Promise<string | null> {
    const relPath = path.relative(this.projectPath, file)
    const res = await runGit(['show', `HEAD:${relPath}`], { cwd: this.projectPath })
    if (!res.ok) {
      // Typed exit = file not in HEAD / not a git repo → treat as fresh.
      if (res.kind === 'exit') return null
      throwProc(res)
    }
    try {
      const stdout = res.stdout
      if (format === 'json') {
        const parsed = JSON.parse(stdout) as { version?: string }
        return parsed.version ?? null
      }
      if (format === 'plaintext') {
        const value = stdout.trim()
        return isSemver(value) ? value : null
      }
      if (format === 'toml') {
        return parseTomlVersion(stdout) ?? parsePyprojectVersion(stdout)
      }
      if (format === 'xml') {
        return parseCsprojVersion(stdout)
      }
      return null
    } catch {
      // HEAD content exists but doesn't parse as the expected format.
      return null
    }
  }

  /**
   * Strict semver greater-than. `2.4.40` > `2.4.39` returns true.
   */
  private isAheadOf(a: string, b: string): boolean {
    const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
    const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
    for (const i of [0, 1, 2]) {
      const ai = pa[i] ?? 0
      const bi = pb[i] ?? 0
      if (ai > bi) return true
      if (ai < bi) return false
    }
    return false
  }

  // Source Detectors

  private async fromPackageJson(): Promise<VersionInfo | null> {
    const filePath = path.join(this.projectPath, 'package.json')
    const pkg = await fileHelper.readJson<{ version?: string }>(filePath, null)
    if (!pkg?.version) return null

    return {
      current: pkg.version,
      next: bumpPatch(pkg.version),
      file: filePath,
      format: 'json',
    }
  }

  private async fromCargoToml(): Promise<VersionInfo | null> {
    const filePath = path.join(this.projectPath, 'Cargo.toml')
    const content = await fileHelper.readFile(filePath, '')
    if (!content) return null

    const version = parseTomlVersion(content)
    if (!version) return null

    return {
      current: version,
      next: bumpPatch(version),
      file: filePath,
      format: 'toml',
    }
  }

  private async fromPyprojectToml(): Promise<VersionInfo | null> {
    const filePath = path.join(this.projectPath, 'pyproject.toml')
    const content = await fileHelper.readFile(filePath, '')
    if (!content) return null

    const version = parsePyprojectVersion(content)
    if (!version) return null

    return {
      current: version,
      next: bumpPatch(version),
      file: filePath,
      format: 'toml',
    }
  }

  private async fromCsproj(): Promise<VersionInfo | null> {
    const files = await fileHelper.listFiles(this.projectPath, { extension: '.csproj' })
    if (files.length === 0) return null

    const filePath = path.join(this.projectPath, files[0])
    const content = await fileHelper.readFile(filePath, '')
    if (!content) return null

    const version = parseCsprojVersion(content)
    if (!version) return null

    return {
      current: version,
      next: bumpPatch(version),
      file: filePath,
      format: 'xml',
    }
  }

  private async fromVersionFile(filename: string): Promise<VersionInfo | null> {
    const filePath = path.join(this.projectPath, filename)
    const content = await fileHelper.readFile(filePath, '')
    if (!content) return null

    const version = content.trim()
    if (!isSemver(version)) return null

    return {
      current: version,
      next: bumpPatch(version),
      file: filePath,
      format: 'plaintext',
    }
  }

  private async fromGitTag(): Promise<VersionInfo | null> {
    const res = await runGit(['tag', '--sort=-v:refname'], { cwd: this.projectPath })
    if (!res.ok) {
      // Typed exit = not a git repo / no tags → next detector. Infra
      // failure (timeout/spawn) throws — never skip detectors silently.
      if (res.kind === 'exit') return null
      throwProc(res)
    }

    const tags = res.stdout.trim().split('\n')
    for (const tag of tags) {
      const cleaned = tag.trim().replace(/^v/, '')
      if (isSemver(cleaned)) {
        return {
          current: cleaned,
          next: bumpPatch(cleaned),
          file: null,
          format: 'git-tag',
        }
      }
    }

    return null
  }

  // Fallback

  private async createFallbackVersion(): Promise<VersionInfo> {
    const filePath = path.join(this.projectPath, 'VERSION')
    await fileHelper.writeFile(filePath, '0.1.0\n')

    return {
      current: '0.1.0',
      next: '0.1.1',
      file: filePath,
      format: 'plaintext',
    }
  }

  // Write version back to source

  private async writeVersion(info: VersionInfo): Promise<void> {
    if (!info.file) {
      // git-tag: create a new tag
      if (info.format === 'git-tag') {
        await execFileAsync('git', ['tag', `v${info.next}`], { cwd: this.projectPath })
      }
      return
    }

    switch (info.format) {
      case 'json':
        await this.writeJsonVersion(info.file, info.next)
        break
      case 'toml':
        await this.writeTomlVersion(info.file, info.next)
        break
      case 'xml':
        await this.writeXmlVersion(info.file, info.next)
        break
      case 'plaintext':
        await fileHelper.writeFile(info.file, `${info.next}\n`)
        break
    }
  }

  private async writeJsonVersion(filePath: string, version: string): Promise<void> {
    const pkg = await fileHelper.readJson<Record<string, unknown>>(filePath, {})
    if (pkg) {
      pkg.version = version
      await fileHelper.writeJson(filePath, pkg)
    }
  }

  private async writeTomlVersion(filePath: string, version: string): Promise<void> {
    const content = await fileHelper.readFile(filePath, '')
    if (!content) return

    // Replace version = "x.y.z" with new version
    const updated = content.replace(/^(\s*version\s*=\s*")([^"]+)(")/m, `$1${version}$3`)
    await fileHelper.writeFile(filePath, updated)
  }

  private async writeXmlVersion(filePath: string, version: string): Promise<void> {
    const content = await fileHelper.readFile(filePath, '')
    if (!content) return

    // Replace <Version>x.y.z</Version>
    const updated = content.replace(/(<Version>)([^<]+)(<\/Version>)/, `$1${version}$3`)
    await fileHelper.writeFile(filePath, updated)
  }
}

// Helpers (pure functions)

/**
 * Validate that a string looks like a semver version (major.minor.patch).
 * Allows optional pre-release suffix.
 */
function isSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+/.test(version)
}

/**
 * Bump a semantic version.
 * - Stable: "1.2.3" -> "1.2.4"
 * - Prerelease with numeric tail: "2.0.0-alpha.12" -> "2.0.0-alpha.13"
 * - Prerelease without numeric tail: "0.1.0-beta" -> "0.1.0-beta.1"
 * - Unknown format: returned unchanged.
 * Build metadata (+xyz) is dropped, matching npm/semver tooling behavior.
 */
export function bumpPatch(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return version

  const [, major, minor, patch, pre] = match

  if (pre) {
    const parts = pre.split('.')
    const lastIdx = parts.length - 1
    if (/^\d+$/.test(parts[lastIdx])) {
      parts[lastIdx] = String(Number(parts[lastIdx]) + 1)
      return `${major}.${minor}.${patch}-${parts.join('.')}`
    }
    return `${major}.${minor}.${patch}-${pre}.1`
  }

  return `${major}.${minor}.${Number(patch) + 1}`
}

export type BumpLevel = 'patch' | 'minor' | 'major'

/** Minor bump: "2.32.8" -> "2.33.0" (resets patch, drops any pre-release). */
export function bumpMinor(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return version
  return `${m[1]}.${Number(m[2]) + 1}.0`
}

/** Major bump: "2.32.8" -> "3.0.0" (resets minor+patch, drops any pre-release). */
export function bumpMajor(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return version
  return `${Number(m[1]) + 1}.0.0`
}

/** Bump `version` by the given level. */
export function bumpVersion(version: string, level: BumpLevel): string {
  if (level === 'major') return bumpMajor(version)
  if (level === 'minor') return bumpMinor(version)
  return bumpPatch(version)
}

/**
 * Infer the semver bump level from a conventional-commit-style description.
 * A ship is a feature by default → MINOR; explicit non-feature prefixes
 * (fix/chore/docs/refactor/perf/style/test/build/ci/revert) → PATCH; a `!`
 * marker or "BREAKING CHANGE" → MAJOR. This is what lets `feat:` ships bump
 * minor instead of every ship defaulting to patch.
 */
export function inferBumpLevel(description: string | undefined): BumpLevel {
  const d = (description ?? '').toLowerCase().trim()
  if (!d) return 'patch' // no signal → conservative default
  if (/^[a-z]+(\([^)]*\))?!:/.test(d) || d.includes('breaking change')) return 'major'
  if (/^(fix|chore|docs|refactor|perf|style|test|build|ci|revert)(\([^)]*\))?:/.test(d)) {
    return 'patch'
  }
  return 'minor'
}

/**
 * Parse version from a Cargo.toml [package] section.
 * Looks for: version = "x.y.z" under [package].
 */
function parseTomlVersion(content: string): string | null {
  // Find [package] section and extract version
  const packageSection = content.match(/\[package\]([\s\S]*?)(?=\n\[|\n*$)/)
  if (!packageSection) return null

  const versionMatch = packageSection[1].match(/^\s*version\s*=\s*"([^"]+)"/m)
  return versionMatch?.[1] ?? null
}

/**
 * Parse version from pyproject.toml.
 * Checks multiple locations:
 * - [project] version = "x.y.z"
 * - [tool.poetry] version = "x.y.z"
 */
function parsePyprojectVersion(content: string): string | null {
  // Try [project] section first (PEP 621)
  const projectSection = content.match(/\[project\]([\s\S]*?)(?=\n\[|\n*$)/)
  if (projectSection) {
    const versionMatch = projectSection[1].match(/^\s*version\s*=\s*"([^"]+)"/m)
    if (versionMatch) return versionMatch[1]
  }

  // Try [tool.poetry] section
  const poetrySection = content.match(/\[tool\.poetry\]([\s\S]*?)(?=\n\[|\n*$)/)
  if (poetrySection) {
    const versionMatch = poetrySection[1].match(/^\s*version\s*=\s*"([^"]+)"/m)
    if (versionMatch) return versionMatch[1]
  }

  return null
}

/**
 * Parse version from a .csproj XML file.
 * Looks for <Version>x.y.z</Version>.
 */
function parseCsprojVersion(content: string): string | null {
  const match = content.match(/<Version>([^<]+)<\/Version>/)
  return match?.[1]?.trim() ?? null
}
