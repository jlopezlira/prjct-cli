#!/usr/bin/env node

/**
 * Build Script for prjct-cli
 *
 * Produces a complete dist/ for npm publishing:
 * - dist/bin/prjct.mjs     CLI entry point (ESM, minified, sourcemapped)
 * - dist/templates.json    All templates bundled into single JSON
 *
 * @version 3.0.0
 */

const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

/**
 * Ensure esbuild is available
 */
function ensureEsbuild() {
  try {
    require.resolve('esbuild')
    return true
  } catch {
    console.log('Installing esbuild...')
    try {
      execSync('npm install esbuild --save-dev', { cwd: ROOT, stdio: 'inherit' })
      return true
    } catch (error) {
      console.error('Failed to install esbuild:', error.message)
      return false
    }
  }
}

/**
 * Clean and create dist directory
 */
function clean() {
  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true })
  }
  fs.mkdirSync(DIST, { recursive: true })
  fs.mkdirSync(path.join(DIST, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(DIST, 'cli'), { recursive: true })
  fs.mkdirSync(path.join(DIST, 'daemon'), { recursive: true })
  fs.mkdirSync(path.join(DIST, 'mcp'), { recursive: true })
}

/**
 * esbuild plugin: strip shebangs from source files.
 * Prevents double-shebang when banner also injects one.
 */
function stripShebangPlugin() {
  return {
    name: 'strip-shebang',
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        const source = await require('node:fs/promises').readFile(args.path, 'utf-8')
        if (!source.startsWith('#!')) return undefined
        return {
          contents: source.replace(/^#![^\n]*\n/, ''),
          loader: args.path.endsWith('.ts') ? 'ts' : 'js',
        }
      })
    },
  }
}

/**
 * Build CLI entry point plus tracker CLIs
 */
async function buildJs() {
  const esbuild = require('esbuild')

  // Bake the package version into every bundle. getVersion() (core/utils/
  // version.ts) reads process.env.PRJCT_VERSION FIRST, so this static
  // replacement makes the built CLI always report its own version — no
  // walking up __dirname into a stale duplicate install's package.json.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
  const versionDefine = { 'process.env.PRJCT_VERSION': JSON.stringify(pkg.version) }
  console.log(`  → baking version ${pkg.version}`)

  // 1a. CLI core bundle (heavy, only loaded when daemon unavailable)
  console.log('  → dist/bin/prjct-core.mjs')
  const mainResult = await esbuild.build({
    entryPoints: [path.join(ROOT, 'bin/prjct.ts')],
    outfile: path.join(DIST, 'bin', 'prjct-core.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    minify: true,
    keepNames: true,
    packages: 'external',
    metafile: true,
    define: versionDefine,
    banner: {
      js: `import { createRequire as __createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __pathDirname } from 'path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __pathDirname(__filename);`,
    },
  })

  // 1a-hooks. Dedicated COLD-hook bundle (~136KB vs the ~936KB core).
  // The shim's cold-hook fallback imports THIS instead of prjct-core.mjs, so a
  // freshly-spawned hook parses only its real dependency closure (the 10 hook
  // runners share almost all their deps) instead of the whole CLI. This is the
  // dominant cost the hot-path benchmark measures (scripts/bench-hooks.mjs).
  console.log('  → dist/bin/prjct-hooks.mjs (cold-hook bundle)')
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'core/hooks/cold-entry.ts')],
    outfile: path.join(DIST, 'bin', 'prjct-hooks.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    minify: true,
    keepNames: true,
    packages: 'external',
    define: versionDefine,
    plugins: [stripShebangPlugin()],
    banner: {
      js: `#!/usr/bin/env node
import { createRequire as __createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __pathDirname } from 'path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __pathDirname(__filename);`,
    },
  })

  // 1b. Thin shim entry point (tries daemon first, ~3KB, <15ms parse)
  console.log('  → dist/bin/prjct.mjs (daemon shim)')
  const shimSource = generateDaemonShim()
  fs.writeFileSync(path.join(DIST, 'bin', 'prjct.mjs'), shimSource)
  fs.chmodSync(path.join(DIST, 'bin', 'prjct.mjs'), 0o755)

  // 2. Daemon entry point (ESM, minified — spawned as background process)
  console.log('  → dist/daemon/entry.mjs')
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'core/daemon/entry.ts')],
    outfile: path.join(DIST, 'daemon', 'entry.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    minify: true,
    keepNames: true,
    packages: 'external',
    define: versionDefine,
    plugins: [stripShebangPlugin()],
    banner: {
      js: `#!/usr/bin/env node
import { createRequire as __createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __pathDirname } from 'path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __pathDirname(__filename);`,
    },
  })
  fs.chmodSync(path.join(DIST, 'daemon', 'entry.mjs'), 0o755)

  // 5. MCP Server (ESM, minified — stdio entry for MCP protocol)
  console.log('  → dist/mcp/server.mjs')
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'core/mcp/entry.ts')],
    outfile: path.join(DIST, 'mcp', 'server.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    minify: true,
    keepNames: true,
    packages: 'external',
    define: versionDefine,
    plugins: [stripShebangPlugin()],
    banner: {
      js: `#!/usr/bin/env node
import { createRequire as __createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __pathDirname } from 'path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __pathDirname(__filename);`,
    },
  })
  fs.chmodSync(path.join(DIST, 'mcp', 'server.mjs'), 0o755)

  return mainResult.metafile
}

