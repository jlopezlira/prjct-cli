/**
 * Context Save / Restore — `prjct context-save` / `prjct context-restore`
 *
 * Inspired by gstack's /context-save + /context-restore. Captures
 * working state (git snapshot, decisions, remaining work, notes) into
 * a stable on-disk checkpoint so a future session — even on a
 * different branch or workspace — can resume without losing a beat.
 *
 * Storage layout:
 *   ~/.prjct-cli/projects/<projectId>/checkpoints/
 *     YYYY-MM-DD-HH-mm-ss--<slug>.json
 *
 * Each checkpoint is a small JSON document, self-describing, no schema
 * migration required. Restore reads the newest by default.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import pathManager from '../infrastructure/path-manager'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { execAsync, execFileAsync } from '../utils/exec'
import { failHard } from '../utils/md-aware'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'
import { requireProject } from './guards'

interface ContextCheckpoint {
  /** Schema version for the JSON document. */
  version: 1
  title: string
  createdAt: string
  /** Branch + git status snapshot at save time. */
  git: {
    branch: string
    head: string | null
    statusShort: string[]
    diffStat: string
    recentLog: string[]
  }
  /** Inline notes the user / Claude can use to resume. Free-form. */
  notes: string
}

const SLUG_LIMIT = 50

export class ContextCheckpointCommands extends PrjctCommandsBase {
  /**
   * `prjct context-save [title]` — capture current state.
   */
  async save(
    title: string | null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; notes?: string } = {}
  ): Promise<CommandResult> {
    try {
      const pid = await requireProject(projectPath)
      if (!pid.ok) return pid.result

      const cleanTitle = (title ?? 'untitled').trim().slice(0, 200) || 'untitled'
      const git = await captureGitSnapshot(projectPath)

      const checkpoint: ContextCheckpoint = {
        version: 1,
        title: cleanTitle,
        createdAt: new Date().toISOString(),
        git,
        notes: (options.notes ?? '').trim(),
      }

      const dir = checkpointDir(pid.value)
      await fs.mkdir(dir, { recursive: true })
      const filename = makeFilename(checkpoint.createdAt, cleanTitle)
      const filepath = path.join(dir, filename)
      await fs.writeFile(filepath, JSON.stringify(checkpoint, null, 2), 'utf-8')

      if (options.md) {
        console.log(
          `## context-save\n\n- **Title**: ${cleanTitle}\n- **Branch**: ${git.branch}\n- **Saved at**: ${checkpoint.createdAt}\n- **File**: \`${filename}\`\n`
        )
      } else {
        out.done(`saved: ${filename}`)
      }
      return { success: true, file: filename, title: cleanTitle }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }

  /**
   * `prjct context-restore [--list | --file <name>]` — return the most
   * recent checkpoint (or a named one) so the caller can recover state.
   */
  async restore(
    arg: string | null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; list?: boolean; file?: string } = {}
  ): Promise<CommandResult> {
    try {
      const pid = await requireProject(projectPath)
      if (!pid.ok) return pid.result

      const dir = checkpointDir(pid.value)
      const exists = await fs
        .stat(dir)
        .then((s) => s.isDirectory())
        .catch(() => false)
      if (!exists) {
        if (options.md) console.log('## context-restore\n\n_No checkpoints saved yet._\n')
        else out.info('no checkpoints saved yet')
        return { success: true, checkpoint: null }
      }

      const files = (await fs.readdir(dir))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
      if (files.length === 0) {
        if (options.md) console.log('## context-restore\n\n_No checkpoints saved yet._\n')
        else out.info('no checkpoints saved yet')
        return { success: true, checkpoint: null }
      }

      if (options.list) {
        if (options.md) {
          const rows = files
            .slice(0, 25)
            .map((f) => `- \`${f}\``)
            .join('\n')
          console.log(`## context-restore — checkpoints\n\n${rows}\n`)
        } else {
          for (const f of files.slice(0, 25)) console.log(f)
        }
        return { success: true, files: files.length }
      }

      const target = options.file ?? arg ?? files[0]
      const targetPath = path.join(dir, path.basename(target))
      const raw = await fs.readFile(targetPath, 'utf-8').catch(() => null)
      if (!raw) {
        out.fail(`Checkpoint not found: ${target}`)
        return { success: false, error: 'Checkpoint not found' }
      }
      const checkpoint = JSON.parse(raw) as ContextCheckpoint

      if (options.md) {
        console.log(formatRestoreMarkdown(checkpoint, path.basename(target)))
      } else {
        console.log(formatRestoreText(checkpoint, path.basename(target)))
      }
      return { success: true, checkpoint, file: path.basename(target) }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }
}

