/**
 * Verified project command facts — language-agnostic. Reads real evidence
 * per ecosystem (package.json `scripts`, Cargo.toml/go.mod presence,
 * pyproject.toml tool sections, pom.xml/build.gradle, Gemfile+.rspec,
 * composer.json+phpunit.xml, *.csproj/*.sln, mix.exs, Makefile targets)
 * so downstream consumers (PRJCT.md,
 * `prjct context project --md`, the `prjct_project_facts` MCP tool) can
 * quote commands that actually exist — never guessed by lockfile presence
 * the way `sync-analyzer.ts`'s `detectCommands` does. Inspection only —
 * nothing here executes a command (contrast with `health.ts`'s
 * `runDimension`).
 *
 * Node projects can name scripts anything, so their commands are read
 * directly from `package.json`. Cargo/Go standardize their toolchain
 * commands (`cargo test`, `go build ./...`, …), so the manifest's mere
 * presence *is* the evidence — no guessing which command name the author
 * chose, because the toolchain itself defines it. Python has no single
 * standard runner, so commands are only offered when `pyproject.toml`
 * actually configures that tool (a real `[tool.pytest]`/`[tool.ruff]`/etc.
 * section), never assumed from the ecosystem alone.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileExists, readFile, readJson } from '../utils/file-helper'
import { shellCommands, unwrapCommand } from './shell-lexer'

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

export type VerifiedCommandKind = 'test' | 'lint' | 'build' | 'dev' | 'typecheck' | 'format'

export interface VerifiedCommand {
  scriptName: string
  command: string
  kind: VerifiedCommandKind
  mutating: boolean
}

export interface VerifiedCommandFacts {
  packageManager: string | null
  commands: VerifiedCommand[]
}

// NODE — script names are author-chosen, so only real, existing scripts count.

/** package.json script names we recognize, mirroring health.ts's KNOWN_DIMENSIONS style. */
const KNOWN_NODE_SCRIPT_NAMES: ReadonlyArray<{ scriptName: string; kind: VerifiedCommandKind }> = [
  { scriptName: 'typecheck', kind: 'typecheck' },
  { scriptName: 'lint', kind: 'lint' },
  { scriptName: 'test', kind: 'test' },
  { scriptName: 'build', kind: 'build' },
  { scriptName: 'dev', kind: 'dev' },
  { scriptName: 'format', kind: 'format' },
]

const LOCKFILE_PACKAGE_MANAGERS: ReadonlyArray<{ file: string; manager: string }> = [
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
]

async function detectPackageManager(projectPath: string): Promise<string | null> {
  for (const { file, manager } of LOCKFILE_PACKAGE_MANAGERS) {
    if (await fileExists(path.join(projectPath, file))) return manager
  }
  return null
}

async function detectNodeCommands(projectPath: string): Promise<VerifiedCommand[]> {
  const pkgPath = path.join(projectPath, 'package.json')
  if (!(await fileExists(pkgPath))) return []
  const pkg = await readJson<{ scripts?: Record<string, string> }>(pkgPath, null)
  const scripts = pkg?.scripts ?? {}
  return KNOWN_NODE_SCRIPT_NAMES.filter(({ scriptName }) => Boolean(scripts[scriptName])).map(
    ({ scriptName, kind }) => {
      const command = scripts[scriptName]!
      return { scriptName, command, kind, mutating: classifyCommandMutation(command) }
    }
  )
}

// CARGO / GO — the toolchain standardizes these commands; the manifest's
// presence is the evidence, not a guess about author-chosen script names.
// `mutating` is set from known toolchain semantics, not pattern-matched —
// e.g. `cargo fmt` rewrites in place by default with no flag present.

async function detectCargoCommands(projectPath: string): Promise<VerifiedCommand[]> {
  if (!(await fileExists(path.join(projectPath, 'Cargo.toml')))) return []
  return [
    { scriptName: 'typecheck', command: 'cargo check', kind: 'typecheck', mutating: false },
    { scriptName: 'test', command: 'cargo test', kind: 'test', mutating: false },
    { scriptName: 'build', command: 'cargo build', kind: 'build', mutating: false },
    { scriptName: 'lint', command: 'cargo clippy', kind: 'lint', mutating: false },
    { scriptName: 'format', command: 'cargo fmt', kind: 'format', mutating: true },
  ]
}

