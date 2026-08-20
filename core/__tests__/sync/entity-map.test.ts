/**
 * entity-map — the single canonical producer→table map + include filter
 * shared by the push mapper and the pull normalizer.
 *
 * Pins two contracts the old split-based mapper broke:
 *  1. EVERY real producer entityType resolves to a storage table (memories,
 *     queue_task, workflows, archives were silently dropped before).
 *  2. The per-project include filter defaults sensitive groups OFF and lets
 *     overrides flip any group.
 */

import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_INCLUDE,
  INCLUDE_GROUPS,
  isTableIncluded,
  toCloudTable,
} from '../../sync/entity-map'

describe('toCloudTable', () => {
  // Every entityType a `publishCRUD` caller actually emits in core/.
  const PRODUCER_ENTITY_TYPES: Array<[string, string]> = [
    ['memories', 'memories'],
    ['memory', 'memories'],
    ['memory_entry', 'memories'],
    ['idea', 'ideas'],
    ['queue_task', 'queue_tasks'],
    ['shipped', 'shipped_items'],
    ['workflow_rules', 'workflow_rules'],
    ['custom_workflows', 'custom_workflows'],
    ['archives', 'archives'],
    ['paused_task', 'tasks'],
    ['subtask', 'subtasks'],
    ['task', 'tasks'],
    // Previously unmapped → silently dropped. Now first-class.
    ['analysis', 'analysis'],
    ['specs', 'specs'],
    ['spec', 'specs'],
  ]

  it.each(PRODUCER_ENTITY_TYPES)('resolves producer %s → table %s', (producer, table) => {
    expect(toCloudTable(producer)).toBe(table)
  })

  it('returns undefined for unknown / empty entities (dropped on the wire)', () => {
    expect(toCloudTable('totally_unknown')).toBeUndefined()
    expect(toCloudTable('')).toBeUndefined()
    expect(toCloudTable(undefined)).toBeUndefined()
    expect(toCloudTable(null)).toBeUndefined()
  })
})

describe('isTableIncluded', () => {
  it('defaults cross-device groups ON and sensitive groups OFF', () => {
    // No overrides → memories/tasks/etc on; the sensitive groups have no
    // mapped table here, so test the defaults directly.
    expect(isTableIncluded('memories')).toBe(true)
    expect(isTableIncluded('tasks')).toBe(true)
    expect(isTableIncluded('subtasks')).toBe(true)
    expect(isTableIncluded('queue_tasks')).toBe(true)
    expect(isTableIncluded('custom_workflows')).toBe(true)
    // Aggregated metrics are cross-device value now: cost/context snapshots
    // sync by default while raw prompts/sessions remain opt-out.
    expect(isTableIncluded('metrics_daily')).toBe(true)
    expect(isTableIncluded('work_cost_snapshots')).toBe(true)
    expect(isTableIncluded('inference_cost_snapshots')).toBe(true)
    // Archives are bidirectional now (handler + full entity_data) → default-on.
    expect(isTableIncluded('archives')).toBe(true)
    expect(DEFAULT_INCLUDE.user_prompts).toBe(false)
    expect(DEFAULT_INCLUDE.agent_sessions).toBe(false)
    // Analysis + specs are project-understanding knowledge → on by default so
    // the cloud vault is a complete picture (raw prompts/sessions stay off).
    expect(DEFAULT_INCLUDE.analysis).toBe(true)
    expect(DEFAULT_INCLUDE.specs).toBe(true)
    expect(isTableIncluded('analysis')).toBe(true)
    expect(isTableIncluded('specs')).toBe(true)
  })

  it('honors an explicit opt-out for a group', () => {
    expect(isTableIncluded('memories', { memories: false })).toBe(false)
    // A task and its subtasks/queue ride the same `tasks` group toggle.
    expect(isTableIncluded('subtasks', { tasks: false })).toBe(false)
    expect(isTableIncluded('queue_tasks', { tasks: false })).toBe(false)
  })

  it('allows unknown-but-mapped tables (server still authorizes)', () => {
    expect(isTableIncluded('roadmap_features')).toBe(true)
  })

  it('exposes the full group vocabulary', () => {
    expect(INCLUDE_GROUPS).toContain('memories')
    expect(INCLUDE_GROUPS).toContain('user_prompts')
    expect(INCLUDE_GROUPS.length).toBe(Object.keys(DEFAULT_INCLUDE).length)
  })
})
