/**
 * Minimal shell lexer for command-position safety checks. Quoted text stays
 * inside its argument, while unquoted shell separators begin a new command.
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

export function shellCommands(source: string): string[][] {
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
