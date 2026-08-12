/**
 * Verified project command facts — language-agnostic. Reads real evidence
 * per ecosystem (package.json `scripts`, Cargo.toml/go.mod presence,
 * pyproject.toml tool sections) so downstream consumers (PRJCT.md,
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

import path from 'node:path'
import { fileExists, readFile, readJson } from '../utils/file-helper'
import { shellCommands, unwrapCommand } from './shell-lexer'

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
    // `gofmt -l` only lists files that need formatting — read-only, unlike `go fmt ./...`.
    { scriptName: 'format', command: 'gofmt -l .', kind: 'format', mutating: false },
  ]
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
  const [node, cargo, go, python, packageManager] = await Promise.all([
    detectNodeCommands(projectPath),
    detectCargoCommands(projectPath),
    detectGoCommands(projectPath),
    detectPythonCommands(projectPath),
    detectPackageManager(projectPath),
  ])
  return { packageManager, commands: [...node, ...cargo, ...go, ...python] }
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
