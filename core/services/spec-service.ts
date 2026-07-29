/**
 * Spec Service — orchestration for SDD specs.
 *
 * Bridges `spec-storage` (SQLite) and `projectMemory` (memory event
 * stream) so:
 *   - Specs are queryable as first-class entities (status, links, etc.)
 *   - Specs surface in `prjct context memory spec` recall
 *
 * Service is intentionally thin — Claude does the heavy lifting
 * (interactive spec drafting, audit-spec subagent dispatch). The
 * service owns persistence + invariants only.
 */

import configManager from '../infrastructure/config-manager'
import { projectMemory } from '../memory/project-memory'
import { specStorage } from '../storage/spec-storage'
import {
  type Spec,
  type SpecContent,
  SpecContentSchema,
  type SpecReview,
  type SpecStatus,
} from '../types/spec'
import { getTimestamp } from '../utils/date-helper'
import { execFileAsync } from '../utils/exec'
import { computeAuditCandidateHash, reviewsGatePassedRelational } from './spec-audit-dispatch'

/**
 * Read git HEAD sha at `projectPath`. Returns null when not a git repo
 * or git is unavailable — callers treat this as best-effort.
 */
async function readGitHead(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectPath })
    const sha = stdout.trim()
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}

class SpecService {
  /**
   * Create a draft spec. Goal is required (a spec without a goal is
   * just an inbox item — use `prjct capture` for that).
   */
  async create(
    projectPath: string,
    args: {
      title: string
      content: Partial<SpecContent> & { goal: string }
      tags?: Record<string, string>
      /**
       * Phase 1.6 / B-CTX: auto-populate `notes` with codebase + memory
       * context inferred from the title. Default true (brownfield-aware
       * by default). Pass false from greenfield init flows or when the
       * caller already supplied notes.
       */
      autoContext?: boolean
    }
  ): Promise<Spec> {
    const projectId = await this.requireProjectId(projectPath)

    // Hard refuse lookup-only goals (bare UUID). Draft seeds with goal=title
    // are allowed in the specs table; memory mirror is gated separately so
    // empty mirrors never pollute living type=spec surfaces.
    const { classifySpecCreate, shouldMirrorSpecToMemory } = await import(
      '../memory/precision-classifier'
    )
    const precision = classifySpecCreate(args.title, args.content.goal)
    if (precision.action === 'refuse') {
      throw new Error(`Cannot create empty spec (${precision.reasonCode}): ${precision.reason}`)
    }

    // Auto-context inference (B-CTX): only if `notes` is empty and the
    // caller didn't opt out. The composer reads `findRelevantFiles` +
    // `projectMemory.recall` and returns a tentative Markdown block.
    let notes = args.content.notes ?? ''
    const autoContext = args.autoContext !== false
    if (autoContext && !notes.trim()) {
      const { inferSpecContext, warnNoContextMatch } = await import('./spec-context-inference')
      const ctx = await inferSpecContext(args.title, projectId, projectPath)
      if (ctx.empty) {
        warnNoContextMatch(args.title)
      } else {
        notes = ctx.notesBlock
      }
    }

    const validated = SpecContentSchema.parse({
      goal: args.content.goal,
      eli10: args.content.eli10 ?? '',
      stakes: args.content.stakes ?? '',
      acceptance_criteria: args.content.acceptance_criteria ?? [],
      scope: args.content.scope ?? [],
      out_of_scope: args.content.out_of_scope ?? [],
      risks: args.content.risks ?? [],
      test_plan: args.content.test_plan ?? [],
      reviews: args.content.reviews,
      linked_tasks: args.content.linked_tasks ?? [],
      notes,
    })

    const spec = specStorage.create(projectId, {
      title: args.title,
      content: validated,
      tags: args.tags,
    })

    // Mirror only when goal is substantive — draft seeds (goal===title) stay
    // in the specs table without polluting `prjct context memory spec`.
    if (shouldMirrorSpecToMemory(spec.title, spec.content.goal)) {
      await projectMemory.remember(projectPath, {
        type: 'spec',
        content: `${spec.title}\n\nGoal: ${spec.content.goal}`,
        tags: { ...(args.tags ?? {}), spec_id: spec.id, status: spec.status },
        source: spec.id,
        provenance: 'declared',
      })
    }

    return spec
  }

