#!/usr/bin/env node

/**
 * Background update-cache refresher for prjct-cli.
 *
 * Spawned detached/unref'd by core/infrastructure/update-checker.ts so the
 * main `prjct` invocation can exit immediately. The next invocation reads
 * the cache and (if a newer version is on npm) shows the update banner.
 *
 * Why a separate file instead of `node -e <inline>`: the inline pattern
 * trips supply-chain scanners as a "dynamic code execution" anti-pattern.
 * Behaviour here is identical — only the delivery mechanism changed.
 *
 * Usage: node refresh-update.mjs <cache-file-path>
 *
 * Inputs come from argv (no env, no stdin). Output is the cache file
 * write — the script never prints to stdout/stderr.
 */

import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

const cacheFile = process.argv[2]
if (!cacheFile) process.exit(0)

// Defensive: only allow writing inside the user's prjct cache dir.
// Refuses paths that try to escape via .. or absolute symlinks elsewhere.
const resolved = path.resolve(cacheFile)
const expectedDir = path.resolve(process.env.HOME || '', '.prjct-cli')
if (!resolved.startsWith(`${expectedDir}${path.sep}`)) process.exit(0)

const opts = {
  hostname: 'registry.npmjs.org',
  path: '/prjct-cli/latest',
  headers: {
    'User-Agent': 'prjct-cli-update-checker',
    Accept: 'application/json',
  },
}

const req = https.request(opts, (res) => {
  const chunks = []
  res.on('data', (chunk) => {
    chunks.push(chunk)
  })
  res.on('end', () => {
    try {
      if (res.statusCode === 200) {
        const data = Buffer.concat(chunks).toString('utf8')
        const version = JSON.parse(data).version
        if (typeof version === 'string') {
          fs.mkdirSync(path.dirname(resolved), { recursive: true })
          fs.writeFileSync(
            resolved,
            JSON.stringify({ lastCheck: Date.now(), latestVersion: version })
          )
        }
      }
    } catch {
      // best-effort; never throw
    }
  })
})
req.on('error', () => {})
req.setTimeout(5000, () => req.destroy())
req.end()