/**
 * Legacy shim-only skips: inert orphans that pre-date the manifest and have
 * no handler anywhere. Everything real derives from the manifest
 * (routingMode 'bin-only' + 'cold-only').
 *
 * The `__`-prefixed internals are detached-child entry points handled at
 * the very top of bin/prjct.ts — routing them to the daemon (the shim's
 * default for unknown commands) would error: no registry handler exists.
 */
const SHIM_EXTRA_SKIP = ['dev', 'web', 'serve', '__internal-auto-update', '__post-upgrade']

/**
 * Evaluate the command manifest (command-data.ts) at
 * build time and return the bin-handled command names the shim must skip.
 * This is what makes the shim's skip set DERIVE from the single manifest
 * instead of being a fourth hand-maintained copy — esbuild bundles the
 * pure-data module and we execute it in-process.
 */
function deriveShimSkipSet() {
  const esbuild = require('esbuild')
  const result = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'core/commands/command-data.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
  })
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(
    mod,
    mod.exports,
    require
  )
  const derived = [
    ...mod.exports.BIN_ONLY_COMMANDS,
    ...mod.exports.COMMANDS.filter((command) => command.routingMode === 'cold-only').map(
      (command) => command.name
    ),
  ]
  return [...new Set([...derived, ...SHIM_EXTRA_SKIP])]
}

/**
 * Generate the daemon shim — a tiny (<3KB) CLI entry point that:
 * 1. Checks if daemon socket exists (fs.existsSync)
 * 2. If yes: connects, sends command, prints output, exits
 * 3. If no: dynamically imports the heavy prjct-core.mjs bundle
 *
 * This avoids parsing the ~600KB core bundle when daemon handles the command.
 */
