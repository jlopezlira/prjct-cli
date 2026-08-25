/**
 * Verify commands read from the project's OWN CI — the language-agnostic path.
 *
 * A hardcoded per-ecosystem table can only ever know the languages someone
 * taught it, so a Swift / Haskell / Zig / Scala / next-year's-language repo
 * would get a vacuous gauntlet. But every serious repo already writes down the
 * exact commands it gates on, in a file, in a language-independent format: its
 * CI config. `swift test`, `stack test`, `zig build test`, `sbt test` — all of
 * them are just shell lines in a workflow. Reading them needs no knowledge of
 * the language at all, which is what makes this the general mechanism and the
 * manifest table merely a fast path.
 *
 * Deliberately a line-scanner, not a YAML parser: the goal is to lift shell
 * lines out of `run:` / `script:` blocks, and pulling in a YAML dependency to
 * do that would add supply-chain surface for no gain. Anything ambiguous is
 * dropped — a missed command degrades to "unverified", while a wrong one would
 * run arbitrary CI plumbing on a developer's machine.
 */

import path from 'node:path'
import { fileExists, readFile } from '../utils/file-helper'
import type { VerifiedCommandKind } from './project-command-facts'

const CI_FILES = [
  '.gitlab-ci.yml',
  '.circleci/config.yml',
  'azure-pipelines.yml',
  '.travis.yml',
] as const
const GITHUB_WORKFLOW_DIR = '.github/workflows'
const MAX_FILE_BYTES = 256 * 1024
const MAX_COMMANDS_SCANNED = 400

/** Verification intent per kind. First match wins, so order is significant. */
const KIND_PATTERNS: ReadonlyArray<{ kind: VerifiedCommandKind; pattern: RegExp }> = [
  { kind: 'typecheck', pattern: /\b(typecheck|type-check|tsc\b|mypy|pyright|cargo check)\b/i },
  {
    kind: 'lint',
    pattern: /\b(lint|clippy|rubocop|eslint|biome|ruff|golangci|go vet|checkstyle|ktlint)\b/i,
  },
  { kind: 'test', pattern: /\b(test|spec|pytest|rspec|jest|vitest|phpunit|junit|xunit)\b/i },
]

/**
 * Never execute these on a developer machine, even though CI does: they
 * publish, deploy, mutate the environment, or pipe the network into a shell.
 */
