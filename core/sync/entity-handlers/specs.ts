/**
 * Specs entity handler.
 *
 * Specs are SDD documents (migration 16, `specs` table). Apply is ADDITIVE:
 * `specStorage.applyRemote` inserts a spec missing locally; on conflict it
 * merges via delta-log union when BOTH bodies carry deltas (Phase 1), and
 * otherwise leaves the local row untouched (legacy bodies are sacred). Writes
 * happen WITHOUT re-publishing on the insert path (no echo) and preserve the
 * remote timestamps. Delete is a NO-OP — a remote delete never removes a
 * local record.
 */

import { specStorage } from '../../storage/spec-storage'
import type { EntityHandler } from './types'

export const specsHandler: EntityHandler = {
  async upsert(projectId, data) {
    const id = (data.id as string) || ''
    if (!id) return
    specStorage.applyRemote(projectId, {
      id,
      title: data.title as string,
      status: data.status as string,
      content: (data.content as Record<string, unknown> | string) ?? {},
      tags: data.tags as Record<string, string> | string | null,
      created_at: data.created_at as string,
      updated_at: data.updated_at as string,
    })
  },

  async delete(_projectId, _data) {
    // No-op by design: sync never deletes a local record. A spec removed on
    // another machine stays in this machine's vault.
  },
}