async function detectGoCommands(projectPath: string): Promise<VerifiedCommand[]> {
  if (!(await fileExists(path.join(projectPath, 'go.mod')))) return []
  return [
    { scriptName: 'test', command: 'go test ./...', kind: 'test', mutating: false },
    { scriptName: 'build', command: 'go build ./...', kind: 'build', mutating: false },
    // `go vet` ships with the toolchain — the standard read-only correctness pass.
    { scriptName: 'lint', command: 'go vet ./...', kind: 'lint', mutating: false },
    // `gofmt -l` only lists files that need formatting — read-only, unlike `go fmt ./...`.
    { scriptName: 'format', command: 'gofmt -l .', kind: 'format', mutating: false },
  ]
}

// JVM / .NET / RUBY / PHP / ELIXIR / MAKE — same evidence rule: a command is
// offered only when this repo carries the manifest (or configured tool) that
// defines it. Wrapper scripts (`./gradlew`, `./mvnw`) win when present so the
// project's pinned toolchain runs, not whatever is on PATH.

async function detectMavenCommands(projectPath: string): Promise<VerifiedCommand[]> {
  if (!(await fileExists(path.join(projectPath, 'pom.xml')))) return []
  const mvn = (await fileExists(path.join(projectPath, 'mvnw'))) ? './mvnw' : 'mvn'
  return [
    { scriptName: 'test', command: `${mvn} -B test`, kind: 'test', mutating: false },
    {
      scriptName: 'build',
      command: `${mvn} -B -DskipTests package`,
      kind: 'build',
      mutating: false,
    },
  ]
}

async function detectGradleCommands(projectPath: string): Promise<VerifiedCommand[]> {
  const hasBuildFile =
    (await fileExists(path.join(projectPath, 'build.gradle'))) ||
    (await fileExists(path.join(projectPath, 'build.gradle.kts')))
  if (!hasBuildFile) return []
  const gradle = (await fileExists(path.join(projectPath, 'gradlew'))) ? './gradlew' : 'gradle'
  return [
    { scriptName: 'test', command: `${gradle} test`, kind: 'test', mutating: false },
    { scriptName: 'build', command: `${gradle} build -x test`, kind: 'build', mutating: false },
  ]
}

async function detectRubyCommands(projectPath: string): Promise<VerifiedCommand[]> {
  if (!(await fileExists(path.join(projectPath, 'Gemfile')))) return []
  const [hasRspec, hasRubocop] = await Promise.all([
    fileExists(path.join(projectPath, '.rspec')),
    fileExists(path.join(projectPath, '.rubocop.yml')),
  ])
  return [
    ...(hasRspec
      ? [
          {
            scriptName: 'test',
            command: 'bundle exec rspec',
            kind: 'test' as const,
            mutating: false,
          },
        ]
      : []),
    ...(hasRubocop
      ? [
          {
            scriptName: 'lint',
            command: 'bundle exec rubocop',
            kind: 'lint' as const,
            mutating: false,
          },
        ]
      : []),
  ]
}

async function detectPhpCommands(projectPath: string): Promise<VerifiedCommand[]> {
  if (!(await fileExists(path.join(projectPath, 'composer.json')))) return []
  const [hasPhpunit, hasPhpstan] = await Promise.all([
    fileExists(path.join(projectPath, 'phpunit.xml')),
    fileExists(path.join(projectPath, 'phpstan.neon')),
  ])
  return [
    ...(hasPhpunit
      ? [
          {
            scriptName: 'test',
            command: 'vendor/bin/phpunit',
            kind: 'test' as const,
            mutating: false,
          },
        ]
      : []),
    ...(hasPhpstan
      ? [
          {
            scriptName: 'typecheck',
            command: 'vendor/bin/phpstan analyse',
            kind: 'typecheck' as const,
            mutating: false,
          },
        ]
      : []),
  ]
}

async function detectDotnetCommands(projectPath: string): Promise<VerifiedCommand[]> {
  const entries = await readdirSafe(projectPath)
  const hasProject = entries.some((f) => f.endsWith('.sln') || f.endsWith('.csproj'))
  if (!hasProject) return []
  return [
    { scriptName: 'test', command: 'dotnet test', kind: 'test', mutating: false },
    { scriptName: 'build', command: 'dotnet build', kind: 'build', mutating: false },
  ]
}

async function detectElixirCommands(projectPath: string): Promise<VerifiedCommand[]> {
  if (!(await fileExists(path.join(projectPath, 'mix.exs')))) return []
  return [
    { scriptName: 'test', command: 'mix test', kind: 'test', mutating: false },
    {
      scriptName: 'typecheck',
      command: 'mix compile --warnings-as-errors',
      kind: 'typecheck',
      mutating: false,
    },
  ]
}

