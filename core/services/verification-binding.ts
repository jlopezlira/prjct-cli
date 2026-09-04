import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { runGit } from '../utils/exec'
import { hashBlobContent, stampProjectPaths } from './content-bound-stamp'

export const VerificationBindingSchema = z.object({
  version: z.literal(1),
  treeHash: z.string(),
  revisionHash: z.string().optional(),
  planHash: z.string(),
  headSha: z.string().nullable(),
})
export type VerificationBinding = z.infer<typeof VerificationBindingSchema>

/** Sort object keys, preserving array order (command/probe order is semantic). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    )
  }
  return value
}

/** Complete live checkout, including nonignored new files; no diagnostic-path cap. */
export async function verificationBinding(
  projectPath: string,
  plan: unknown
): Promise<VerificationBinding | null> {
  try {
    const files = await checkoutPaths(projectPath)
    const head = await runGit(['rev-parse', 'HEAD'], { cwd: projectPath })
    if (!head.ok) return null
    const paths = [...new Set(files)].sort()
    const revisionHash = await revisionOf(projectPath, paths)
    const stamp = await stampProjectPaths(projectPath, paths, {
      stampedAt: new Date().toISOString(),
      strict: true,
    })
    if (revisionHash !== (await revisionOf(projectPath, paths))) return null
    return {
      revisionHash,
      version: 1,
      treeHash: stamp.treeHash,
      planHash: hashBlobContent(JSON.stringify(canonical(plan))),
      headSha: head.stdout.trim(),
    }
  } catch {
    return null
  }
}

/** Include initialized nested worktrees; missing or recursive gitlinks fail closed. */
async function checkoutPaths(root: string, ancestors = new Set<string>()): Promise<string[]> {
  const real = await fs.realpath(root)
  if (ancestors.has(real) || ancestors.size >= 16) throw new Error('Recursive submodule tree')
  const seen = new Set([...ancestors, real])
  const [files, staged] = await Promise.all([
    runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }),
    runGit(['ls-files', '--stage', '-z'], { cwd: root }),
  ])
  if (!files.ok || !staged.ok) throw new Error('Cannot enumerate checkout')
  const paths = files.stdout.split('\0').filter(Boolean)
  for (const entry of staged.stdout.split('\0')) {
    if (!entry.startsWith('160000 ')) continue
    const relative = entry.slice(entry.indexOf('\t') + 1)
    const child = path.join(root, relative)
    // Git otherwise discovers the parent's repository for an uninitialized gitlink.
    await fs.lstat(path.join(child, '.git'))
    paths.push(...(await checkoutPaths(child, seen)).map((file) => path.join(relative, file)))
  }
  return paths
}

export function sameVerification(
  a: VerificationBinding | null | undefined,
  b: VerificationBinding | null | undefined
): boolean {
  return Boolean(
    a &&
      b &&
      a.version === b.version &&
      a.treeHash === b.treeHash &&
      a.planHash === b.planHash &&
      a.headSha === b.headSha
  )
}

/** Runtime-only mutation signal detects edit-and-restore during a verification run. */
async function revisionOf(root: string, paths: string[]): Promise<string> {
  const rows: unknown[] = []
  for (const offset of Array.from({ length: Math.ceil(paths.length / 64) }, (_, i) => i * 64)) {
    rows.push(
      ...(await Promise.all(
        paths.slice(offset, offset + 64).map(async (file) => {
          try {
            const stat = await fs.lstat(path.join(root, file), { bigint: true })
            return [
              file,
              String(stat.ino),
              String(stat.size),
              String(stat.mtimeNs),
              String(stat.ctimeNs),
            ]
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [file, 'missing']
            throw error
          }
        })
      ))
    )
  }
  return hashBlobContent(JSON.stringify(rows))
}

export function unchangedDuringVerification(
  a: VerificationBinding | null,
  b: VerificationBinding | null
): boolean {
  return sameVerification(a, b) && Boolean(a?.revisionHash && a.revisionHash === b?.revisionHash)
}
