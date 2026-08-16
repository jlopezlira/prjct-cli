/**
 * `prjct capture` — GTD-style universal inbox.
 *
 * The 80% of dumps during the day ("llamar a Ana", "leer paper X",
 * "idea: auto-tag tasks") aren't commitments and don't deserve a
 * branch, worktree, or task id. They deserve a single keystroke to
 * persist and keep going. `capture` does exactly that:
 *
 *   prjct capture "<anything>" [--tags k:v,k:v]
 *
 * Writes a memory entry with `type=inbox`. Claude (or the human via a
 * `clarify` workflow) can retype later to a real type — the entry's id
 * travels, tags travel, content travels.
 *
 * Anti-harness: `capture` does one thing — persist. It doesn't
 * classify, doesn't suggest a type, doesn't ask the LLM for follow-up.
 * If the caller wants structure later, that's a different verb.
 */

import { projectMemory } from '../memory/project-memory'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { failHard } from '../utils/md-aware'
import out from '../utils/output'
import { parseFlagTags } from '../utils/tags'
import { PrjctCommandsBase } from './base'
import { requireTrustedMemoryContent } from './guards'

export class CaptureCommands extends PrjctCommandsBase {
  /**
   * p. capture "<anything>" [--tags k:v,...]
   *
   * Project init isn't required — you might capture in a fresh repo
   * and only later `prjct init`. If there's no project yet, the call
   * fails fast with a helpful hint.
   */
  async capture(
    content: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; tags?: string; force?: boolean; fromCurrent?: boolean } = {}
  ): Promise<CommandResult> {
    try {
      if (!content || !content.trim()) {
        out.info('Usage: prjct capture "<anything>" [--tags k:v,...]')
        return { success: false, error: 'Content required' }
      }

      const text = content.trim()

      const trustCheck = requireTrustedMemoryContent(text, { force: options.force })
      if (!trustCheck.ok) return trustCheck.result

      const tags = parseFlagTags(options.tags)

      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      // Provenance capture (beads' discovered-from): work found WHILE working
      // becomes a workable backlog item linked to the active cycle — the
      // scope-discovery trail agents otherwise disavow under context pressure.
      // It also feeds velocity's scope-creep signal.
      if (options.fromCurrent) {
        const { requireProject } = await import('./guards')
        const pid = await requireProject(projectPath)
        if (!pid.ok) return pid.result
        const { queueStorage } = await import('../storage/queue-storage')
        const { workGraph } = await import('../services/work-graph')
        const item = await queueStorage.addTask(pid.value, {
          description: text,
          section: 'active',
          type: 'feature',
          priority: 'medium',
        })
        try {
          const { collectActiveTasks } = await import('../services/task-overview')
          const overview = await collectActiveTasks(pid.value, projectPath)
          if (overview.current?.id) {
            workGraph.addDependency(pid.value, item.id, overview.current.id, 'discovered-from')
          }
        } catch {
          /* no active cycle → item stands alone; the capture still succeeds */
        }
        const previewD = text.length > 60 ? `${text.slice(0, 57)}…` : text
        if (options.md)
          console.log(`✓ captured as backlog item (discovered-from current): ${previewD}`)
        else out.done(`captured as backlog item: ${previewD}`)
        return { success: true, type: 'discovered', id: item.id, content: text }
      }

      await projectMemory.remember(projectPath, {
        type: 'inbox',
        content: text,
        tags,
        provenance: 'declared',
      })

      const preview = text.length > 60 ? `${text.slice(0, 57)}…` : text
      if (options.md) console.log(`✓ captured: ${preview}`)
      else out.done(`captured: ${preview}`)

      return { success: true, type: 'inbox', content: text, tags }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }
}
