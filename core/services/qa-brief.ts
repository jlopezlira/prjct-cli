/**
 * QA brief — the ONLY input a blind QA subagent receives. Information
 * asymmetry is the mechanism (same as the contradictory review): the plan,
 * how to reach the app, what the machine already verified, which browser
 * tool to use, and how to report. Never the author's transcript or diff.
 */

import type { QaPlan, QaReceipt } from '../schemas/qa'
import type { LocalConfig } from '../types/config'
import { flowVerified } from './qa-gate'

const BROWSER_MCP_HINTS: ReadonlyArray<{ match: RegExp; label: string }> = [
  {
    match: /playwright/i,
    label: 'Playwright MCP (browser_navigate / browser_click / browser_snapshot)',
  },
  { match: /chrome-?devtools|devtools/i, label: 'Chrome DevTools MCP' },
  { match: /puppeteer/i, label: 'Puppeteer MCP' },
  { match: /browser/i, label: 'the browser MCP declared for this project' },
]

const PRJCT_BROWSER_HINT =
  "prjct's own headless browser (no MCP needed): `prjct qa browser goto <url|/path>` · `fill <selector> <text>` · `click <selector>` · `text [selector]` · `screenshot [name]` · `close` — one session per project, relative paths resolve against the base URL"

export function browserToolHints(config: LocalConfig | null, browserInstalled = false): string[] {
  const mcps = config?.persona?.mcps ?? []
  const declared = mcps.flatMap((name) => {
    const hit = BROWSER_MCP_HINTS.find((h) => h.match.test(name))
    return hit ? [`${hit.label} (\`${name}\`)`] : []
  })
  const prjctBrowser = browserInstalled
    ? [PRJCT_BROWSER_HINT]
    : [
        'no browser tool at all? `prjct qa browser install` (one-time, under the prjct cache) then the `prjct qa browser …` primitives',
      ]
  if (declared.length > 0) return [...declared, ...prjctBrowser]
  return [
    'any browser tool your rig exposes (Playwright MCP, Chrome DevTools MCP, agent-browser, Claude in Chrome)',
    ...prjctBrowser,
    'API-only paths: `curl`/http; report `blocked` with the reason when a UI path cannot be driven',
  ]
}

export function buildQaBrief(input: {
  plan: QaPlan
  receipt: QaReceipt | null
  config: LocalConfig | null
  browserInstalled?: boolean
}): string {
  const { plan, receipt, config } = input
  const app = config?.qa?.app
  const pendingFlows = plan.flows.filter((f) => !flowVerified(f, 'strict'))
  const pendingCriteria = plan.criteria.filter(
    (c) => c.status !== 'met' || c.verifiedBy === 'author' || !c.verifiedBy
  )
  const machineLines = (receipt?.probes ?? []).map(
    (p) =>
      `- \`${p.flowId ?? p.type}\` ${p.type}: ${p.ok ? '✓ passed' : p.unavailable ? `⊘ ${p.outcome}` : `✗ ${p.outcome}`}${p.detail ? ` — ${p.detail.split('\n')[0]?.slice(0, 160)}` : ''}`
  )
  const lines: string[] = [
    '# QA brief — blind verification',
    '',
    "**Role**: you are QA. You did not write this change and you must not read its diff, commits or the author's notes. Verify the flows below against the running app exactly as a user would; report what you observed. Do NOT fix anything.",
    '',
    '## App',
    app?.start
      ? `- Start: \`${app.start}\` (run it in the background if it is not up)`
      : '- Start: not registered — ask for the command if the app is not reachable',
    app?.baseUrl ? `- Base URL: ${app.baseUrl}` : '- Base URL: not registered',
    '',
    '## Browser / tools',
    ...browserToolHints(config, input.browserInstalled === true).map((h) => `- ${h}`),
    '',
    '## Flows to verify',
  ]
  if (pendingFlows.length === 0) lines.push('- (none pending)')
  for (const f of pendingFlows) {
    lines.push(`### \`${f.id}\` ${f.name} (${f.kind})`)
    if (f.given.length) lines.push(`- GIVEN ${f.given.join(' AND ')}`)
    if (f.when.length) lines.push(`- WHEN ${f.when.join(' AND ')}`)
    if (f.then.length) lines.push(`- THEN ${f.then.join(' AND ')}`)
    if (f.status === 'failed' && f.evidence)
      lines.push(`- Last result: ✗ ${f.evidence.slice(0, 200)}`)
    if (f.status === 'passed' && f.verifiedBy === 'author') {
      lines.push('- Author claims it passes — verify independently; do not take their word.')
    }
  }
  lines.push('', '## Acceptance criteria to confirm')
  if (pendingCriteria.length === 0) lines.push('- (none pending)')
  for (const c of pendingCriteria) lines.push(`- \`${c.id}\` ${c.text}`)
  if (machineLines.length > 0)
    lines.push('', '## Already verified by machine (do not repeat)', ...machineLines)
  lines.push(
    '',
    '## Rules',
    '- Golden path first, then the edge cases the flow names. Max 3 attempts per flow; then report `blocked` with what you tried.',
    '- Evidence = what you observed (URL, text seen, status code, screenshot name), ≥ 40 chars. No evidence, no verdict.',
    '- Persist a reproducer for every failure in `repro`.',
    '',
    '## Report (run this when done — one entry per flow/criterion)',
    '```',
    `prjct qa report --json '[{"id":"${pendingFlows[0]?.id ?? 'fl-…'}","verdict":"passed|failed|blocked","evidence":"…","repro":"…"},{"id":"${pendingCriteria[0]?.id ?? 'ac-…'}","verdict":"met|unmet","evidence":"…"}]'`,
    '```',
    ''
  )
  return lines.join('\n')
}
