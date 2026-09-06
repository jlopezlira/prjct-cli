/**
 * Installs the thin pi transport beside the native skill. CLI owns all policy.
 * Hash receipts prevent upgrades from replacing customized extension files.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getTemplateContent } from '../agentic/template-loader'
import { PRJCT_HOOKS } from '../services/settings-installer'
import { sha256 } from '../utils/hash'

type ManagedReceipt = Record<string, string | string[]>

function bridgeContent(): Array<{ file: string; body: string }> {
  return [
    ...['index.ts', 'bridge.mjs'].map((file) => {
      const body = getTemplateContent(`pi/${file}`)
      if (!body) throw new Error(`Pi bridge template missing: ${file}`)
      return { file, body }
    }),
    { file: 'hooks.json', body: `${JSON.stringify(PRJCT_HOOKS, null, 2)}\n` },
  ]
}

async function writeAtomically(destination: string, body: string): Promise<void> {
  if ((await fs.readFile(destination, 'utf8').catch(() => null)) === body) return
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, body, { flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, destination)
  } finally {
    await fs.unlink(temporary).catch(() => undefined)
  }
}

export async function hasPiBridge(agentDir: string): Promise<boolean> {
  try {
    const dir = path.join(agentDir, 'extensions', 'prjct')
    if (!(await fs.lstat(dir)).isDirectory()) return false
    for (const { file, body } of bridgeContent()) {
      const destination = path.join(dir, file)
      if (!(await fs.lstat(destination)).isFile()) return false
      if ((await fs.readFile(destination, 'utf8')) !== body) return false
    }
    return true
  } catch {
    return false
  }
}

/** Remove the managed hook bundle only after every existing file passes provenance checks. */
export async function uninstallPiBridge(agentDir: string): Promise<void> {
  const dir = path.join(agentDir, 'extensions', 'prjct')
  for (const parent of [path.dirname(dir), dir]) {
    const stat = await fs.lstat(parent).catch(() => null)
    if (stat && !stat.isDirectory()) throw new Error(`Preserved non-directory pi bridge: ${parent}`)
  }
  const receiptPath = path.join(dir, 'managed.json')
  const receiptStat = await fs.lstat(receiptPath).catch(() => null)
  if (receiptStat && !receiptStat.isFile())
    throw new Error(`Preserved non-regular pi receipt: ${receiptPath}`)
  const receipt: ManagedReceipt = await fs
    .readFile(receiptPath, 'utf8')
    .then(JSON.parse)
    .catch(() => ({}))
  const files: string[] = []
  for (const { file, body } of bridgeContent()) {
    const destination = path.join(dir, file)
    const stat = await fs.lstat(destination).catch(() => null)
    if (!stat) continue
    if (!stat.isFile()) throw new Error(`Preserved non-regular pi bridge file: ${destination}`)
    const existing = await fs.readFile(destination, 'utf8')
    const hashes = Array.isArray(receipt?.[file]) ? receipt[file] : [receipt?.[file]]
    if (existing !== body && !hashes.includes(sha256(existing)))
      throw new Error(`Preserved customized pi bridge: ${destination}`)
    files.push(destination)
  }
  for (const file of files) await fs.unlink(file)
  if (receiptStat) await fs.unlink(receiptPath)
  await fs.rmdir(dir).catch(() => undefined)
}

export async function installPiBridge(
  agentDir: string,
  skill?: { content: string; acceptsExisting: (existing: string) => boolean }
): Promise<void> {
  const dir = path.join(agentDir, 'extensions', 'prjct')
  const receiptPath = path.join(dir, 'managed.json')
  const receipt: ManagedReceipt = await fs
    .readFile(receiptPath, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    })
    .catch(() => ({}))
  const content = bridgeContent().map((entry) => ({
    ...entry,
    destination: path.join(dir, entry.file),
  }))
  if (skill)
    content.push({
      file: 'SKILL.md',
      body: skill.content,
      destination: path.join(agentDir, 'skills', 'prjct', 'SKILL.md'),
    })
  const dirStat = await fs.lstat(dir).catch(() => null)
  if (dirStat?.isSymbolicLink()) throw new Error(`Preserved symlinked pi bridge: ${dir}`)
  const receiptStat = await fs.lstat(receiptPath).catch(() => null)
  if (receiptStat && !receiptStat.isFile())
    throw new Error(`Preserved non-regular pi receipt: ${receiptPath}`)
  const pending: ManagedReceipt = { ...receipt }
  // Record both pre-update and intended hashes before atomic replacements, so
  // an interrupted bundle can be retried without treating our own files as custom.
  for (const { file, body, destination } of content) {
    const parents = path.relative(agentDir, path.dirname(destination)).split(path.sep)
    for (const index of parents.keys()) {
      const parentPath = path.join(agentDir, ...parents.slice(0, index + 1))
      const parent = await fs.lstat(parentPath).catch(() => null)
      if (parent?.isSymbolicLink())
        throw new Error(`Preserved symlinked pi directory: ${parentPath}`)
    }
    const stat = await fs.lstat(destination).catch(() => null)
    const hashes = Array.isArray(receipt[file]) ? receipt[file] : [receipt[file]]
    if (stat) {
      if (!stat.isFile()) throw new Error(`Preserved non-regular pi bridge file: ${destination}`)
      const existing = await fs.readFile(destination, 'utf8')
      if (
        existing !== body &&
        !hashes.includes(sha256(existing)) &&
        !(file === 'SKILL.md' && skill?.acceptsExisting(existing))
      ) {
        throw new Error(`Preserved customized pi bridge: ${destination}`)
      }
      pending[file] = [sha256(existing), sha256(body)]
    } else {
      pending[file] = sha256(body)
    }
  }
  await fs.mkdir(dir, { recursive: true })
  await writeAtomically(receiptPath, JSON.stringify(pending))
  for (const { body, destination } of content) {
    if ((await fs.readFile(destination, 'utf8').catch(() => null)) !== body) {
      await writeAtomically(destination, body)
    }
  }
  await writeAtomically(
    receiptPath,
    JSON.stringify({
      ...receipt,
      ...Object.fromEntries(content.map(({ file, body }) => [file, sha256(body)])),
    })
  )
}