  async get(projectPath: string, id: string): Promise<Spec | null> {
    const projectId = await this.requireProjectId(projectPath)
    return specStorage.get(projectId, id)
  }

  async list(
    projectPath: string,
    filter: { status?: SpecStatus; includeArchived?: boolean } = {}
  ): Promise<Spec[]> {
    const projectId = await this.requireProjectId(projectPath)
    return specStorage.list(projectId, filter)
  }

  async setStatus(projectPath: string, id: string, status: SpecStatus): Promise<Spec | null> {
    const projectId = await this.requireProjectId(projectPath)
    const next = specStorage.setStatus(projectId, id, status)
    if (next) {
      await projectMemory.remember(projectPath, {
        type: 'spec',
        content: `Spec status → ${status}: ${next.title}`,
        tags: { spec_id: id, status, event: 'status_change' },
        source: id,
      })
    }
    return next
  }

  async update(projectPath: string, id: string, content: SpecContent): Promise<Spec | null> {
    const projectId = await this.requireProjectId(projectPath)
    const prev = specStorage.get(projectId, id)
    if (!prev) return null
    const prevHash = computeAuditCandidateHash(prev.content)
    const nextHash = computeAuditCandidateHash(content)
    let next = content
    if (prevHash !== nextHash) {
      // C1: body drifted — invalidate lens admission and demote reviewed → draft.
      next = {
        ...content,
        reviews: {},
        selected_reviewers: [],
        audit_candidate_hash: null,
      }
      if (prev.status === 'reviewed' || prev.status === 'in_progress') {
        specStorage.setStatus(projectId, id, 'draft')
      }
    }
    return specStorage.updateContent(projectId, id, next)
  }