function generateDaemonShim() {
  // Fallback policy MUST mirror bin/prjct.ts + core/daemon/client.ts + protocol.ts:
  //
  //   - Timeout = 30s for snappy verbs; 10min for long-running (ship/sync/dream/
  //     update/upgrade/analyze/init/cloud). Ship alone can exceed 65s before
  //     test gates. Mirrors commandRequestTimeoutMs() in protocol.ts.
  //   - On socket error: fall through ONLY for ECONNREFUSED / ENOENT (stale
  //     socket, no listener — the request never reached a daemon, safe to
  //     re-run). Anything else (timeout, "Connection closed before response",
  //     misc network errors) MAY mean the daemon already started executing
  //     the request, so re-running can double-bump version / double-push.
  //   - On socket close before response: NEVER fall through — exit 1.
  //   - On a `retry` response (daemon refused because its CODE IS STALE — the
  //     request did NOT execute, so there are zero side effects): the generic
  //     path re-runs DIRECTLY in-process (set PRJCT_NO_DAEMON=1 so the imported
  //     core skips the dying daemon) on the fresh code; the hook path degrades
  //     to the fail-soft `{}` no-op (it can't re-read consumed stdin, and a
  //     hook is best-effort). This is the definitive fix for the recurring
  //     stale-daemon trap — output is never served from an outdated build.
  //
  // This blocked the bin/prjct.ts hardening from commit d08727b8 from
  // reaching production for ~10 days (the shim is what end users actually
  // execute via dist/bin/prjct.mjs). Any future change to the fallback
  // policy MUST update both this string and bin/prjct.ts + protocol.ts.
  return `#!/usr/bin/env node
import{connect}from"node:net";import{existsSync}from"node:fs";import{createHash,randomUUID}from"node:crypto";import{homedir}from"node:os";import{join,resolve}from"node:path";
const cliHome=process.env.PRJCT_CLI_HOME?resolve(process.env.PRJCT_CLI_HOME):join(homedir(),".prjct-cli");
const namedPipe=process.platform==="win32";
const sockPath=namedPipe?"\\\\.\\pipe\\prjct-"+createHash("sha1").update(resolve(cliHome)).digest("hex").slice(0,16)+"-daemon":join(cliHome,"run","daemon.sock");
const hasEndpoint=()=>namedPipe||existsSync(sockPath);
const args=process.argv.slice(2);
const cmd=args.find(a=>!a.startsWith("-"));
const skip=new Set(${JSON.stringify(deriveShimSkipSet())});
function refuse(m){console.error("prjct: daemon dropped the request ("+m+"). Retry: prjct "+args.join(" "));process.exit(1)}
function isSafeRetry(e){const c=e&&e.code||"",m=e&&e.message||"";return c==="ECONNREFUSED"||c==="ENOENT"||c==="EACCES"||c==="EPERM"||m.includes("ECONNREFUSED")||m.includes("ENOENT")||m.includes("EACCES")||m.includes("EPERM")}
// Hook fast path: forward the event (stdin) to the warm daemon and write its
// response raw. Hooks must never disturb the host session, so ANY failure
// (connect error, timeout, closed socket) degrades to the empty no-op {} and
// exit 0 — the same fail-soft contract the in-process hook runner honors.
const hookCompletion=new AbortController();
function sendHook(sub,data){
  if(hookCompletion.signal.aborted)return;hookCompletion.abort();
  const msg=JSON.stringify({id:randomUUID(),command:"hook",args:sub?[sub]:[],options:{},cwd:process.cwd(),stdin:data})+"\\n";
  const sock=connect(sockPath);const chunks=[],completion=new AbortController();
  const soft=()=>{if(!completion.signal.aborted){completion.abort();clearTimeout(t);sock.destroy();process.stdout.write("{}\\n");process.exit(0)}};
  const t=setTimeout(soft,5000);
  sock.on("connect",()=>sock.write(msg));
  sock.on("data",c=>{chunks.push(c.toString());const buf=chunks.join("");const n=buf.indexOf("\\n");if(n!==-1){const r=JSON.parse(buf.slice(0,n));if(r.retry){soft();return}completion.abort();clearTimeout(t);sock.end();if(r.stdout)process.stdout.write(r.stdout);process.exit(r.exitCode!=null?r.exitCode:0)}});
  sock.on("error",soft);
  sock.on("close",soft);
}
if(cmd==="hook"){
  if(process.env.PRJCT_NO_DAEMON!=="1"&&hasEndpoint()){
    const sub=args[1];
    if(process.stdin.isTTY){sendHook(sub,"")}else{const chunks=[];process.stdin.on("data",c=>chunks.push(c));const send=()=>sendHook(sub,Buffer.concat(chunks).toString("utf8"));process.stdin.on("end",send);process.stdin.on("error",send);setTimeout(send,1000)}
  }else{
    // Cold path (daemon disabled/unreachable): run the hook from the dedicated
    // hooks bundle, NOT the full core. cold-entry emits host JSON then detaches
    // afterEmit into a worker (PRJCT_HOOK_AFTER_EMIT) so Stop does not block.
    import("./prjct-hooks.mjs").catch(()=>{process.stdout.write("{}\\n");process.exit(0)})
  }
}else if(cmd&&!skip.has(cmd)&&process.env.PRJCT_NO_DAEMON!=="1"&&hasEndpoint()){
  const cArgs=[],cOpts={};
  const consumed=new Set();for(const [i,a] of args.entries()){if(consumed.has(i))continue;if(a.startsWith("--")){const r=a.slice(2);if(r.includes("=")){const e=r.indexOf("=");cOpts[r.slice(0,e)]=r.slice(e+1)}else if(i+1<args.length&&!args[i+1].startsWith("--")){cOpts[r]=args[i+1];consumed.add(i+1)}else{cOpts[r]=true}}else if(a.startsWith("-")&&a.length===2){cOpts[a.slice(1)]=true}else if(i>0){cArgs.push(a)}}
  const msg=JSON.stringify({id:randomUUID(),command:cmd,args:cArgs,options:cOpts,cwd:process.cwd()})+"\\n";
  const sock=connect(sockPath);const chunks=[],completion=new AbortController();
  // Long verbs (ship/sync/…) need 10min; everything else stays at 30s.
  const LONG=new Set(["ship","sync","dream","update","upgrade","analyze","init","cloud"]);
  const waitMs=LONG.has(cmd)?600000:30000;
  const t=setTimeout(()=>{if(!completion.signal.aborted){completion.abort();sock.destroy();refuse("timed out")}},waitMs);
  sock.on("connect",()=>sock.write(msg));
  sock.on("data",c=>{chunks.push(c.toString());const buf=chunks.join("");const n=buf.indexOf("\\n");if(n!==-1){const r=JSON.parse(buf.slice(0,n));completion.abort();clearTimeout(t);sock.end();if(r.retry){process.env.PRJCT_NO_DAEMON="1";fallback();return}if(r.stdout)console.log(r.stdout);if(r.stderr)console.error(r.stderr);process.exit(r.exitCode)}});
  sock.on("error",e=>{if(!completion.signal.aborted){completion.abort();clearTimeout(t);if(isSafeRetry(e))fallback();else refuse(e&&e.message||String(e))}});
  sock.on("close",()=>{if(!completion.signal.aborted){completion.abort();clearTimeout(t);refuse("Connection closed before response")}});
}else{fallback()}
async function fallback(){await import("./prjct-core.mjs")}
`
}

