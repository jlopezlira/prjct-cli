/**
 * Team Enrollment Storage
 *
 * Single kv_store row at key `team:enrollment` per project. The ONLY
 * copy of `prjct team` enrollment state — there is no `.prjct/team.json`
 * mirror any more, because prjct writes nothing into the customer
 * worktree and `legacy-crew-sweep` deletes a leftover mirror on sync.
 *
 * See spec a50b32d1 AC #1.
 */

import { z } from 'zod'
import prjctDb from './database'

export const TEAM_ENROLLMENT_KEY = 'team:enrollment'

export const TeamEnrollmentSchema = z.object({
  required: z.boolean(),
  minVersion: z.string().min(1),
  enrolledAt: z.string().min(1),
  /** Identifies the user / mechanism that enrolled the repo. Optional. */
  enrolledBy: z.string().nullable().default(null),
})

export type TeamEnrollment = z.infer<typeof TeamEnrollmentSchema>

class TeamEnrollmentStorage {
  get(projectId: string): TeamEnrollment | null {
    const raw = prjctDb.getDoc<unknown>(projectId, TEAM_ENROLLMENT_KEY)
    if (raw === null) return null
    return TeamEnrollmentSchema.parse(raw)
  }

  set(projectId: string, enrollment: TeamEnrollment): void {
    const validated = TeamEnrollmentSchema.parse(enrollment)
    prjctDb.setDoc(projectId, TEAM_ENROLLMENT_KEY, validated)
  }

  clear(projectId: string): void {
    prjctDb.deleteDoc(projectId, TEAM_ENROLLMENT_KEY)
  }
}

export const teamEnrollmentStorage = new TeamEnrollmentStorage()
export default teamEnrollmentStorage
