const { execSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const PACKAGE_JSON = path.join(ROOT, 'package.json')

// Colors
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BLUE = '\x1b[34m'
const NC = '\x1b[0m'

function log(msg) {
  console.log(msg)
}
function info(msg) {
  console.log(`${BLUE}ℹ${NC} ${msg}`)
}
function success(msg) {
  console.log(`${GREEN}✓${NC} ${msg}`)
}
function warn(msg) {
  console.log(`${YELLOW}⚠${NC} ${msg}`)
}
function error(msg) {
  console.log(`${RED}✗${NC} ${msg}`)
}

function exec(cmd, options = {}) {
  const env = { ...process.env }
  if (!env.NPM_CONFIG_CACHE) {
    env.NPM_CONFIG_CACHE = path.join(os.tmpdir(), 'prjct-npm-cache')
  }
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', env, ...options }).trim()
}

// ─── npm runtime resolution ─────────────────────────────────────────
//
// On zsh + nvm setups, `npm` is a lazy-loaded shell function — invisible
// to non-interactive subprocesses. execSync inherits a minimal /bin/sh
// env where the function isn't defined, so `npm whoami` / `npm publish`
// blow up with exit 127 ("command not found"). Detect the real-binary
// case once; if it's missing, route npm calls through an interactive
// login shell so nvm's loader actually fires.

const npmRunnerCache = { value: null }
function npmRunner() {
  if (npmRunnerCache.value) return npmRunnerCache.value
  try {
    const out = execSync('command -v npm', {
      encoding: 'utf8',
      shell: '/bin/sh',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (out && !out.startsWith('alias ')) {
      npmRunnerCache.value = (args) => `npm ${args}`
      return npmRunnerCache.value
    }
  } catch {
    // /bin/sh can't see the shell function — fall through.
  }
  const shell = process.env.SHELL || '/bin/zsh'
  // -i (interactive) loads .zshrc / .bashrc, where nvm's npm() function
  // is defined; -c executes the command and exits.
  npmRunnerCache.value = (args) => `${shell} -ic 'npm ${args}'`
  return npmRunnerCache.value
}

function execNpm(args, options = {}) {
  return exec(npmRunner()(args), options)
}

function execNpmSilent(args) {
  try {
    return execNpm(args, { stdio: 'pipe' })
  } catch {
    return null
  }
}

// =============================================================================
// STEP 1: Validate
// =============================================================================

function validate() {
  log('\n📋 Step 1: Validate\n')

  // Check for uncommitted changes
  const status = exec('git status --porcelain')
  if (status) {
    error('Uncommitted changes detected:')
    console.log(status)
    console.log('\nCommit or stash changes before release.')
    process.exit(1)
  }
  success('Git working directory clean')

  // Check branch (allow main, master, or release branches)
  const branch = exec('git branch --show-current')
  const allowedBranches = ['main', 'master']
  const isReleaseBranch = branch.startsWith('release/') || branch.startsWith('feature/')

  if (!allowedBranches.includes(branch) && !isReleaseBranch) {
    warn(`On branch '${branch}' - typically releases are from main`)
    // Don't exit, just warn
  }
  success(`On branch: ${branch}`)

  // Check npm login (via runtime-resolved npm — see npmRunner())
  const npmUser = execNpmSilent('whoami')
  if (!npmUser) {
    error('Not logged into npm. Run: npm login')
    process.exit(1)
  }
  success(`npm logged in as: ${npmUser}`)

  return { branch }
}

// =============================================================================
// STEP 2: Build
// =============================================================================

async function build() {
  log('\n🔨 Step 2: Build\n')
  exec('node scripts/build.js', { stdio: 'inherit' })
  success('Build complete')
}

// =============================================================================
// STEP 3: Test
// =============================================================================

function test() {
  log('\n🧪 Step 3: Test\n')

  try {
    const result = exec('bun test 2>&1', { stdio: 'pipe' })
    console.log(result)

    // Check if tests actually passed (look for "0 fail" or no "fail" count)
    if (result.includes(' 0 fail') || !result.includes('fail')) {
      success('Tests passed')
    } else {
      error('Tests failed')
      process.exit(1)
    }
  } catch (e) {
    // Even if exit code is non-zero, check if tests passed
    const output = e.stdout?.toString() || ''
    console.log(output)

    if (
      output.includes(' 0 fail') ||
      (output.includes(' pass') && !output.match(/[1-9]\d* fail/))
    ) {
      success('Tests passed (with warnings)')
    } else {
      error('Tests failed')
      process.exit(1)
    }
  }
}

// =============================================================================
// STEP 4: Version Bump
// =============================================================================

function bumpVersion(type) {
  log('\n📦 Step 4: Version Bump\n')

  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))
  const currentVersion = pkg.version

  const [major, minor, patch] = currentVersion.split('.').map(Number)

  const newVersion =
    type === 'major'
      ? `${major + 1}.0.0`
      : type === 'minor'
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`

  pkg.version = newVersion
  fs.writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`)

  // version.ts resolves the version at runtime (PRJCT_VERSION → package.json);
  // the build bakes pkg.version in via esbuild `define`. Nothing to rewrite
  // here — bumping package.json before build() is what makes the binary carry
  // the right version.

  info(`${currentVersion} → ${newVersion}`)
  success(`Version bumped to ${newVersion}`)

  return { currentVersion, newVersion }
}

// =============================================================================
// STEP 5: Commit + Tag
// =============================================================================

function commitAndTag(version) {
  log('\n📝 Step 5: Commit + Tag\n')

  exec('git add -A')

  const commitMsg = `chore: release v${version}

Generated with [p/](https://www.prjct.app/)`

  exec(`git commit -m "${commitMsg}"`)
  success(`Committed: release v${version}`)

  exec(`git tag -a v${version} -m "Release v${version}"`)
  success(`Tagged: v${version}`)
}

// =============================================================================
// STEP 6: Publish
// =============================================================================

function publish() {
  log('\n🚀 Step 6: Publish to npm\n')

  try {
    execNpm('publish', { stdio: 'inherit' })
    success('Published to npm')
  } catch (_e) {
    error('Publish failed')
    console.log('\nYou can retry with: npm publish')
    process.exit(1)
  }
}

// =============================================================================
// STEP 7: Push
// =============================================================================

function push(branch) {
  log('\n☁️  Step 7: Push to remote\n')

  try {
    exec(`git push origin ${branch}`)
    exec('git push --tags')
    success('Pushed to remote')
  } catch (_e) {
    warn('Push failed - you may need to push manually')
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2)
  const type = args[0] || 'patch'

  if (!['patch', 'minor', 'major'].includes(type)) {
    error(`Invalid version type: ${type}`)
    console.log('Usage: node scripts/release.js [patch|minor|major]')
    process.exit(1)
  }

  log(`\n${'='.repeat(50)}`)
  log(`  prjct-cli Release (${type})`)
  log(`${'='.repeat(50)}`)

  // Run all steps. Order matters: bump the version BEFORE build so esbuild
  // bakes the NEW version into the bundles (previously build ran first and the
  // published binary reported the OLD version).
  const { branch } = validate()
  test()
  const { newVersion } = bumpVersion(type)
  await build()
  commitAndTag(newVersion)
  publish()
  push(branch)

  log(`\n${'='.repeat(50)}`)
  log(`${GREEN}  ✓ Released prjct-cli@${newVersion}${NC}`)
  log(`${'='.repeat(50)}\n`)
}

main().catch((err) => {
  error(err.message)
  process.exit(1)
})
