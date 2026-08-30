/**
 * One-breath install ritual — Dynasty D6 / E1.
 *
 * Product surface: one command wires all detected runtimes, prints organic
 * board + harness Δ proof. Pure formatter — install.ts owns side effects.
 */

export interface OneBreathStep {
  id: string
  label: string
  status: 'done' | 'skip' | 'partial'
  detail: string
}

export interface OneBreathReport {
  title: string
  steps: OneBreathStep[]
  line: string
  md: string
  organicOk: boolean
}

/**
 * Build the public install ritual summary after wiring.
 */
export function buildOneBreathReport(input: {
  claudeHooksNew: number
  claudeHooksPresent: number
  runtimesWired: string[]
  liveCount: number
  detectedCount: number
  organicPct: number
  /** From computeHarnessDelta().line */
  deltaLine?: string | null
}): OneBreathReport {
  const steps: OneBreathStep[] = [
    {
      id: 'detect',
      label: 'Detect runtimes',
      status: input.detectedCount > 0 ? 'done' : 'skip',
      detail:
        input.detectedCount > 0
          ? `${input.detectedCount} host(s) on this machine`
          : 'no agent CLIs detected (hooks still installed for Claude path)',
    },
    {
      id: 'wire',
      label: 'Wire hooks + MCP + skills',
      status:
        input.claudeHooksNew + input.claudeHooksPresent > 0
          ? input.runtimesWired.length > 0
            ? 'done'
            : 'partial'
          : 'partial',
      detail:
        `Claude hooks +${input.claudeHooksNew}/~${input.claudeHooksPresent}` +
        (input.runtimesWired.length
          ? ` · adapters: ${input.runtimesWired.join(', ')}`
          : ' · multi-runtime: none detected'),
    },
    {
      id: 'surface',
      label: 'Project surface',
      status: 'skip',
      detail:
        'repo stays clean — prjct never writes AGENTS.md / CLAUDE.md / PRJCT.md / IDE rules into the client repository',
    },
    {
      id: 'board',
      label: 'Organic multi-runtime board',
      status:
        input.detectedCount === 0
          ? 'skip'
          : input.liveCount >= Math.min(2, input.detectedCount)
            ? 'done'
            : 'partial',
      detail: `${input.liveCount}/${input.detectedCount} live (${input.organicPct}%)`,
    },
    {
      id: 'proof',
      label: 'Harness Δ proof',
      status: input.deltaLine ? 'done' : 'skip',
      detail: input.deltaLine ?? 'run `bun run demo:weak-vs-frontier`',
    },
  ]

  const organicOk = input.detectedCount === 0 || input.liveCount >= Math.min(2, input.detectedCount)
  const mark = (s: OneBreathStep['status']) => (s === 'done' ? '✓' : s === 'partial' ? '△' : '·')
  const line = `One-breath install: organic ${input.liveCount}/${input.detectedCount} (${input.organicPct}%) · wired [${input.runtimesWired.join(', ') || 'claude'}] · ${organicOk ? 'PASS' : 'NEEDS doctor --fix'}`

  const md = [
    '# One-breath install',
    '',
    'Detect → wire all surfaces → organic board → proof. Zero multi-install ceremony.',
    '',
    '| Step | Status | Detail |',
    '|---|:---:|---|',
    ...steps.map((s) => `| ${s.label} | ${mark(s.status)} | ${s.detail} |`),
    '',
    `**${line}**`,
    '',
    '_Dynasty: one install · one SQLite brain · every agent compounds. Never re-learn the OS._',
    '',
  ].join('\n')

  return {
    title: 'One-breath install',
    steps,
    line,
    md,
    organicOk,
  }
}
