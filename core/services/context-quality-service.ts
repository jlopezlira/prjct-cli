/**
 * Sync-time context quality repair.
 *
 * Existing projects may contain months of raw detector output and low-value
 * legacy context. Sync owns cleanup because it is the regular maintenance
 * pass every active user runs.
 */

import type { MemoryEntry } from '../memory/entries'
import { deriveTitle } from '../memory/format'
import { projectMemory } from '../memory/project-memory'
import { publishCRUD } from '../sync/publish-helper'
import { parseLivingContextFields } from './living-context-contract'
import { isSignalEntry } from './signals-digest'

export interface ContextQualityReport {
  score: number
  threshold: number
  passed: boolean
  iterations: number
  livingContextCount: number
  legacyContextCount: number
  irrelevantRemoved: number
  repairEntriesCreated: number
  issues: string[]
}

interface ContextQualityOptions {
  threshold?: number
  maxIterations?: number
}

const DEFAULT_THRESHOLD = 85
const DEFAULT_MAX_ITERATIONS = 2

export async function repairContextQuality(
  projectPath: string,
  projectId: string,
  options: ContextQualityOptions = {}
): Promise<ContextQualityReport> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS

  // Retention scores inform which "irrelevant" rows are safe to drop:
  // keep entries the scorer still ranks active+strong (false-positive noise).
  const retentionById: Map<string, { verdict: string; score: number }> | null = await import(
    './retention'
  )
    .then(({ evaluateRetention }) => evaluateRetention(projectId, Date.now()).byId)
    .catch(() => null)

  const repairIteration = async (
    iteration: number,
    report: ContextQualityReport,
    removed: number,
    created: number
  ): Promise<ContextQualityReport> => {
    if (iteration >= maxIterations || report.score >= threshold) {
      return { ...report, irrelevantRemoved: removed, repairEntriesCreated: created }
    }
    const entries = projectMemory.allEntriesForIndex(projectId)
    const irrelevant = entries.filter((entry) => {
      if (!isIrrelevantGeneratedContext(entry)) return false
      const r = retentionById?.get(entry.id)
      // Retention still values this entry highly → leave it alone.
      if (r && r.verdict === 'active' && r.score >= 70) return false
      return true
    })

    const createdThisIteration = hasUsableLivingContext(entries) ? 0 : 1
    if (createdThisIteration > 0) {
      await projectMemory.remember(projectPath, {
        type: 'context',
        content: buildRepairContext(entries, report),
        tags: {
          context_schema: 'living-v2',
          synthesis: 'model-authored',
          feature: 'context-quality-cleanup',
          key_data: `quality_score=${report.score}; threshold=${threshold}; irrelevant=${irrelevant.length}`,
          model: 'prjct sync context-quality analyzer',
          token_usage: '0 deterministic sync tokens',
          source: 'sync-context-quality',
        },
        provenance: 'inferred',
        projectId,
      })
    }

    const removedIds: string[] = []
    for (const entry of irrelevant) {
      if (projectMemory.forget(projectId, entry.id)) {
        removedIds.push(entry.id)
        await publishCRUD({
          projectId,
          entityType: 'memories',
          entityId: entry.id,
          eventType: 'delete',
          data: {
            id: entry.id,
            type: entry.type,
            content: entry.content,
            tags: entry.tags,
            reason: 'context-quality-cleanup',
          },
        })
      }
    }

    const next = evaluateContextQuality(projectId, threshold)
    const nextReport = {
      ...next,
      iterations: iteration + 1,
      irrelevantRemoved: removed + removedIds.length,
      repairEntriesCreated: created + createdThisIteration,
    }
    if (irrelevant.length === 0 && createdThisIteration === 0) return nextReport
    return repairIteration(
      iteration + 1,
      nextReport,
      removed + removedIds.length,
      created + createdThisIteration
    )
  }

  return repairIteration(0, evaluateContextQuality(projectId, threshold), 0, 0)
}