const FORBIDDEN = [
  /\b(deploy|publish|release|push|upload|login|auth)\b/i,
  /\b(rm|sudo|chmod|chown|kill|shutdown|reboot)\b/i,
  /\b(curl|wget)\b[^|]*\|/i, // curl … | sh
  /\b(apt-get|brew install|npm i(nstall)?\b|yarn add|pip install|gem install|go install)\b/i,
  /\b(docker|kubectl|helm|terraform|aws|gcloud|az)\b/i,
  /\$\{\{/, // unresolved CI template expression — not a runnable command
  /\b(secrets|token|password)\b/i,
  />>|>\s*\/|&&\s*rm\b/, // redirection into files / chained removal
]

/**
 * The kind is already decided by the label or the command; this only decides
 * whether the line is SAFE to execute on a developer machine. Nothing that
 * deploys, installs, or pipes the network into a shell is ever lifted.
 */
function isRunnableVerifyCommand(raw: string, _kind: VerifiedCommandKind): boolean {
  const command = raw.trim()
  if (command.length < 3 || command.length > 300) return false
  if (command.startsWith('#')) return false
  return !FORBIDDEN.some((pattern) => pattern.test(command))
}

/**
 * The step/job LABEL is the language-independent signal: a workflow step named
 * "Lint" is a lint step whether it runs clippy, credo, ktlint or something
 * invented next year. Matching the command text is only the fallback, because
 * that degenerates into keeping a list of every tool name in existence — the
 * exact whack-a-mole this module exists to avoid.
 */
function classify(command: string, label: string | null): VerifiedCommandKind | null {
  const fromLabel = label
    ? (KIND_PATTERNS.find(({ pattern }) => pattern.test(label))?.kind ?? null)
    : null
  return fromLabel ?? KIND_PATTERNS.find(({ pattern }) => pattern.test(command))?.kind ?? null
}

/**
 * Lift shell lines out of `run:` (GitHub/CircleCI) and `script:` (GitLab,
 * Travis) blocks, including their `|` / `>` multiline and `- ` list forms.
 */
interface ExtractedCommand {
  command: string
  /** Nearest enclosing step name or job key — the kind signal that is language-free. */
  label: string | null
}

function extractShellLines(content: string): ExtractedCommand[] {
  const lines = content.split('\n')
  const out: ExtractedCommand[] = []
  // blockIndent: inside an open run/script body, collected until dedent.
  // label: nearest `name:` (GitHub/Azure step) or top-level job key (GitLab).
  const state: { blockIndent: number | null; label: string | null } = {
    blockIndent: null,
    label: null,
  }

  for (const line of lines) {
    if (out.length >= MAX_COMMANDS_SCANNED) break
    const indent = line.search(/\S/)
    if (indent === -1) continue
    const trimmed = line.trim()

    if (state.blockIndent !== null) {
      if (indent > state.blockIndent) {
        out.push({ command: trimmed.replace(/^-\s+/, ''), label: state.label })
        continue
      }
      state.blockIndent = null
    }

    // Step name (GitHub Actions, Azure) — the label for the commands that follow.
    const stepName = /^-?\s*(?:name|displayName)\s*:\s*(.+)$/.exec(trimmed)
    if (stepName?.[1]) {
      state.label = stepName[1].replace(/^["']|["']$/g, '').trim()
      continue
    }
    // Top-level job key (GitLab, CircleCI): `lint:` / `test:` / `verify:`.
    if (indent === 0) {
      const jobKey = /^([A-Za-z][\w .-]*)\s*:\s*$/.exec(trimmed)
      if (jobKey?.[1]) state.label = jobKey[1].trim()
    }

    // `run: |`, `script: |`, `run: >` → body follows, indented
    if (/^-?\s*(?:run|script|commands)\s*:\s*[|>][-+]?\s*$/.test(trimmed)) {
      state.blockIndent = indent
      continue
    }
    // `script:` / `commands:` followed by a `- cmd` list
    if (/^-?\s*(?:script|commands)\s*:\s*$/.test(trimmed)) {
      state.blockIndent = indent
      continue
    }
    // `run: cmd` on one line
    const inline = /^-?\s*(?:run|script)\s*:\s*(.+)$/.exec(trimmed)
    if (inline?.[1]) {
      out.push({ command: inline[1].replace(/^["']|["']$/g, '').trim(), label: state.label })
    }
  }
  return out
}

async function ciFilePaths(projectPath: string): Promise<string[]> {
  const found: string[] = []
  for (const rel of CI_FILES) {
    const full = path.join(projectPath, rel)
    if (await fileExists(full)) found.push(full)
  }
  try {
    const fs = await import('node:fs/promises')
    const dir = path.join(projectPath, GITHUB_WORKFLOW_DIR)
    const entries = await fs.readdir(dir)
    for (const entry of entries) {
      if (entry.endsWith('.yml') || entry.endsWith('.yaml')) found.push(path.join(dir, entry))
    }
  } catch {
    /* no GitHub workflows */
  }
  return found
}

export interface CiVerifyCommand {
  kind: VerifiedCommandKind
  command: string
  /** CI file the command was lifted from — provenance for the receipt. */
  source: string
}

/**
 * Verify commands this repo already gates on in CI, whatever language it is.
 * Returns at most one per kind (the first, i.e. the earliest CI step).
 */
export async function detectCiVerifyCommands(projectPath: string): Promise<CiVerifyCommand[]> {
  const byKind = new Map<VerifiedCommandKind, CiVerifyCommand>()
  for (const file of await ciFilePaths(projectPath)) {
    const content = await readFile(file, '')
    if (!content || content.length > MAX_FILE_BYTES) continue
    for (const { command: raw, label } of extractShellLines(content)) {
      const kind = classify(raw, label)
      if (!kind || byKind.has(kind)) continue
      if (!isRunnableVerifyCommand(raw, kind)) continue
      byKind.set(kind, { kind, command: raw.trim(), source: path.relative(projectPath, file) })
    }
  }
  return [...byKind.values()]
}