/**
 * Generate templates/skills/prjct/SKILL.md from the SSOT TS module.
 *
 * The static template the bin shim copies into ~/.claude/skills/prjct/
 * is derived from `core/services/skill-generator/prjct-skill-body.ts`,
 * the same module `prjct sync` uses to regenerate project-aware skills.
 * Single source of truth — no risk of the static and dynamic versions
 * drifting.
 *
 * Runs as a child bun process: the source is TS, build.js is plain JS.
 */
function generateSkillTemplate() {
  const script = path.join(ROOT, 'scripts', 'generate-skill-template.ts')
  // Prefer bun (fast TS execution); fall back to skipping with a warning
  // if bun isn't on PATH (dev machines without bun still get a working
  // build — the template just won't refresh until they install bun).
  try {
    execSync(`bun "${script}"`, { cwd: ROOT, stdio: 'inherit' })
  } catch (error) {
    console.warn(`  ⚠ skipped skill template generation (${error.message.split('\n')[0]})`)
  }
}

/**
 * Bundle all templates into a single JSON file
 *
 * Structure: { "commands/p.md": "...", "global/CLAUDE.md": "...", ... }
 * Keys are relative paths from templates/ directory.
 */
function bundleTemplates() {
  const templatesDir = path.join(ROOT, 'templates')
  const bundle = {}

  function walk(dir, prefix) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.name !== '.DS_Store')
      .reduce((count, entry) => {
        const fullPath = path.join(dir, entry.name)
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) return count + walk(fullPath, relativePath)
        bundle[relativePath] = fs.readFileSync(fullPath, 'utf-8')
        return count + 1
      }, 0)
  }

  const fileCount = walk(templatesDir, '')

  // Architecture guard: no shipped template may instruct an agent to write
  // outside the DB or the regenerated vault. The list below tracks the
  // disk-pollution paths we've explicitly retired:
  //   - .prjct/sessions/      — crew templates (closed in v2.19.6 / PR #330)
  //   - .prjct/CHECKPOINTS.md — moved to kv_store crew:checkpoints (spec a50b32d1)
  //   - .prjct/team.json      — moved to kv_store team:enrollment + derived
  //                              mirror (spec a50b32d1; the mirror still lives
  //                              on disk but is REGENERATED from DB by
  //                              `prjct team`, never template-written)
  // Templates must not reference any of these paths.
  const forbiddenSubstrings = ['.prjct/sessions/', '.prjct/CHECKPOINTS.md', '.prjct/team.json']
  const offenders = []
  for (const [relPath, content] of Object.entries(bundle)) {
    for (const needle of forbiddenSubstrings) {
      if (content.includes(needle)) offenders.push(`${relPath}: contains "${needle}"`)
    }
  }
  if (offenders.length > 0) {
    console.error('\n✗ Template bundle contains forbidden persistence paths:')
    for (const line of offenders) console.error(`  - ${line}`)
    console.error(
      '\n  prjct ships only two persistence surfaces: SQLite (~/.prjct-cli/projects/<id>/) and the regenerated vault (~/Documents/prjct/<slug>/_generated/).'
    )
    console.error('  Templates must not instruct agents to write anywhere else.')
    process.exit(1)
  }

  const outPath = path.join(DIST, 'templates.json')
  fs.writeFileSync(outPath, JSON.stringify(bundle))

  console.log(`  → dist/templates.json (${fileCount} files)`)
  return fileCount
}

