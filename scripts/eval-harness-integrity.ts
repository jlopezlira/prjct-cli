/** Repeated isolated integration measurements; no model-quality or billing claim. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { evaluateOutcomeEvidence } from '../core/services/outcome-evidence'
import { sameVerification, verificationBinding } from '../core/services/verification-binding'
import { runProc } from '../core/utils/exec'

const root = path.resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const value = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const output = value('--out')
const paired = value('--paired')
const suite = [
  'core/__tests__/services/verification-binding.test.ts',
  'core/__tests__/services/integrity-contracts.test.ts',
  'core/__tests__/memory/enriched-recall.test.ts',
  'core/__tests__/eval/retrieval-baseline.test.ts',
]
const binding = await verificationBinding(root, { suite, repetitions: 3 })
const repetitions = []
for (const repetition of [1, 2, 3]) {
  const result = await runProc('bun', ['test', ...suite], { cwd: root, timeoutMs: 120_000 })
  const log = `${result.stdout}\n${result.stderr}`
  const cases = [...log.matchAll(/^\((pass|fail)\) (.+?)(?: \[([\d.]+)ms\])?$/gm)].map((match) => ({
    name: match[2],
    completed: match[1] === 'pass',
    latencyMs: match[3] ? Number(match[3]) : null,
  }))
  repetitions.push({ repetition, passed: result.ok, latencyMs: result.durationMs, cases })
}
const stable = sameVerification(binding, await verificationBinding(root, { suite, repetitions: 3 }))
const report = {
  stable,
  version: 1,
  capturedAt: new Date().toISOString(),
  binding,
  kind: 'deterministic-integration',
  model: null,
  completion: stable && repetitions.every((r) => r.passed && r.cases.length >= 12),
  escapedRegressions: 'not measured outside the declared regression cases',
  inputTokens: null,
  outputTokens: null,
  contextTokens: null,
  costCoverage: 'No model executed. Provider token usage and same-model savings are unavailable.',
  repetitions,
  outcomes: evaluateOutcomeEvidence(
    paired ? JSON.parse(await fs.readFile(paired, 'utf8')) : undefined
  ),
}
const json = `${JSON.stringify(report, null, 2)}\n`
if (output) await fs.writeFile(output, json)
console.log(json)
if (!report.completion) process.exitCode = 1