// Helpers

function checkpointDir(projectId: string): string {
  return path.join(pathManager.getGlobalProjectPath(projectId), 'checkpoints')
}

function makeFilename(createdAt: string, title: string): string {
  const stamp = createdAt.replace(/[:.]/g, '-').slice(0, 19) // 2026-05-02T12-34-56
  const slug = slugify(title)
  return `${stamp}--${slug}.json`
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_LIMIT) || 'untitled'
  )
}

async function captureGitSnapshot(projectPath: string): Promise<ContextCheckpoint['git']> {
  // Each git command can fail (no repo, no HEAD); treat each as
  // best-effort so save still produces a usable checkpoint.
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn()
    } catch {
      return fallback
    }
  }

  const branch = (
    await safe(
      async () =>
        (
          await execFileAsync('git', ['branch', '--show-current'], { cwd: projectPath })
        ).stdout,
      ''
    )
  ).trim()

  const head = (
    await safe(
      async () => (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectPath })).stdout,
      ''
    )
  ).trim()

  const statusShort = (
    await safe(
      async () => (await execFileAsync('git', ['status', '--short'], { cwd: projectPath })).stdout,
      ''
    )
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const diffStat = (
    await safe(
      async () => (await execFileAsync('git', ['diff', '--stat'], { cwd: projectPath })).stdout,
      ''
    )
  ).trim()

  const recentLog = (
    await safe(
      async () => (await execAsync('git log --oneline -10', { cwd: projectPath })).stdout,
      ''
    )
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  return { branch: branch || 'unknown', head: head || null, statusShort, diffStat, recentLog }
}

function formatRestoreText(c: ContextCheckpoint, filename: string): string {
  const lines: string[] = []
  lines.push(`Restoring: ${filename}`)
  lines.push(`Title:     ${c.title}`)
  lines.push(`Branch:    ${c.git.branch}`)
  lines.push(`Saved at:  ${c.createdAt}`)
  if (c.notes) {
    lines.push('')
    lines.push('Notes:')
    lines.push(c.notes)
  }
  if (c.git.statusShort.length > 0) {
    lines.push('')
    lines.push('Working tree at save time:')
    for (const l of c.git.statusShort.slice(0, 20)) lines.push(`  ${l}`)
  }
  if (c.git.recentLog.length > 0) {
    lines.push('')
    lines.push('Recent commits:')
    for (const l2 of c.git.recentLog) lines.push(`  ${l2}`)
  }
  return lines.join('\n')
}

function formatRestoreMarkdown(c: ContextCheckpoint, filename: string): string {
  const lines: string[] = []
  lines.push(`## context-restore — \`${filename}\``)
  lines.push('')
  lines.push(`- **Title**: ${c.title}`)
  lines.push(`- **Branch**: ${c.git.branch}`)
  lines.push(`- **Saved at**: ${c.createdAt}`)
  lines.push('')
  if (c.notes) {
    lines.push('### Notes')
    lines.push('')
    lines.push(c.notes)
    lines.push('')
  }
  if (c.git.statusShort.length > 0) {
    lines.push('### Working tree at save time')
    lines.push('')
    lines.push('```')
    for (const l of c.git.statusShort.slice(0, 20)) lines.push(l)
    lines.push('```')
    lines.push('')
  }
  if (c.git.recentLog.length > 0) {
    lines.push('### Recent commits')
    lines.push('')
    for (const l2 of c.git.recentLog) lines.push(`- ${l2}`)
  }
  return lines.join('\n')
}