/**
 * Print build summary with file sizes
 */
function printSummary() {
  console.log('\nBuild output:')

  // List all files in dist/ (including code-split chunks)
  const files = []
  function walkDist(dir, prefix) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walkDist(path.join(dir, entry.name), rel)
      } else {
        files.push(rel)
      }
    }
  }
  walkDist(DIST, '')

  const totalSize = files.reduce((sum, file) => {
    const filePath = path.join(DIST, file)
    if (!fs.existsSync(filePath)) return sum
    const stat = fs.statSync(filePath)
    const sizeKb = (stat.size / 1024).toFixed(1)
    console.log(`  ${file.padEnd(25)} ${sizeKb} KB`)
    return sum + stat.size
  }, 0)

  console.log(`  ${'─'.repeat(40)}`)
  console.log(`  ${'Total'.padEnd(25)} ${(totalSize / 1024).toFixed(1)} KB`)
}

/**
 * Main
 */
async function main() {
  console.log('prjct-cli build script v3.0')
  console.log('==========================\n')

  if (!ensureEsbuild()) {
    process.exit(1)
  }

  clean()

  console.log('Compiling TypeScript...')
  await buildJs()

  console.log('\nGenerating skill template (SSOT: prjct-skill-body.ts)...')
  generateSkillTemplate()

  console.log('\nBundling templates...')
  bundleTemplates()

  printSummary()
  console.log('\nBuild complete!')
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Build failed:', error)
    process.exit(1)
  })
}

// Exported for the daemon-shim-sync test, which asserts the generated
// shim's skip set stays a superset of the manifest's bin-only commands.
module.exports = { deriveShimSkipSet, generateDaemonShim, SHIM_EXTRA_SKIP }
