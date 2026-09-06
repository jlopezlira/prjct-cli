/**
 * Installs the thin pi transport beside the native skill. CLI owns all policy.
 * Hash receipts prevent upgrades from replacing customized extension files.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { getTemplateContent } from '../agentic/template-loader'
import { sha256 } from '../utils/hash'

export async function installPiBridge(agentDir: string): Promise<void> {
  const dir = path.join(agentDir, 'extensions', 'prjct')
  const receiptPath = path.join(dir, 'managed.json')
  const receipt: Record<string, string> = await fs
    .readFile(receiptPath, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => ({}))
  const files = ['index.ts', 'bridge.mjs']
  const content = files.map((file) => {
    const body = getTemplateContent(`pi/${file}`)
    if (!body) throw new Error(`Pi bridge template missing: ${file}`)
    return { file, body }
  })
  const dirStat = await fs.lstat(dir).catch(() => null)
  if (dirStat?.isSymbolicLink()) throw new Error(`Preserved symlinked pi bridge: ${dir}`)
  // Preflight the whole pair before changing either file.
  for (const { file, body } of content) {
    const destination = path.join(dir, file)
    const stat = await fs.lstat(destination).catch(() => null)
    if (!stat) continue
    if (!stat.isFile()) throw new Error(`Preserved non-regular pi bridge file: ${destination}`)
    const existing = await fs.readFile(destination, 'utf8')
    if (existing !== body && sha256(existing) !== receipt[file]) {
      throw new Error(`Preserved customized pi bridge: ${destination}`)
    }
  }
  await fs.mkdir(dir, { recursive: true })
  for (const { file, body } of content) {
    const destination = path.join(dir, file)
    if ((await fs.readFile(destination, 'utf8').catch(() => null)) !== body) {
      await fs.writeFile(destination, body, 'utf8')
    }
  }
  await fs.writeFile(
    receiptPath,
    JSON.stringify(Object.fromEntries(content.map(({ file, body }) => [file, sha256(body)]))),
    'utf8'
  )
}
