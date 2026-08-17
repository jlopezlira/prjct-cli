#!/usr/bin/env node

/**
 * Portable package-manager entry point for prjct.
 *
 * npm/pnpm/yarn/bun generate Windows shims correctly for node shebangs, but
 * not for the historical bin/prjct POSIX shell launcher. Keep this file tiny
 * and dependency-free so global installs work on macOS, Linux, and Windows.
 */

const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const url = require('node:url')

const SCRIPT_PATH = fs.realpathSync(__filename)
const SCRIPT_DIR = path.dirname(SCRIPT_PATH)
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..')
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir()
const CLI_HOME = process.env.PRJCT_CLI_HOME
  ? path.resolve(process.env.PRJCT_CLI_HOME)
  : path.join(HOME, '.prjct-cli')
const SETUP_STAMP_PATH = path.join(CLI_HOME, 'state', 'setup-version.json')

function pathEntries() {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean)
}

function executableCandidates(command) {
  if (process.platform !== 'win32') return [command]
  const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((ext) => ext.toLowerCase())
  const ext = path.extname(command).toLowerCase()
  if (ext && pathext.includes(ext)) return [command]
  return pathext.map((candidateExt) => `${command}${candidateExt.toLowerCase()}`)
}

function findCommand(command) {
  for (const dir of pathEntries()) {
    for (const candidate of executableCandidates(command)) {
      const fullPath = path.join(dir, candidate)
      try {
        fs.accessSync(fullPath, fs.constants.X_OK)
        return fullPath
      } catch {
        /* keep searching */
      }
    }
  }
  return null
}

function nodeVersionOk() {
  const match = process.versions.node.match(/^(\d+)\.(\d+)\./)
  const major = Number.parseInt(match?.[1] || '0', 10)
  const minor = Number.parseInt(match?.[2] || '0', 10)
  return major > 22 || (major === 22 && minor >= 5)
}

function withSqliteFlag(env = process.env) {
  const existing = env.NODE_OPTIONS || ''
  const flag = '--experimental-sqlite'
  return {
    ...env,
    NODE_OPTIONS: existing.includes(flag) ? existing : `${flag}${existing ? ` ${existing}` : ''}`,
  }
}

function spawnAndExit(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    stdio: 'inherit',
    windowsHide: false,
    ...options,
  })

  if (result.error) {
    console.error(`Error: ${result.error.message}`)
    process.exit(1)
  }
  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  process.exit(result.status ?? 1)
}

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true })
  } catch {
    /* best effort */
  }
}

function copyIfNewer(src, dest) {
  try {
    if (!fs.existsSync(src)) return
    const srcStat = fs.statSync(src)
    const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null
    if (destStat && destStat.mtimeMs >= srcStat.mtimeMs) return
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
  } catch {
    /* best effort */
  }
}

function copyDirContents(srcDir, destDir) {
  try {
    if (!fs.existsSync(srcDir)) return
    fs.mkdirSync(destDir, { recursive: true })
    for (const entry of fs.readdirSync(srcDir)) {
      fs.copyFileSync(path.join(srcDir, entry), path.join(destDir, entry))
    }
  } catch {
    /* best effort */
  }
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8')).version || ''
  } catch {
    return ''
  }
}

function fileMissingWhenSourceExists(src, dest) {
  try {
    return fs.existsSync(src) && !fs.existsSync(dest)
  } catch {
    return false
  }
}

function readSetupStamp() {
  try {
    return JSON.parse(fs.readFileSync(SETUP_STAMP_PATH, 'utf-8'))
  } catch {
    return null
  }
}