  async recordReview(
    projectPath: string,
    id: string,
    reviewer: string,
    review: Omit<SpecReview, 'ts'>
  ): Promise<Spec | null> {
    const projectId = await this.requireProjectId(projectPath)

    // Optimistic-concurrency loop: read spec + its updated_at, mutate
    // content.reviews in memory, write via casUpdate (which only succeeds
    // if updated_at still matches). On conflict, retry up to 3 times with
    // 50ms backoff. We CANNOT pull breakdownSpecToTasks inside a sync
    // db.transaction — it awaits async work (queueStorage.addTasks writes
    // JSON via StorageManager, plus event publishes + memory writes). So
    // breakdown runs AFTER the CAS-on-content succeeds, gated by
    // tasks_created_at idempotency. See spec a50b32d1 AC #12.
    const MAX_ATTEMPTS = 3
    const BACKOFF_MS = 50
    let attempts = 0
    let winningWriteHappenedHere = false
    let updated: Spec | null = null
    while (attempts < MAX_ATTEMPTS) {
      const spec = specStorage.get(projectId, id)
      if (!spec) return null

      const frozen = spec.content.audit_candidate_hash ?? computeAuditCandidateHash(spec.content)
      // Refuse recording against a drifted body (hash no longer matches frozen).
      if (
        spec.content.audit_candidate_hash &&
        computeAuditCandidateHash(spec.content) !== spec.content.audit_candidate_hash
      ) {
        throw new Error(
          `SPEC_CANDIDATE_DRIFT: body no longer matches audit_candidate_hash. Re-run \`prjct spec audit ${id}\` then re-record reviews.`
        )
      }
      const fullReview: SpecReview = {
        ...review,
        ts: getTimestamp(),
        candidateHash: frozen,
      }
      const nextContent: SpecContent = {
        ...spec.content,
        // Ensure frozen hash is stamped even for legacy audits mid-flight.
        audit_candidate_hash: frozen,
        reviews: {
          ...(spec.content.reviews ?? {}),
          [reviewer]: fullReview,
        },
      }
      const ok = specStorage.casUpdate(projectId, id, nextContent, spec.updatedAt)
      if (ok) {
        winningWriteHappenedHere = true
        updated = specStorage.get(projectId, id)
        break
      }
      attempts++
      if (attempts < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS))
      }
    }

    if (!winningWriteHappenedHere) {
      throw new Error(
        `SPEC_RECORD_REVIEW_CONFLICT_RETRY_EXHAUSTED: ${MAX_ATTEMPTS} retries failed for spec ${id}`
      )
    }

    if (updated && reviewsGatePassedRelational(projectId, id)) {
      // All SELECTED lenses pass → auto-promote draft to reviewed.
      if (updated.status === 'draft') {
        // Nyquist-lite: refuse silent promote when ACs are prose-only under
        // TDD strict / SDD strict (code-strict pack). Soft warn otherwise.
        const { assessAcceptanceCriteria } = await import('./nyquist-lite')
        const acReport = assessAcceptanceCriteria(updated.content.acceptance_criteria ?? [])
        if (!acReport.ok && acReport.message) {
          const cfg = await configManager.readConfig(projectPath).catch(() => null)
          const tddStrict = cfg?.tdd?.mode === 'strict'
          const sddStrict = cfg?.sdd?.mode === 'strict'
          if (tddStrict || sddStrict) {
            throw new Error(
              `NYQUIST_LITE_BLOCK: ${acReport.message}\nRewrite acceptance criteria with verifiable signals, then re-record the last review.`
            )
          }
          // Advisory: attach a tag so agents see the gap without blocking.
          try {
            await projectMemory.remember(projectPath, {
              type: 'improvement-signal',
              content: acReport.message,
              tags: { source: 'nyquist-lite', spec: id },
              provenance: 'extracted',
              projectId,
            })
          } catch {
            /* best-effort */
          }
        }

        const promoted = specStorage.setStatus(projectId, id, 'reviewed')
        // Auto-breakdown: materialize acceptance_criteria as granular
        // queue tasks. Now made idempotent on spec_id via the
        // `tasks_created_at` marker (spec-task-breakdown.ts). The CAS
        // guarantees only one writer observes draft→reviewed; the marker
        // gates the breakdown call itself against any other source
        // (e.g. manual `prjct spec breakdown <id>`). See spec a50b32d1
        // AC #12 + #13.
        if (promoted) {
          const { breakdownSpecToTasks } = await import('./spec-task-breakdown')
          await breakdownSpecToTasks(projectId, projectPath, promoted)
          return specStorage.get(projectId, id)
        }
        return promoted
      }
    }
    return updated
  }

  async linkTask(projectPath: string, specId: string, taskId: string): Promise<Spec | null> {
    const projectId = await this.requireProjectId(projectPath)
    return specStorage.linkTask(projectId, specId, taskId)
  }

  async ship(projectPath: string, specId: string, pr?: number): Promise<Spec | null> {
    const projectId = await this.requireProjectId(projectPath)
    if (pr !== undefined) {
      specStorage.setShippedPr(projectId, specId, pr)
    }
    // Phase 1.6 / B-DRIFT-ANCHOR: capture the HEAD sha at ship time so
    // `prjct spec inventory` can diff against it later. Best-effort —
    // ship still succeeds in non-git contexts (the spec just gets
    // drift=unknown in the inventory output).
    const sha = await readGitHead(projectPath)
    if (sha) {
      specStorage.setShippedSha(projectId, specId, sha)
    }
    return specStorage.setStatus(projectId, specId, 'shipped')
  }

  /**
   * Acceptance gate: returns the criteria still un-satisfied. The CLI
   * doesn't auto-tick boxes — caller (or Claude) marks each criterion
   * met by passing the `met` set.
   */
  unmetCriteria(spec: Spec, met: Set<string> = new Set()): string[] {
    return spec.content.acceptance_criteria.filter((c) => !met.has(c))
  }

  /**
   * Persist the lens set chosen at audit time so the auto-promote gate
   * (`reviewsGatePassed`) knows the expected set. Called by `prjct spec
   * audit` before it emits the dispatch.
   */
  async setSelectedReviewers(
    projectPath: string,
    id: string,
    lenses: string[]
  ): Promise<Spec | null> {
    const projectId = await this.requireProjectId(projectPath)
    const spec = specStorage.get(projectId, id)
    if (!spec) return null
    const hash = computeAuditCandidateHash(spec.content)
    return specStorage.updateContent(projectId, id, {
      ...spec.content,
      selected_reviewers: lenses,
      audit_candidate_hash: hash,
      // Fresh audit invalidates prior lens results on a previous candidate.
      reviews: {},
    })
  }

  private async requireProjectId(projectPath: string): Promise<string> {
    const config = await configManager.readConfig(projectPath)
    if (!config?.projectId) {
      throw new Error('not a prjct project (run `prjct init` first)')
    }
    return config.projectId
  }
}

export const specService = new SpecService()
export type { SpecService }
