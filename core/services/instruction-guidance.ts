/** Pure classifiers shared by hook enforcement and held-out instruction evals. */

import { shellCommands, unwrapCommand } from './shell-lexer'

export type DeliveryIntent = 'pr' | 'review' | 'ci-watch' | 'merge'

const DELIVERY_INTENT_MATCHERS: ReadonlyArray<{
  intent: DeliveryIntent
  patterns: readonly RegExp[]
}> = [
  {
    intent: 'review',
    patterns: [
      /\b(?:address|apply|handle|resolve|respond\s+to)\s+(?:the\s+)?(?:pr\s+)?review(?:\s+(?:feedback|comments?))?\b/i,
      /\breview\s+(?:feedback|comments?)\b/i,
    ],
  },
  {
    intent: 'ci-watch',
    patterns: [
      /\b(?:watch|monitor|babysit|follow)\s+(?:the\s+)?(?:ci|checks?|builds?)\b/i,
      /\bci\s+(?:watch|status|checks?)\b/i,
    ],
  },
  {
    intent: 'pr',
    patterns: [
      /\b(?:open|create|file|prepare|draft|update|write)\s+(?:an?\s+)?(?:pull\s+request|pr)\b/i,
      /\b(?:pull\s+request|pr)\s+(?:title|description)\b/i,
    ],
  },
  { intent: 'merge', patterns: [/\b(?:merge|merging|squash-merge)\b/i] },
]

export function classifyDeliveryIntent(prompt: string): DeliveryIntent | null {
  for (const matcher of DELIVERY_INTENT_MATCHERS) {
    if (matcher.patterns.some((pattern) => pattern.test(prompt))) return matcher.intent
  }
  return null
}

export function buildDeliveryGuidance(prompt: string): string | null {
  const intent = classifyDeliveryIntent(prompt)
  if (!intent) return null
  const scope =
    '- Keep the original goal/spec as the scope boundary; discovered work becomes `prjct capture "<work>" --fromCurrent`.'
  const specifics: Record<DeliveryIntent, readonly string[]> = {
    pr: [
      '- Use a human outcome title. Bad: "Refactor websocket transport". Good: "Cut websocket payload size by 70%".',
      '- Problem/why first, then solution; omit implementation inventories.',
    ],
    review: [
      '- Apply feedback only when it serves the original goal/spec; explain and capture out-of-scope requests separately.',
    ],
    'ci-watch': [
      '- Watch to a terminal result; distinguish a repository failure from an infrastructure flake before changing code or retrying.',
    ],
    merge: [
      '- Merge only with required checks green and current human approval; never bypass protections.',
    ],
  }
  return [`# prjct: delivery guidance (${intent})`, scope, ...specifics[intent]].join('\n')
}

const BROAD_TERMINATION_DENIAL =
  'prjct: denied broad process termination. Identify the exact numeric PID, verify the target, then use `kill <PID>` or `kill -TERM <PID>`.'

/** Command-position token whose identity is dynamically resolved ($VAR, $(...), `...`) — cannot be proven safe by a literal-string comparison. */
const UNRESOLVED_EXECUTABLE = /[$`]/

export function classifyBroadProcessTermination(command: string): boolean {
  for (const rawArgs of shellCommands(command)) {
    const args = unwrapCommand(rawArgs)
    const executableRaw = args[0]
    if (executableRaw === undefined) continue
    // Fail closed on obfuscated executable identity — e.g. `a=killall; $a -9
    // node` or `$(echo pkill) -f node` — rather than let substitution/
    // variable-expansion slip an otherwise-denied command past a literal
    // token comparison.
    if (UNRESOLVED_EXECUTABLE.test(executableRaw)) return true
    const executable = executableRaw.split('/').at(-1)?.toLowerCase()
    if (executable === 'killall') return true
    // Any `pkill` invocation matches by name/pattern across every process
    // that matches, the same "no single verified PID" blast radius as
    // killall — `-f` only changes WHAT it matches against (full command
    // line vs bare process name), not whether the termination is broad.
    if (executable === 'pkill') return true
    if (
      (executable === 'sh' || executable === 'bash' || executable === 'zsh') &&
      args.some((arg) => /^-[^-]*c/.test(arg))
    ) {
      const commandIndex = args.findIndex((arg) => /^-[^-]*c/.test(arg)) + 1
      if (commandIndex > 0 && classifyBroadProcessTermination(args[commandIndex] ?? '')) return true
    }
    if (executable === 'xargs') {
      const nestedName = (arg: string) => arg.split('/').at(-1)?.toLowerCase()
      if (args.some((arg) => nestedName(arg) === 'killall' || nestedName(arg) === 'pkill')) {
        return true
      }
      // xargs inherently applies its wrapped command to a LIST of inputs
      // (typically PIDs from `pgrep`/`ps|grep|awk`) — `xargs kill`/`xargs
      // kill -9` terminates every one of them without single-PID
      // verification, even though bare `kill <PID>` is the sanctioned path
      // on its own.
      if (args.some((arg) => nestedName(arg) === 'kill')) return true
    }
  }
  return false
}

export function broadProcessTerminationDenial(command: string): string | null {
  return classifyBroadProcessTermination(command) ? BROAD_TERMINATION_DENIAL : null
}
