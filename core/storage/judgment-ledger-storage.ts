/**
 * Precision-judgment persistence — active ledger + project ghost (FP) book.
 *
 * Keys:
 *  - `judgment:active` — current branch ledger
 *  - `judgment:ghosts` — DNA of findings refuted as false positives (compounds)
 */

import {
  type JudgmentGhostBook,
  JudgmentGhostBookSchema,
  type JudgmentLedger,
  JudgmentLedgerSchema,
} from '../schemas/judgment'
import { getTimestamp } from '../utils/date-helper'
import prjctDb from './database'

export const JUDGMENT_ACTIVE_KEY = 'judgment:active'
export const JUDGMENT_GHOSTS_KEY = 'judgment:ghosts'

class JudgmentLedgerStorage {
  get(projectId: string): JudgmentLedger | null {
    const raw = prjctDb.getDoc<unknown>(projectId, JUDGMENT_ACTIVE_KEY)
    if (raw === null) return null
    const parsed = JudgmentLedgerSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }

  set(projectId: string, ledger: JudgmentLedger): JudgmentLedger {
    // A2: RMW via updateDoc so concurrent approve/challenge/add cannot
    // silently last-write-wins clobber mid-transition (gentle-ai CAS spirit).
    const stamp = ledger.updatedAt || getTimestamp()
    const row = prjctDb.updateDoc<JudgmentLedger>(
      projectId,
      JUDGMENT_ACTIVE_KEY,
      () =>
        JudgmentLedgerSchema.parse({
          ...ledger,
          updatedAt: stamp,
        }),
      () =>
        JudgmentLedgerSchema.parse({
          ...ledger,
          updatedAt: stamp,
        })
    )
    return row
  }

  clear(projectId: string): void {
    prjctDb.deleteDoc(projectId, JUDGMENT_ACTIVE_KEY)
  }

  getGhosts(projectId: string): JudgmentGhostBook {
    const raw = prjctDb.getDoc<unknown>(projectId, JUDGMENT_GHOSTS_KEY)
    if (raw === null) return { ghosts: [], updatedAt: getTimestamp() }
    const parsed = JudgmentGhostBookSchema.safeParse(raw)
    return parsed.success ? parsed.data : { ghosts: [], updatedAt: getTimestamp() }
  }

  setGhosts(projectId: string, book: JudgmentGhostBook): JudgmentGhostBook {
    const row = JudgmentGhostBookSchema.parse(book)
    prjctDb.setDoc(projectId, JUDGMENT_GHOSTS_KEY, row)
    return row
  }
}

export const judgmentLedgerStorage = new JudgmentLedgerStorage()