function writeSetupStamp(version) {
  try {
    fs.mkdirSync(path.dirname(SETUP_STAMP_PATH), { recursive: true })
    fs.writeFileSync(
      SETUP_STAMP_PATH,
      `${JSON.stringify({ version, completedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf-8'
    )
  } catch {
    /* best effort */
  }
}

function shouldRunSetup(version) {
  const stamp = readSetupStamp()
  if (!stamp || stamp.version !== version) return true

  if (fs.existsSync(path.join(HOME, '.claude', 'commands', 'p.md'))) return true
  if (fs.existsSync(path.join(HOME, '.gemini', 'commands', 'p.toml'))) return true

  const statuslineSrc = path.join(ROOT_DIR, 'assets', 'statusline', 'statusline.sh')
  const statuslineDest = path.join(CLI_HOME, 'statusline', 'statusline.sh')
  if (fileMissingWhenSourceExists(statuslineSrc, statuslineDest)) return true

  const claudeSkillSrc = path.join(ROOT_DIR, 'templates', 'skills', 'prjct', 'SKILL.md')
  const claudeSkillDest = path.join(HOME, '.claude', 'skills', 'prjct', 'SKILL.md')
  if (fileMissingWhenSourceExists(claudeSkillSrc, claudeSkillDest)) return true

  return false
}

function ensureSetup() {
  removeIfExists(path.join(HOME, '.claude', 'commands', 'p.md'))
  removeIfExists(path.join(HOME, '.gemini', 'commands', 'p.toml'))

  const statuslineSrc = path.join(ROOT_DIR, 'assets', 'statusline', 'statusline.sh')
  const statuslineDir = path.join(CLI_HOME, 'statusline')
  const statuslineDest = path.join(statuslineDir, 'statusline.sh')
  const claudeStatusline = path.join(HOME, '.claude', 'prjct-statusline.sh')

  try {
    if (fs.existsSync(statuslineSrc)) {
      const needsCopy =
        !fs.existsSync(statuslineDest) ||
        fs.statSync(statuslineSrc).mtimeMs > fs.statSync(statuslineDest).mtimeMs
      if (needsCopy) {
        fs.mkdirSync(statuslineDir, { recursive: true })
        fs.copyFileSync(statuslineSrc, statuslineDest)
        fs.chmodSync(statuslineDest, 0o755)

        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'))
        if (pkg.version) {
          const patched = fs
            .readFileSync(statuslineDest, 'utf-8')
            .replace(/CLI_VERSION="[^"]*"/, `CLI_VERSION="${pkg.version}"`)
          fs.writeFileSync(statuslineDest, patched)
        }

        for (const subdir of ['lib', 'components', 'themes']) {
          copyDirContents(
            path.join(ROOT_DIR, 'assets', 'statusline', subdir),
            path.join(statuslineDir, subdir)
          )
        }

        fs.mkdirSync(path.dirname(claudeStatusline), { recursive: true })
        removeIfExists(claudeStatusline)
        try {
          fs.symlinkSync(statuslineDest, claudeStatusline)
        } catch {
          fs.copyFileSync(statuslineDest, claudeStatusline)
        }
        fs.chmodSync(claudeStatusline, 0o755)
      }
    }
  } catch {
    /* best effort */
  }

  copyIfNewer(
    path.join(ROOT_DIR, 'templates', 'skills', 'prjct', 'SKILL.md'),
    path.join(HOME, '.claude', 'skills', 'prjct', 'SKILL.md')
  )
}

function runMcpServer(args) {
  const mcpServer = path.join(ROOT_DIR, 'dist', 'mcp', 'server.mjs')
  if (!fs.existsSync(mcpServer)) {
    console.error("Error: MCP server entry point not found. Run 'npm run build' first.")
    process.exit(1)
  }
  if (!nodeVersionOk()) {
    console.error(
      `Error: prjct MCP needs Node >=22.5 (for node:sqlite) - found Node ${process.versions.node}.`
    )
    process.exit(1)
  }
  spawnAndExit(process.execPath, [mcpServer, ...args.slice(1)], { env: withSqliteFlag() })
}

function runWithNode(args) {
  const distBin = path.join(ROOT_DIR, 'dist', 'bin', 'prjct.mjs')

  if (!fs.existsSync(distBin)) {
    if (
      fs.existsSync(path.join(ROOT_DIR, 'scripts', 'build.js')) &&
      fs.existsSync(path.join(ROOT_DIR, 'core'))
    ) {
      console.error('Building for Node.js (first run)...')
      const build = childProcess.spawnSync(
        process.execPath,
        [path.join(ROOT_DIR, 'scripts', 'build.js')],
        {
          cwd: ROOT_DIR,
          stdio: 'inherit',
        }
      )
      if (build.status !== 0) {
        console.error("Error: Build failed. Run 'npm run build' manually.")
        process.exit(build.status ?? 1)
      }
    } else {
      console.error("Error: Compiled output not found. Run 'npm run build' first.")
      process.exit(1)
    }
  }

  if (!nodeVersionOk()) {
    console.error(
      `Error: prjct needs Node >=22.5 (for node:sqlite) - found Node ${process.versions.node}.`
    )
    console.error('  Upgrade Node (https://nodejs.org) or install Bun (https://bun.sh).')
    process.exit(1)
  }

  spawnAndExit(process.execPath, [distBin, ...args], { env: withSqliteFlag() })
}

/**
 * Fastest path: run the bundled entry IN-PROCESS under the node that already
 * booted to run this launcher — NO second runtime boot. The historical design
 * spawned a fresh bun/node process solely to inject `--experimental-sqlite`;
 * when node:sqlite loads WITHOUT that flag (node >=22.13 / >=23.4), the second
 * process is pure overhead (~40ms). The bundled `dist/bin/prjct.mjs` is a thin
 * cold-entry (daemon client) that reads process.argv directly — identical argv
 * in-process vs spawned — and calls process.exit() itself, so once imported it
 * OWNS the process.
 *
 * Returns true once the entry has started (caller must NOT fall through to a
 * spawn, or the command would run twice). Returns false only when in-process
 * load is not viable (old node, missing bundle, Windows, flagged sqlite) or
 * the module fails to load — then the caller falls back to the spawn path.
 */
async function runInProcess() {
  // Windows keeps the well-tested spawn path (shim/pathext nuances).
  if (process.platform === 'win32') return false
  const distBin = path.join(ROOT_DIR, 'dist', 'bin', 'prjct.mjs')
  if (!fs.existsSync(distBin) || !nodeVersionOk()) return false
  // node:sqlite still emits a one-time ExperimentalWarning on some versions →
  // suppress ONLY that warning class so stderr stays clean for `--md`
  // consumers without muting genuine sqlite-related warnings. Installed BEFORE
  // the probe below, which would otherwise trip the warning itself.
  const origEmit = process.emitWarning.bind(process)
  process.emitWarning = (warning, ...rest) => {
    const msg = typeof warning === 'string' ? warning : warning?.message || ''
    const name =
      (typeof warning === 'object' && warning?.name) ||
      (typeof rest[0] === 'string' ? rest[0] : rest[0]?.type) ||
      ''
    if (name === 'ExperimentalWarning' && typeof msg === 'string' && /sqlite/i.test(msg)) return
    return origEmit(warning, ...rest)
  }
  // In-process cannot inject NODE_OPTIONS, so node:sqlite must be loadable
  // WITHOUT --experimental-sqlite. That's node >=22.13 / >=23.4; on 22.5–22.12
  // the flag is still required. Probe instead of hardcoding version ranges —
  // if the un-flagged require throws, fall back to the spawn path (which
  // injects the flag) so those versions keep working.
  try {
    require('node:sqlite')
  } catch {
    process.emitWarning = origEmit
    return false
  }
  // V8 compile cache (node >=22.8): persists compiled bytecode for the core
  // bundle + its code-split chunks across cold starts (~23% off --version,
  // measured). Guarded because the node floor (22.5) predates
  // enableCompileCache; on older node this is a no-op. Best-effort: an
  // unwritable cache dir must never block the CLI.
  try {
    // NOTE: in CJS, bare `module` is the module wrapper, not node:module.
    const nodeModule = require('node:module')
    if (typeof nodeModule.enableCompileCache === 'function') {
      nodeModule.enableCompileCache(path.join(CLI_HOME, 'cache', 'compile-cache'))
    }
  } catch {
    /* best effort */
  }
  try {
    // Resolves when the entry's top-level finishes; the entry keeps the event
    // loop alive (daemon socket / core fallback) and exits the process itself.
    await import(url.pathToFileURL(distBin).href)
    return true
  } catch {
    // Module failed to load in-process — restore warnings and fall back.
    process.emitWarning = origEmit
    return false
  }
}

function runWithBun(args) {
  if (process.platform === 'win32') return false
  const distBin = path.join(ROOT_DIR, 'dist', 'bin', 'prjct.mjs')
  const bun = findCommand('bun')
  if (!bun || !fs.existsSync(distBin)) return false
  spawnAndExit(bun, [distBin, ...args])
  return true
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === 'mcp-server') runMcpServer(args)

  const setupSkipCommands = new Set([
    '-v',
    '--version',
    'version',
    '-h',
    '--help',
    'help',
    'eval',
    'hook',
    '__internal-auto-update',
    '__post-upgrade',
    '__internal-ensure-daemon',
  ])
  const version = packageVersion()
  if (!setupSkipCommands.has(args[0]) && shouldRunSetup(version)) {
    ensureSetup()
    writeSetupStamp(version)
  }

  // Fastest first: run the entry in-process under this node (no second boot).
  // Only falls through to a spawned runtime if in-process load isn't viable.
  if (await runInProcess()) return
  if (runWithBun(args)) return
  runWithNode(args)
}

main().catch((error) => {
  console.error(`Error: ${error?.message || error}`)
  process.exit(1)
})
