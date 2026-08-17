/**
 * Incremental change detection — given the working tree + the
 * recorded hash registry, decide what changed since last sync and
 * whether the file-ranking indexes need a rebuild.
 *
 * Pure orchestration over the domain primitives in `core/domain/`.
 * Extracted from `SyncService.sync()` so the orchestrator stays
 * under 500 LOC.
 */

import { affectedDomains, propagateChanges } from '../../domain/change-propagator'
import { detectChanges, hasHashRegistry, saveHashes } from '../../domain/file-hasher'
import { getErrorMessage } from '../../types/fs'
import type { IncrementalInfo } from '../../types/project-sync'
import log from '../../utils/logger'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

export interface IncrementalDetectInput {
  projectId: string
  projectPath: string
  isFullSync: boolean
  changedFilesHint: string[] | undefined
}

export interface IncrementalDetectResult {
  shouldRebuildIndexes: boolean
  changedDomains: Set<string>
  incrementalInfo: IncrementalInfo | undefined
  changedSourceFiles: string[]
  deletedSourceFiles: string[]
}

export async function detectIncrementalChanges(
  args: IncrementalDetectInput
): Promise<IncrementalDetectResult> {
  const { projectId, projectPath, isFullSync, changedFilesHint } = args
  const fullResult: IncrementalDetectResult = {
    shouldRebuildIndexes: true,
    changedDomains: new Set<string>(),
    incrementalInfo: undefined,
    changedSourceFiles: [],
    deletedSourceFiles: [],
  }
  if (!isFullSync && hasHashRegistry(projectId)) {
    try {
      const { diff, currentHashes } = await detectChanges(projectPath, projectId, changedFilesHint)
      const totalChanged = diff.added.length + diff.modified.length + diff.deleted.length
      const result: IncrementalDetectResult = (() => {
        if (totalChanged === 0 && !changedFilesHint?.length) {
          // Nothing changed — skip expensive rebuilds.
          return {
            shouldRebuildIndexes: false,
            changedDomains: new Set<string>(),
            incrementalInfo: {
              isIncremental: true,
              filesChanged: 0,
              filesUnchanged: diff.unchanged.length,
              indexesRebuilt: false,
              affectedDomains: [],
            },
            changedSourceFiles: [],
            deletedSourceFiles: [],
          }
        }
        const propagated = propagateChanges(diff, projectId)
        const changedDomains = affectedDomains(propagated.allAffected)
        const shouldRebuildIndexes = propagated.allAffected.some(isSourceFile)
        return {
          shouldRebuildIndexes,
          changedDomains,
          incrementalInfo: {
            isIncremental: true,
            filesChanged: totalChanged,
            filesUnchanged: diff.unchanged.length,
            indexesRebuilt: shouldRebuildIndexes,
            affectedDomains: Array.from(changedDomains),
          },
          changedSourceFiles: [...diff.added, ...diff.modified].filter(isSourceFile),
          deletedSourceFiles: diff.deleted.filter(isSourceFile),
        }
      })()

      // Commit new hashes AFTER determining diff. Skip the DELETE-all +
      // re-INSERT rewrite when nothing changed: currentHashes is content-
      // identical to the stored registry, so persisting it would rewrite
      // every row for zero effect.
      if (totalChanged > 0) {
        saveHashes(projectId, currentHashes)
      }
      return result
    } catch (error) {
      log.debug('Incremental detection failed, falling back to full sync', {
        error: getErrorMessage(error),
      })
      // Fall through to full sync (shouldRebuildIndexes stays true).
    }
    return fullResult
  }
  // First sync or --full flag: compute + save hashes for next time.
  try {
    const { currentHashes } = await detectChanges(projectPath, projectId, changedFilesHint)
    saveHashes(projectId, currentHashes)
  } catch (error) {
    log.debug('Hash computation failed (non-critical)', { error: getErrorMessage(error) })
  }
  return fullResult
}

function isSourceFile(filePath: string): boolean {
  const ext = filePath.substring(filePath.lastIndexOf('.'))
  return SOURCE_EXTENSIONS.has(ext)
}
