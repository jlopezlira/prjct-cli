/**
 * Minimal shell lexer for command-position safety checks. Quoted text stays
 * inside its argument, while unquoted shell separators begin a new command.
 *
 * Two constructs must be handled before tokenizing, or "command position"
 * comes out wrong and the caller denies benign commands:
 *
 *   - **Heredoc bodies.** `python3 - <<'EOF' … EOF` puts arbitrary text on the
 *     following lines. Lexed naively, every body line parses as its own
 *     command and its words land in command position.
 *   - **Command substitution.** `OUT=$(echo "$X")` is a single assignment, not
 *     an env-prefixed command. Stripping the `OUT=` prefix (which is correct
 *     for `FOO=bar cmd`) promoted the *inner* command's arguments to command
 *     position, so any `$` among them read as an unresolved executable.
 *
 * Both are resolved by preparing the source first: heredoc bodies are dropped,
 * and each substitution is lifted out to be lexed as its own command list while
 * the outer token keeps an opaque `$()` / backtick marker. The marker still
 * carries the `$`/backtick, so a substitution that genuinely sits in command
 * position (`$(echo pkill) -f node`) still reads as unresolved.
 */
interface ShellLexState {
  commands: string[][]
  args: string[]
  token: string
  quote: "'" | '"' | null
  escaped: boolean
  skipSeparatorTwin: boolean
}

function commitToken(state: ShellLexState): void {
  if (!state.token) return
  state.args.push(state.token)
  state.token = ''
}

function commitCommand(state: ShellLexState): void {
  commitToken(state)
  if (state.args.length === 0) return
  state.commands.push(state.args)
  state.args = []
}

/** Heredoc opener: `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`. Not `<<<`. */
const HEREDOC_OPENER = /<<-?(?!<)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g

/**
 * Drop heredoc BODIES, keeping the opener line (which holds the real command).
 * Without this the body is lexed as commands and its words reach command
 * position — a quoted `<<'EOF'` body is inert text to the shell, never code.
 */
function stripHeredocBodies(source: string): string {
  const lines = source.split('\n')
  const state = { kept: [] as string[], pending: null as string | null }
  for (const line of lines) {
    if (state.pending !== null) {
      if (line.trim() === state.pending) state.pending = null
      continue
    }
    state.kept.push(line)
    HEREDOC_OPENER.lastIndex = 0
    const delimiters = [...line.matchAll(HEREDOC_OPENER)].map((m) => m[2])
    // Multiple heredocs on one line read in order; the first delimiter ends
    // the first body. Tracking one is enough to skip past inert text.
    state.pending = delimiters[0] ?? null
  }
  return state.kept.join('\n')
}

/** Index just past the `)` closing a `$(` at `open`, or -1 when unterminated. */
function closingParen(source: string, open: number): number {
  const state = { i: open + 2, depth: 1, quote: null as "'" | '"' | null, escaped: false }
  while (state.i < source.length) {
    const char = source[state.i]!
    state.i += 1
    if (state.escaped) {
      state.escaped = false
      continue
    }
    if (char === '\\' && state.quote !== "'") {
      state.escaped = true
      continue
    }
    if (state.quote) {
      if (char === state.quote) state.quote = null
      continue
    }
    if (char === "'" || char === '"') {
      state.quote = char
      continue
    }
    if (char === '(') state.depth += 1
    else if (char === ')') {
      state.depth -= 1
      if (state.depth === 0) return state.i
    }
  }
  return -1
}

/** Index just past the backtick closing the one at `open`, or -1. */
function closingBacktick(source: string, open: number): number {
  const state = { i: open + 1, escaped: false }
  while (state.i < source.length) {
    const char = source[state.i]!
    state.i += 1
    if (state.escaped) {
      state.escaped = false
      continue
    }
    if (char === '\\') {
      state.escaped = true
      continue
    }
    if (char === '`') return state.i
  }
  return -1
}

interface SubstitutionSplit {
  /** Source with each substitution replaced by an opaque marker. */
  outer: string
  /** The substituted command text, to be lexed as commands of its own. */
  inner: string[]
}

/**
 * Lift `$(…)` and backtick substitutions out of `source`. Single-quoted text is
 * literal, so nothing is lifted from it. The marker keeps the `$`/backtick so a
 * substitution in command position still classifies as unresolved.
 */
