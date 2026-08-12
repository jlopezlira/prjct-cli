import {
  type InstructionFailureGroup,
  type InstructionFailureOpenCase,
  instructionFailureStorage,
} from '../storage/instruction-failure-storage'

export const INSTRUCTION_REPORT_WINDOWS = ['24h', '7d', '14d', '30d'] as const
export type InstructionReportWindow = (typeof INSTRUCTION_REPORT_WINDOWS)[number]
export type InstructionReportState = 'no-observability' | 'zero-failures' | 'failures-observed'

export interface InstructionFailureReport {
  window: InstructionReportWindow
  since: string
  state: InstructionReportState
  total: number
  attributed: number
  attributionRate: number
  open: number
  resolved: number
  falsePositive: number
  falseTriggerRate: number
  observedSessions: number
  attributedSessions: number
  sessionAttributionRate: number
  legacyUnattributedInputs: number
  guidanceActivations: number
  groups: InstructionFailureGroup[]
  unresolved: InstructionFailureOpenCase[]
}

const WINDOW_MS: Record<InstructionReportWindow, number> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '14d': 14 * 86_400_000,
  '30d': 30 * 86_400_000,
}

export function parseInstructionReportWindow(
  value: string | null | undefined
): InstructionReportWindow {
  const candidate = value ?? '7d'
  if (INSTRUCTION_REPORT_WINDOWS.some((window) => window === candidate)) {
    return candidate as InstructionReportWindow
  }
  throw new Error(
    `Invalid instruction window: ${candidate}. Use ${INSTRUCTION_REPORT_WINDOWS.join('|')}.`
  )
}

export function buildInstructionFailureReport(
  projectId: string,
  window: InstructionReportWindow,
  options: { now?: Date } = {}
): InstructionFailureReport {
  const now = options.now ?? new Date()
  const since = new Date(now.getTime() - WINDOW_MS[window])
  const stats = instructionFailureStorage.getWindowStats(projectId, since)
  const state: InstructionReportState =
    stats.total > 0
      ? 'failures-observed'
      : stats.observedSessions > 0
        ? 'zero-failures'
        : 'no-observability'
  return {
    window,
    since: since.toISOString(),
    state,
    total: stats.total,
    attributed: stats.attributed,
    attributionRate: stats.total > 0 ? stats.attributed / stats.total : 0,
    open: stats.open,
    resolved: stats.resolved,
    falsePositive: stats.falsePositive,
    // Deliberately single-stream: falsePositive and total both come from
    // instruction_failures. guidanceActivations is a DIFFERENT event stream
    // (core/hooks/prompt.ts logging every time delivery/process-safety
    // guidance text was shown) with no shared id linking a given activation
    // to a given recorded failure — dividing across the two streams
    // produced a coincidental ratio, not a real false-positive rate (see
    // 2026-08-12 security/perf review). This is precision-style: of the
    // failures we actually recorded and later dispositioned in this
    // window, what fraction turned out to be false positives.
    falseTriggerRate: stats.total > 0 ? stats.falsePositive / stats.total : 0,
    observedSessions: stats.observedSessions,
    attributedSessions: stats.attributedSessions,
    sessionAttributionRate:
      stats.observedSessions > 0 ? stats.attributedSessions / stats.observedSessions : 0,
    legacyUnattributedInputs: stats.legacyUnattributedInputs,
    guidanceActivations: stats.guidanceActivations,
    groups: stats.groups,
    unresolved: stats.unresolved,
  }
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`

export function renderInstructionFailureReportMd(report: InstructionFailureReport): string {
  const stateLine =
    report.state === 'no-observability'
      ? 'No observed sessions in this window; zero failures would not be meaningful yet.'
      : report.state === 'zero-failures'
        ? `Observed ${report.observedSessions} session(s) and found 0 instruction failures.`
        : `Found ${report.total} instruction failure(s) across ${report.observedSessions} observed session(s).`
  const rows =
    report.groups.length === 0
      ? '_No grouped failures._'
      : [
          '| Runtime | Model | Category | Total | Open | Resolved | False positive |',
          '|---|---|---|---:|---:|---:|---:|',
          ...report.groups.map(
            (group) =>
              `| ${group.runtime} | ${group.model} | ${group.category} | ${group.total} | ${group.open} | ${group.resolved} | ${group.falsePositive} |`
          ),
        ].join('\n')
  const unresolved =
    report.unresolved.length === 0
      ? '_No unresolved cases._'
      : report.unresolved
          .map(
            (entry) =>
              `- \`${entry.id}\` ${entry.runtime}/${entry.model} · ${entry.category}${
                entry.relatedRuleId ? ` · rule \`${entry.relatedRuleId}\`` : ''
              }: ${entry.observedBehavior}`
          )
          .join('\n')
  return `# Instruction guidance report (${report.window})

${stateLine}

- Total: ${report.total}
- Attributed: ${report.attributed} (${pct(report.attributionRate)})
- Session attribution: ${report.attributedSessions}/${report.observedSessions} (${pct(report.sessionAttributionRate)})
- Open: ${report.open}
- Resolved: ${report.resolved}
- False positive: ${report.falsePositive}
- Guidance activations: ${report.guidanceActivations}
- False-trigger rate: ${pct(report.falseTriggerRate)}
- Legacy unattributed inputs: ${report.legacyUnattributedInputs}

## Groups

${rows}

## Open cases

${unresolved}`
}
