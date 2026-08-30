/**
 * Legacy local-state cleanup.
 *
 * Older installs generated `.prjct/.prjct-state.md` in the client repo as a
 * duplicate of the work-cycle state. SQLite + the generated global vault are
 * the only source of truth now, and prjct never writes agent-facing markdown
 * into the customer worktree — a stale copy just competes with the real
 * context for the model's attention. Sync removes the stub and never
 * refreshes it, so only `remove()` survives: there is deliberately no writer.
 *
 * @see PRJ-112
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { isNotFoundError } from '../types/fs'

const LOCAL_STATE_FILENAME = '.prjct/.prjct-state.md'

class LocalStateGenerator {
  /** Delete the legacy repo-local state stub. No-op when absent. */
  async remove(projectPath: string): Promise<void> {
    try {
      await fs.unlink(path.join(projectPath, LOCAL_STATE_FILENAME))
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
  }
}

export const localStateGenerator = new LocalStateGenerator()