export function evaluateContextQuality(
  projectId: string,
  threshold = DEFAULT_THRESHOLD
): ContextQualityReport {
  const entries = projectMemory.allEntriesForIndex(projectId)
  const contexts = entries.filter((e) => e.type === 'context')
  const living = contexts.filter(isLivingV2Context)
  const legacy = contexts.filter((e) => !isLivingV2Context(e))
  const irrelevant = entries.filter(isIrrelevantGeneratedContext)
  const issues: string[] = []

  const penalties: number[] = []
  if (entries.length > 0 && living.length === 0) {
    penalties.push(35)
    issues.push('missing living-v2 context synthesis')
  }
  if (irrelevant.length > 0) {
    penalties.push(Math.min(40, irrelevant.length * 8))
    issues.push(`${irrelevant.length} irrelevant generated entries in active context`)
  }
  if (legacy.length > 0) {
    penalties.push(Math.min(20, legacy.length * 5))
    issues.push(`${legacy.length} legacy context entries need cleanup`)
  }

  const latest = living[0]
  if (latest) {
    const fields = parseLivingContextFields(latest.content)
    const required = [
      fields.contextSynthesis,
      fields.keyData,
      fields.model,
      fields.tokenUsage,
      fields.nextImplication,
    ]
    const missing = required.filter((v) => !v).length
    if (missing > 0) {
      penalties.push(missing * 4)
      issues.push('latest living context is missing structured UI/LLM fields')
    }
  }

  const score = Math.max(0, Math.min(100, 100 - penalties.reduce((sum, value) => sum + value, 0)))
  return {
    score,
    threshold,
    passed: score >= threshold,
    iterations: 0,
    livingContextCount: living.length,
    legacyContextCount: legacy.length,
    irrelevantRemoved: 0,
    repairEntriesCreated: 0,
    issues,
  }
}

export function isIrrelevantGeneratedContext(entry: MemoryEntry): boolean {
  if (isSignalEntry(entry)) return true
  if (entry.tags?.source === 'sync-context-quality') return false
  if (entry.type !== 'context') return false
  if (isLivingV2Context(entry)) return false
  return isLowValueLegacyContext(entry)
}

function isLivingV2Context(entry: MemoryEntry): boolean {
  if (entry.tags?.context_schema === 'living-v2') return true
  const fields = parseLivingContextFields(entry.content)
  return Boolean(fields.contextSynthesis && fields.keyData)
}

function hasUsableLivingContext(entries: MemoryEntry[]): boolean {
  return entries.some((entry) => entry.type === 'context' && isLivingV2Context(entry))
}

function isLowValueLegacyContext(entry: MemoryEntry): boolean {
  const c = entry.content.trim()
  if (c.length < 260) return true
  if (/User pushback:|raw quote|transcript|hot file|skill-miss/i.test(c)) return true
  const fields = parseLivingContextFields(c)
  const usefulFields = [
    fields.whatHappened,
    fields.whyItMattered,
    fields.pattern,
    fields.antiPattern,
    fields.outcome,
    fields.nextImplication,
  ].filter(Boolean).length
  return usefulFields < 3
}

function buildRepairContext(entries: MemoryEntry[], report: ContextQualityReport): string {
  const useful = entries
    .filter((entry) => !isIrrelevantGeneratedContext(entry))
    .filter((entry) =>
      ['decision', 'gotcha', 'learning', 'context', 'shipped'].includes(entry.type)
    )
    .slice(0, 8)
  const highlights =
    useful.length > 0
      ? useful.map((entry) => `${entry.type}:${deriveTitle(entry)}`).join('; ')
      : 'No high-quality prior context survived cleanup.'
  const keyData = [
    `quality_score=${report.score}`,
    `threshold=${report.threshold}`,
    `legacy_context=${report.legacyContextCount}`,
    `issues=${report.issues.join('|') || 'none'}`,
  ].join('; ')

  return [
    'Context synthesis: Sync repaired historical low-quality project context by removing generated telemetry and preserving the useful project knowledge as a living-v2 synthesis. Future agents should trust this synthesized layer over old raw detector rows or legacy context snippets.',
    `Key data: ${keyData}`,
    'What happened: prjct sync detected that active context quality was below the required threshold and generated a replacement synthesis before deleting irrelevant generated entries.',
    'Why it mattered: Existing users had accumulated low-signal context over time; leaving it active makes the second brain noisy for both the UI and LLM retrieval.',
    'Who/author: prjct sync',
    'Model: prjct sync context-quality analyzer',
    'Token usage: 0 deterministic sync tokens',
    'Sentiment: cleanup required because raw generated context had become product debt',
    'Related files: generated from existing project memory during sync',
    'Feature/domain: context-quality-cleanup',
    'Pattern: Keep structured key data for UI representation and synthesized context for humans/LLMs.',
    'Anti-pattern: Surfacing raw detector rows, hot-file counters, or short legacy snippets as durable project knowledge.',
    'Decision/trap: Generated garbage is hard-deleted from active recall/vault/search; user-authored decisions, gotchas, learnings, and facts are preserved.',
    `Outcome: Repair synthesis created from surviving highlights: ${highlights}`,
    'Next implication: If quality remains below threshold, run full sync/analysis and inspect remaining user-authored entries manually instead of deleting them blindly.',
  ].join(' · ')
}