function splitSubstitutions(source: string): SubstitutionSplit {
  const state = {
    i: 0,
    outer: '',
    inner: [] as string[],
    quote: null as "'" | '"' | null,
    escaped: false,
  }
  while (state.i < source.length) {
    const char = source[state.i]!
    if (state.escaped) {
      state.outer += char
      state.escaped = false
      state.i += 1
      continue
    }
    if (char === '\\' && state.quote !== "'") {
      state.outer += char
      state.escaped = true
      state.i += 1
      continue
    }
    if (state.quote === "'") {
      if (char === "'") state.quote = null
      state.outer += char
      state.i += 1
      continue
    }
    if (char === "'" || char === '"') {
      state.quote = state.quote === char ? null : (state.quote ?? char)
      state.outer += char
      state.i += 1
      continue
    }
    if (char === '$' && source[state.i + 1] === '(') {
      const end = closingParen(source, state.i)
      if (end > 0) {
        state.inner.push(source.slice(state.i + 2, end - 1))
        state.outer += '$()'
        state.i = end
        continue
      }
    }
    if (char === '`') {
      const end = closingBacktick(source, state.i)
      if (end > 0) {
        state.inner.push(source.slice(state.i + 1, end - 1))
        state.outer += '``'
        state.i = end
        continue
      }
    }
    state.outer += char
    state.i += 1
  }
  return { outer: state.outer, inner: state.inner }
}

export function shellCommands(source: string): string[][] {
  const { outer, inner } = splitSubstitutions(stripHeredocBodies(source))
  return [...tokenizeCommands(outer), ...inner.flatMap((text) => shellCommands(text))]
}

function tokenizeCommands(source: string): string[][] {
  const state: ShellLexState = {
    commands: [],
    args: [],
    token: '',
    quote: null,
    escaped: false,
    skipSeparatorTwin: false,
  }
  const characters = [...source]
  characters.forEach((char, index) => {
    if (state.skipSeparatorTwin) {
      state.skipSeparatorTwin = false
      return
    }
    if (state.escaped) {
      state.token += char
      state.escaped = false
      return
    }
    if (char === '\\' && state.quote !== "'") {
      state.escaped = true
      return
    }
    if (state.quote) {
      if (char === state.quote) state.quote = null
      else state.token += char
      return
    }
    if (char === "'" || char === '"') {
      state.quote = char
      return
    }
    if (/\s/.test(char)) {
      commitToken(state)
      if (char === '\n') commitCommand(state)
      return
    }
    if (char === ';' || char === '|' || char === '&') {
      commitCommand(state)
      state.skipSeparatorTwin = (char === '|' || char === '&') && characters[index + 1] === char
      return
    }
    state.token += char
  })
  commitCommand(state)
  return state.commands
}

const ENV_OPTIONS_WITH_VALUE = new Set(['-u', '--unset', '-C', '--chdir'])
/** Short option letters that take a value — for resolving combined clusters like `-Eu root` (only the LAST letter in a cluster can carry the value). */
const ENV_SHORT_VALUE_LETTERS = new Set(['u', 'C'])
const SUDO_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '--close-from',
  '-D',
  '--chdir',
  '-g',
  '--group',
  '-h',
  '--host',
  '-p',
  '--prompt',
  '-R',
  '--chroot',
  '-r',
  '--role',
  '-T',
  '--command-timeout',
  '-t',
  '--type',
  '-u',
  '--user',
])
const SUDO_SHORT_VALUE_LETTERS = new Set(['C', 'D', 'g', 'h', 'p', 'R', 'r', 'T', 't', 'u'])

/**
 * Discard a wrapper's leading options. Handles combined short-flag clusters
 * (`-Eu root`) correctly — getopt-style, only the LAST letter in a cluster
 * can take a value — not just exact single-flag matches, which previously
 * mis-parsed `-Eu` as a no-value flag and left its value ("root") to be
 * misread as the wrapped command itself.
 */
function discardWrapperOptions(
  remaining: string[],
  optionsWithValue: Set<string>,
  shortValueLetters: Set<string> = new Set()
): void {
  while (remaining[0]?.startsWith('-')) {
    const option = remaining.shift()!
    if (option === '--') return
    if (optionsWithValue.has(option)) {
      remaining.shift()
      continue
    }
    const isLongOption = option.startsWith('--')
    const lastLetter = option.at(-1)
    if (!isLongOption && lastLetter && shortValueLetters.has(lastLetter)) {
      remaining.shift()
    }
  }
}

export function unwrapCommand(args: string[]): string[] {
  const remaining = [...args]
  while (remaining.length > 0) {
    const command = remaining[0]!
    const wrapper = command.split('/').at(-1)?.toLowerCase()
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command)) {
      remaining.shift()
    } else if (wrapper === 'sudo') {
      remaining.shift()
      discardWrapperOptions(remaining, SUDO_OPTIONS_WITH_VALUE, SUDO_SHORT_VALUE_LETTERS)
    } else if (wrapper === 'env') {
      remaining.shift()
      discardWrapperOptions(remaining, ENV_OPTIONS_WITH_VALUE, ENV_SHORT_VALUE_LETTERS)
      while (remaining[0]?.includes('=')) remaining.shift()
    } else if (wrapper === 'command') {
      remaining.shift()
      if (remaining[0] === '-v' || remaining[0] === '-V') return []
      discardWrapperOptions(remaining, new Set())
    } else if (wrapper === 'nohup') {
      remaining.shift()
      discardWrapperOptions(remaining, new Set())
    } else {
      return remaining
    }
  }
  return remaining
}
