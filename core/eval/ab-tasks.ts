/**
 * A/B task corpus: the same-model with/without-harness eval, versioned in the
 * repo (evals/ab/tasks/*.json) so the "measurement is the product" claim is
 * auditable, not a script in a scratch dir. Ported from the Python runner that
 * produced evaluacion/logs/fable-5.1/results.jsonl.
 */

import fs from 'node:fs'
import path from 'node:path'

/** The four classes the turn router (Phase 3) and the policy table key on. */
export const TASK_CLASSES = [
  'SELF_CONTAINED',
  'PROJECT_KNOWLEDGE',
  'EXPLORATION',
  'VERIFY',
] as const
export type TaskClass = (typeof TASK_CLASSES)[number]

/**
 * One deterministic grader clause. A clause passes when every `all` needle is
 * present (case-insensitive), at least one `any` needle is present (when given),
 * and `regex` matches (when given). Empty clause → passes.
 */
export interface DetClause {
  all?: string[]
  any?: string[]
  regex?: string
}

/** A named fact; passes when ANY of its clauses passes (OR of clauses). */
export interface DetPart {
  name: string
  clauses: DetClause[]
}

/** The whole answer is correct when EVERY part passes (AND of parts). */
export interface DetSpec {
  parts: DetPart[]
}

/** A seed memory inserted into the `harness` arm's project before the run. */
export interface SeedMemory {
  type: string
  content: string
  tags?: Record<string, string>
}

export interface AbTask {
  id: string
  taskClass: TaskClass
  prompt: string
  gold: string
  det: DetSpec
  /** Memories the harness arm should hold (PROJECT_KNOWLEDGE tasks). */
  seed?: SeedMemory[]
}

const TASKS_DIR = path.join(__dirname, '..', '..', 'evals', 'ab', 'tasks')

function isTaskClass(value: unknown): value is TaskClass {
  return typeof value === 'string' && (TASK_CLASSES as readonly string[]).includes(value)
}

/** Parse + validate one task object (fail loud — a bad corpus is a bug). */
export function parseTask(raw: unknown, source: string): AbTask {
  if (!raw || typeof raw !== 'object') throw new Error(`ab task ${source}: not an object`)
  const t = raw as Record<string, unknown>
  if (typeof t.id !== 'string' || !t.id) throw new Error(`ab task ${source}: missing id`)
  if (!isTaskClass(t.taskClass)) throw new Error(`ab task ${t.id}: bad taskClass ${t.taskClass}`)
  if (typeof t.prompt !== 'string' || !t.prompt) throw new Error(`ab task ${t.id}: missing prompt`)
  if (typeof t.gold !== 'string' || !t.gold) throw new Error(`ab task ${t.id}: missing gold`)
  const det = t.det as DetSpec | undefined
  if (!det || !Array.isArray(det.parts) || det.parts.length === 0) {
    throw new Error(`ab task ${t.id}: det.parts must be a non-empty array`)
  }
  for (const part of det.parts) {
    if (!part.name || !Array.isArray(part.clauses) || part.clauses.length === 0) {
      throw new Error(`ab task ${t.id}: det part needs a name and clauses`)
    }
  }
  return {
    id: t.id,
    taskClass: t.taskClass,
    prompt: t.prompt,
    gold: t.gold,
    det,
    seed: Array.isArray(t.seed) ? (t.seed as SeedMemory[]) : undefined,
  }
}

/** Load every task in the corpus, sorted by id for stable output. */
export function loadTasks(dir: string = TASKS_DIR): AbTask[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
  return files.map((f) => parseTask(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')), f))
}

/** Load a subset by id (CLI `--tasks`), preserving corpus order. */
export function loadTasksById(ids: string[], dir: string = TASKS_DIR): AbTask[] {
  const wanted = new Set(ids)
  return loadTasks(dir).filter((t) => wanted.has(t.id))
}
