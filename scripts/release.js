#!/usr/bin/env node
/**
 * Release wrapper — dispatches the canonical Release GitHub workflow.
 *
 * The release pipeline lives in .github/workflows/release.yml (version bump
 * from conventional commits, CHANGELOG generation, native binary matrix,
 * npm publish via OIDC trusted publishing). It runs automatically on every
 * push to main; this script exists only to trigger a manual run — do NOT
 * reimplement bump/publish locally.
 *
 * Usage:
 *   node scripts/release.js [--dry-run] [--yes]
 *
 *   --dry-run  Run the full workflow without commit/tag/push/publish.
 *   --yes      Skip the confirmation prompt (for scripts).
 *
 * To control the version explicitly, bump package.json (+ CHANGELOG.md entry)
 * and push to main — the workflow's manual-bump path honours a package.json
 * version newer than the last tag.
 */

const { execSync, spawnSync } = require('node:child_process')
const readline = require('node:readline')

const WORKFLOW = 'release.yml'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const assumeYes = args.includes('--yes')

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function ghAvailable() {
  const result = spawnSync('gh', ['--version'], { stdio: 'pipe' })
  return result.status === 0
}

function ghAuthed() {
  const result = spawnSync('gh', ['auth', 'status'], { stdio: 'pipe' })
  return result.status === 0
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

async function main() {
  console.log('The GitHub Release workflow (.github/workflows/release.yml) is the')
  console.log('canonical release path: it computes the version bump from conventional')
  console.log('commits, updates CHANGELOG.md, builds native binaries, and publishes')
  console.log('to npm via trusted publishing. Every push to main already triggers it.\n')

  if (!ghAvailable()) fail('gh CLI not found. Install: https://cli.github.com/')
  if (!ghAuthed()) fail('gh is not authenticated. Run: gh auth login')

  const mode = dryRun ? 'DRY RUN (no commit/tag/publish)' : 'REAL RELEASE'
  console.log(`About to dispatch ${WORKFLOW} on main — ${mode}.`)
  if (!assumeYes) {
    const ok = await confirm('Proceed?')
    if (!ok) {
      console.log('Aborted.')
      process.exit(0)
    }
  }

  execSync(`gh workflow run ${WORKFLOW} --ref main -f dry_run=${dryRun ? 'true' : 'false'}`, {
    stdio: 'inherit',
  })

  console.log('\n✓ Workflow dispatched. Track it with:')
  console.log(`  gh run list --workflow=${WORKFLOW} --limit 1`)
  console.log(
    `  gh run watch $(gh run list --workflow=${WORKFLOW} --limit 1 --json databaseId --jq '.[0].databaseId')`
  )
}

main().catch((err) => fail(err.message))
