/**
 * Crew State Storage
 *
 * Single kv_store row at key `crew:state` per project. Source of truth for
 * `prjct crew` enrollment state. Replaces all on-disk crew state
 * (`.claude/agents/`, `CLAUDE.md` snippet, `CREW.md`) per the product
 * invariant: no agent-facing files in the client repository.
 */

import { z } from 'zod'
import prjctDb from './database'

export const CREW_STATE_KEY = 'crew:state'

export const CrewStateSchema = z.object({
  enabled: z.boolean(),
  mechanism: z.enum(['native', 'emulated']),
  provider: z.string().nullable(),
  installedAt: z.string().min(1),
  emulatedProtocol: z.string().optional(),
  agents: z.record(z.enum(['leader', 'implementer', 'reviewer']), z.string()).optional(),
})

export type CrewState = z.infer<typeof CrewStateSchema>

class CrewStateStorage {
  get(projectId: string): CrewState | null {
    const raw = prjctDb.getDoc<unknown>(projectId, CREW_STATE_KEY)
    if (raw === null) return null
    return CrewStateSchema.parse(raw)
  }

  set(projectId: string, state: CrewState): void {
    const validated = CrewStateSchema.parse(state)
    prjctDb.setDoc(projectId, CREW_STATE_KEY, validated)
  }

  clear(projectId: string): void {
    prjctDb.deleteDoc(projectId, CREW_STATE_KEY)
  }
}

export const crewStateStorage = new CrewStateStorage()
export default crewStateStorage