/**
 * Make is the catch-all for everything without a package manifest (C/C++,
 * Zig, embedded, polyglot monorepos): a target only counts when the Makefile
 * actually declares it, so this never invents a command.
 */
const MAKE_TARGETS: ReadonlyArray<{ target: string; kind: VerifiedCommandKind }> = [
  { target: 'test', kind: 'test' },
  { target: 'lint', kind: 'lint' },
  { target: 'check', kind: 'typecheck' },
]

async function detectMakeCommands(projectPath: string): Promise<VerifiedCommand[]> {
  const makefile = path.join(projectPath, 'Makefile')
  if (!(await fileExists(makefile))) return []
  const content = await readFile(makefile, '')
  return MAKE_TARGETS.filter(({ target }) => new RegExp(`^${target}\\s*:`, 'm').test(content)).map(
    ({ target, kind }) => ({
      scriptName: target,
      command: `make ${target}`,
      kind,
      mutating: false,
    })
  )
}

// PYTHON — no single standard runner, so a command is only offered when
// pyproject.toml actually configures that tool (a real `[tool.x]` section),
// never assumed from Python's presence alone.

const PYTHON_TOOL_SECTIONS: ReadonlyArray<{
  marker: RegExp
  scriptName: string
  command: string
  kind: VerifiedCommandKind
  mutating: boolean
}> = [
  {
    marker: /\[tool\.pytest\b/,
    scriptName: 'test',
    command: 'pytest',
    kind: 'test',
    mutating: false,
  },
  {
    marker: /\[tool\.ruff\b/,
    scriptName: 'lint',
    command: 'ruff check .',
    kind: 'lint',
    mutating: false,
  },
  {
    marker: /\[tool\.black\b/,
    scriptName: 'format',
    command: 'black .',
    kind: 'format',
    mutating: true,
  },
  {
    marker: /\[tool\.mypy\b/,
    scriptName: 'typecheck',
    command: 'mypy .',
    kind: 'typecheck',
    mutating: false,
  },
]

async function detectPythonCommands(projectPath: string): Promise<VerifiedCommand[]> {
  const pyprojectPath = path.join(projectPath, 'pyproject.toml')
  if (!(await fileExists(pyprojectPath))) return []
  const content = await readFile(pyprojectPath, '')
  return PYTHON_TOOL_SECTIONS.filter(({ marker }) => marker.test(content)).map(
    ({ marker: _marker, ...cmd }) => cmd
  )
}

/** Detect verified commands across every ecosystem with real evidence in the repo. */
export async function detectVerifiedCommands(projectPath: string): Promise<VerifiedCommandFacts> {
  const [node, cargo, go, python, maven, gradle, ruby, php, dotnet, elixir, make, packageManager] =
    await Promise.all([
      detectNodeCommands(projectPath),
      detectCargoCommands(projectPath),
      detectGoCommands(projectPath),
      detectPythonCommands(projectPath),
      detectMavenCommands(projectPath),
      detectGradleCommands(projectPath),
      detectRubyCommands(projectPath),
      detectPhpCommands(projectPath),
      detectDotnetCommands(projectPath),
      detectElixirCommands(projectPath),
      detectMakeCommands(projectPath),
      detectPackageManager(projectPath),
    ])
  return {
    packageManager,
    // Make last: a repo with both a manifest and a Makefile prefers the
    // ecosystem's own toolchain, and consumers take the first per kind.
    commands: [
      ...node,
      ...cargo,
      ...go,
      ...python,
      ...maven,
      ...gradle,
      ...ruby,
      ...php,
      ...dotnet,
      ...elixir,
      ...make,
    ],
  }
}

const MUTATING_FLAG_PATTERN = /^(?:--fix|--write|--update|-w|--fix-type)$/
const MUTATING_VERBS = new Set(['migrate', 'push', 'publish', 'deploy', 'release', 'commit'])

/**
 * Best-effort read-only vs. mutating classification for a raw shell command
 * string (used for Node's author-chosen script bodies). Default read-only;
 * a command is flagged mutating only when it carries a known mutation
 * signal (e.g. `--fix`, `--write`) or a known mutating verb (e.g.
 * `migrate`, `publish`). Metadata only — never used to gate execution.
 */
export function classifyCommandMutation(command: string): boolean {
  for (const rawArgs of shellCommands(command)) {
    const args = unwrapCommand(rawArgs)
    if (args.some((arg) => MUTATING_FLAG_PATTERN.test(arg))) return true
    if (args.some((arg) => MUTATING_VERBS.has(arg.toLowerCase()))) return true
  }
  return false
}
