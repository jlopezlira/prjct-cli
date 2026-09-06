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

const { execFileSync, execSync } = require('node:child_process')
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

  // 1a. CLI core bundle (heavy, only loaded when daemon unavailable).
  // Code-split like the hooks bundle below: without splitting, esbuild
  // inlines every dynamic import into ONE ~1.6MB file, so even `--version`
  // / `--help` pay to compile the union of all commands. With splitting,
  // lazily-imported command modules land in core-chunks/ and are only
  // parsed when actually executed. The ENTRY still lands at
  // dist/bin/prjct-core.mjs — the shim's `import("./prjct-core.mjs")`,
  // mcp-config.ts's existence check, and hook-command.ts's sibling lookup
  // all keep resolving unchanged.
  console.log('  → dist/bin/prjct-core.mjs (split, chunks in core-chunks/)')
  const mainResult = await esbuild.build({
    entryPoints: [path.join(ROOT, 'bin/prjct.ts')],
    outdir: path.join(DIST, 'bin'),
    entryNames: 'prjct-core',
    chunkNames: 'core-chunks/[name]-[hash]',
    outExtension: { '.js': '.mjs' },
    bundle: true,
    splitting: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    minify: true,
    keepNames: true,
    packages: 'external',
    loader: { '.md': 'text' },
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

  // 1a-hooks. Dedicated COLD-hook bundle, code-split so a cold hook parses
  // only its own closure. Without splitting, esbuild inlines the registry's
  // dynamic imports into ONE file, so `prjct hook notification` was parsing
  // the union of every hook's deps (~1MB: commands, sync, workflow-engine…)
  // on a freshly-spawned process. With splitting each hook module + its
  // unique deps become lazily-loaded chunks — notification parses ~30KB,
  // prompt ~its real closure, and the leak chains (session-start →
  // task-service → commands/shipping) stop taxing unrelated hooks.
  console.log('  → dist/bin/prjct-hooks.mjs (cold-hook bundle, split)')
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'core/hooks/cold-entry.ts')],
    outdir: path.join(DIST, 'bin'),
    entryNames: 'prjct-hooks',
    chunkNames: 'hook-chunks/[name]-[hash]',
    outExtension: { '.js': '.mjs' },
    bundle: true,
    splitting: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    minify: true,
    keepNames: true,
    packages: 'external',
    loader: { '.md': 'text' },
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

  // 1b. Thin shim entry point (tries daemon first, ~9KB, fast parse)
  console.log('  → dist/bin/prjct.mjs (daemon shim)')
  const shimSource = generateDaemonShim()
  fs.writeFileSync(path.join(DIST, 'bin', 'prjct.mjs'), shimSource)
  fs.chmodSync(path.join(DIST, 'bin', 'prjct.mjs'), 0o755)

  // 1c. Native hook-fast binaries — best-effort, additive. See
  // native/hook-fast.c's docstring: settings-installer.ts tries these
  // FIRST for a matching platform+arch, but the bun shim above remains the
  // guaranteed fallback (missing binary, wrong platform, or any runtime
  // failure all fall through to it). A build machine without a C
  // toolchain just ships without this extra layer — never a build failure.
  const nativeBuilt = buildNativeHookFast()
  if (nativeBuilt.length > 0) {
    console.log(`  → dist/bin/hook-fast-{${nativeBuilt.join(',')}} (native fast path)`)
  } else {
    console.log('  → hook-fast native binary skipped (no C toolchain for any target)')
  }

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
    loader: { '.md': 'text' },
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
    loader: { '.md': 'text' },
    define: versionDefine,
    plugins: [stripShebangPlugin()],
    banner: {
      js: `#!/usr/bin/env node
import { createRequire as __createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __pathDirname } from 'path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __pathDirname(__filename);
// V8 compile cache: this ~1MB bundle is parsed once per MCP SESSION (every
// agent session spawns its own server) — bytecode-cache it like the CLI does.
try { const __m = require('node:module'); if (__m.enableCompileCache) __m.enableCompileCache(); } catch {}`,
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
const SHIM_EXTRA_SKIP = [
  'dev',
  'web',
  'serve',
  '__internal-auto-update',
  '__post-upgrade',
  '__internal-ensure-daemon',
]

/**
 * Evaluate the command manifest (command-data.ts) at
 * build time and return the bin-handled command names the shim must skip.
 * This is what makes the shim's skip set DERIVE from the single manifest
 * instead of being a fourth hand-maintained copy — esbuild bundles the
 * pure-data module and we execute it in-process.
 */
function deriveShimSkipSet() {
  const esbuild = require('esbuild')
  const os = require('node:os')
  // Bundle the pure-data manifest to a temp CJS file and `require` it, rather
  // than executing bundled text through `new Function` (SEC-15). The input is
  // first-party source, but require-of-a-file keeps the build free of any
  // dynamic code-evaluation construct.
  const tmpFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-manifest-')),
    'command-data.cjs'
  )
  try {
    esbuild.buildSync({
      entryPoints: [path.join(ROOT, 'core/commands/command-data.ts')],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      outfile: tmpFile,
    })
    const mod = require(tmpFile)
    const derived = [
      ...mod.BIN_ONLY_COMMANDS,
      ...mod.COMMANDS.filter((command) => command.routingMode === 'cold-only').map(
        (command) => command.name
      ),
    ]
    return [...new Set([...derived, ...SHIM_EXTRA_SKIP])]
  } finally {
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true })
  }
}

/**
 * Compile native/hook-fast.c for every platform+arch this build machine
 * can reach, into dist/bin/hook-fast-<platform>-<arch> (matching Node's
 * own process.platform/process.arch strings, so settings-installer.ts can
 * compute the expected filename with zero lookup table). POSIX only —
 * Windows named pipes need a different implementation, not attempted here.
 *
 * Strategy: native `cc` for the machine's own platform+arch (always
 * available if this build machine has ANY C toolchain), plus opportunistic
 * cross-compilation for anything else reachable from here (macOS can
 * target the other Apple arch via clang's -arch flag; Linux targets via
 * `zig cc` when zig happens to be installed). Every attempt is wrapped so a
 * missing compiler/target is silently skipped — this must never fail the
 * JS/TS build. A platform this build produces no binary for just keeps
 * using the bun shim, identical to today.
 *
 * @returns {string[]} platform-arch labels that compiled successfully.
 */
function buildNativeHookFast() {
  const src = path.join(ROOT, 'native', 'hook-fast.c')
  if (!fs.existsSync(src)) return []
  const outDir = path.join(DIST, 'bin')
  const built = new Set()

  const tryCompile = (label, compiler, args) => {
    if (built.has(label)) return
    const out = path.join(outDir, `hook-fast-${label}`)
    try {
      execFileSync(compiler, [...args, '-O2', '-o', out, src], { stdio: 'pipe' })
      fs.chmodSync(out, 0o755)
      built.add(label)
    } catch {
      // No compiler / no support for this target on this build machine —
      // fine, that platform ships without the native fast path.
    }
  }

  if (process.platform === 'darwin') {
    tryCompile('darwin-arm64', 'cc', ['-arch', 'arm64'])
    tryCompile('darwin-x64', 'cc', ['-arch', 'x86_64'])
  } else if (process.platform === 'linux') {
    tryCompile(`linux-${process.arch}`, 'cc', [])
  }
  // Opportunistic Linux cross-compilation via zig (musl = fully static, no
  // glibc-version dependence on the eventual target machine) — only fills
  // in whatever the native branch above didn't already cover.
  tryCompile('linux-x64', 'zig', ['cc', '-target', 'x86_64-linux-musl'])
  tryCompile('linux-arm64', 'zig', ['cc', '-target', 'aarch64-linux-musl'])

  return [...built]
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
  //     core skips the dying daemon) on the fresh code; the hook path preserves
  //     the payload and imports the dedicated cold-hook entry itself — see
  //     core/hooks/stdin-spill.ts. This is the definitive fix for the recurring
  //     stale-daemon trap — output is never served from an outdated build.
  //
  // This blocked the bin/prjct.ts hardening from commit d08727b8 from
  // reaching production for ~10 days (the shim is what end users actually
  // execute via dist/bin/prjct.mjs). Any future change to the fallback
  // policy MUST update both this string and bin/prjct.ts + protocol.ts.
  return `#!/usr/bin/env node
import{connect}from"node:net";import{existsSync,mkdirSync,readFileSync,readSync,statSync,unlinkSync,writeFileSync}from"node:fs";import{isatty}from"node:tty";import{createHash,randomUUID}from"node:crypto";import{homedir}from"node:os";import{dirname,join,resolve}from"node:path";import{spawn}from"node:child_process";import module from"node:module";
const cliHome=process.env.PRJCT_CLI_HOME?resolve(process.env.PRJCT_CLI_HOME):join(homedir(),".prjct-cli");
// V8 compile cache (node >=22.8): persists compiled bytecode for the core
// bundle + chunks across cold starts — measured ~23% off --version. Guarded
// because the node floor (22.5) predates enableCompileCache; on older node
// this is a no-op. Default-export import (not a named import) so the module
// still links on versions that lack the export.
try{if(typeof module.enableCompileCache==="function")module.enableCompileCache(join(cliHome,"cache","compile-cache"))}catch{}
const namedPipe=process.platform==="win32";
const sockPath=namedPipe?"\\\\.\\pipe\\prjct-"+createHash("sha1").update(resolve(cliHome)).digest("hex").slice(0,16)+"-daemon":join(cliHome,"run","daemon.sock");
const hasEndpoint=()=>namedPipe||existsSync(sockPath);
// Sync-read stdin via fs.readSync on fd 0 directly — never READS through
// process.stdin, whose stream wrapper costs event-loop turnaround per hook.
// Touching process.stdin.fd once up front flips fd 0 non-blocking (this
// shim always runs on node), so an open-but-empty pipe yields EAGAIN and
// the deadline is REAL: a host that opens stdin but never closes degrades
// to whatever arrived instead of hanging until the host's hook-timeout
// kill. EAGAIN retries sleep ~1ms via Atomics.wait to avoid a busy-spin.
function readStdinSync(ms){if(isatty(0))return"";try{void process.stdin.fd}catch{}const dl=Date.now()+ms;const slp=new Int32Array(new SharedArrayBuffer(4));const buf=Buffer.alloc(65536);const parts=[];for(;;){try{const n=readSync(0,buf,0,buf.length,null);if(n===0)break;parts.push(Buffer.from(buf.subarray(0,n)))}catch(e){if(e&&e.code==="EAGAIN"&&Date.now()<dl){Atomics.wait(slp,0,0,1);continue}break}}return Buffer.concat(parts).toString("utf8")}
const args=process.argv.slice(2);
const cmd=args.find(a=>!a.startsWith("-"));
const skip=new Set(${JSON.stringify(deriveShimSkipSet())});
function refuse(m){console.error("prjct: daemon dropped the request ("+m+"). Retry: prjct "+args.join(" "));process.exit(1)}
function isSafeRetry(e){const c=e&&e.code||"",m=e&&e.message||"";return c==="ECONNREFUSED"||c==="ENOENT"||c==="EACCES"||c==="EPERM"||m.includes("ECONNREFUSED")||m.includes("ENOENT")||m.includes("EACCES")||m.includes("EPERM")}
// Hook stdin spill (mirrors core/hooks/stdin-spill.ts — keep fnv1a-32,
// filename shape, sanitizer and 30s freshness window IN LOCKSTEP with it and
// with native/hook-fast.c): when an earlier chain stage (native hook-fast,
// or this shim itself on a prior stage) already consumed stdin and punted,
// the payload waits at <cliHome>/run/hook-stdin-<fnv1a32hex(cwd)>-<sub>.json.
const fnv1a=(s)=>Buffer.from(s,"utf8").reduce((a,b)=>Math.imul(a^b,16777619)>>>0,2166136261).toString(16).padStart(8,"0");
const spillPath=(sub)=>{const s=(sub||"").toLowerCase().replace(/[^a-z0-9-]/g,"");return s?join(cliHome,"run","hook-stdin-"+fnv1a(process.cwd())+"-"+s+".json"):null};
const readSpill=(sub)=>{const p=spillPath(sub);if(!p)return null;try{const st=statSync(p);if(Date.now()-st.mtimeMs>3e4){unlinkSync(p);return null}const d=readFileSync(p,"utf8");unlinkSync(p);return d}catch{return null}};
const writeSpill=(sub,data)=>{const p=spillPath(sub);if(!p)return;try{mkdirSync(dirname(p),{recursive:true,mode:0o700});writeFileSync(p,data,{mode:0o600})}catch{}};
// Daemon auth token (mirrors core/daemon/auth.ts): read per request from the
// owner-only run dir. Missing/malformed → send none; the daemon answers
// retry+unauthenticated and the request runs directly instead.
const authToken=()=>{try{const t=readFileSync(join(cliHome,"run","daemon.token"),"utf8").trim();return /^[0-9a-f]{64}$/.test(t)?t:""}catch{return""}};
const withAuth=(o)=>{const a=authToken();return a?{...o,auth:a}:o};
// Hook fast path: forward the event (stdin, or the spill an earlier chain
// stage left behind) to the warm daemon and write its response raw. Hooks
// must never disturb the host session, so ANY failure (connect error,
// timeout, closed socket, stale-code retry) preserves the payload and runs
// the dedicated cold hook here. Pi and direct CLI callers have no shell
// fallback chain: exit 89 is an error that otherwise blocks their tools.
const hookCompletion=new AbortController();
function sendHook(sub,data){
  if(hookCompletion.signal.aborted)return;hookCompletion.abort();
  const msg=JSON.stringify(withAuth({id:randomUUID(),command:"hook",args:sub?[sub]:[],options:{},cwd:process.cwd(),stdin:data,...(process.env.PRJCT_HOOK_HOST?{hookHost:process.env.PRJCT_HOOK_HOST}:{})}))+"\\n";
  const sock=connect(sockPath);const chunks=[],completion=new AbortController();
  const soft=()=>cold();
  // Preserve hook decisions and original stdin in the dedicated hook bundle.
  // Generic mutating commands retain their separate no-replay policy.
  const cold=()=>{if(!completion.signal.aborted){completion.abort();clearTimeout(t);sock.destroy();writeSpill(sub,data);process.env.PRJCT_NO_DAEMON="1";import("./prjct-hooks.mjs").catch(()=>{process.stdout.write("{}\\n");process.exit(0)})}};
  const t=setTimeout(soft,800);
  sock.on("connect",()=>sock.write(msg));
  sock.on("data",c=>{if(completion.signal.aborted)return;chunks.push(c.toString());const buf=chunks.join("");if(buf.length>1048576){soft();return}const n=buf.indexOf("\\n");if(n!==-1){try{const r=JSON.parse(buf.slice(0,n));if(!r||typeof r!=="object"||Array.isArray(r)||r.unauthenticated||r.retry||r.success!==true||r.exitCode!==0||typeof r.stdout!=="string"){soft();return}completion.abort();clearTimeout(t);sock.end();if(r.stdout)process.stdout.write(r.stdout);process.exit(0)}catch{soft()}}});
  sock.on("error",soft);
  sock.on("close",soft);
}
if(cmd==="hook"){
  if(process.env.PRJCT_NO_DAEMON!=="1"&&hasEndpoint()){
    const sub=args[1];
    // Sync stdin read: event-accumulating a pipe costs ~15-20ms of event-loop
    // turnaround per hook in bun/node; hosts write the event JSON and close
    // stdin immediately, so a sync read returns at once. Fail-soft: an
    // unrecoverable read error yields whatever was read so far (the hook
    // treats a blank result as {}). The host-side hook timeout
    // (settings-installer HOOK_TIMEOUT_SECONDS) remains the backstop for a
    // pathological host that never closes stdin. A fresh spill file (native
    // hook-fast punted) takes precedence over the drained pipe.
    sendHook(sub,readSpill(sub)??readStdinSync(1000));
  }else{
    // Cold path (daemon disabled/unreachable): run the hook from the dedicated
    // hooks bundle, NOT the full core. cold-entry emits host JSON then detaches
    // afterEmit into a worker (PRJCT_HOOK_AFTER_EMIT) so Stop does not block.
    // When the daemon is simply DOWN (not disabled), kick a detached
    // __internal-ensure-daemon child first (fire-and-forget — never blocks
    // this hook) so the NEXT hook gets the warm path. The child re-runs this
    // shim; __internal-ensure-daemon is in the skip set, so it falls through
    // to prjct-core.mjs, whose bin entry calls spawnDaemon() and exits.
    if(process.env.PRJCT_NO_DAEMON!=="1"){try{const c=spawn(process.execPath,[process.argv[1],"__internal-ensure-daemon"],{detached:true,stdio:"ignore"});c.unref()}catch{}}
    import("./prjct-hooks.mjs").catch(()=>{process.stdout.write("{}\\n");process.exit(0)})
  }
}else if(cmd&&!skip.has(cmd)&&process.env.PRJCT_NO_DAEMON!=="1"&&hasEndpoint()){
  const cArgs=[],cOpts={};
  const consumed=new Set();for(const [i,a] of args.entries()){if(consumed.has(i))continue;if(a.startsWith("--")){const r=a.slice(2);if(r.includes("=")){const e=r.indexOf("=");cOpts[r.slice(0,e)]=r.slice(e+1)}else if(i+1<args.length&&!args[i+1].startsWith("--")){cOpts[r]=args[i+1];consumed.add(i+1)}else{cOpts[r]=true}}else if(a.startsWith("-")&&a.length===2){cOpts[a.slice(1)]=true}else if(i>0){cArgs.push(a)}}
  const operationId=cOpts["operation-id"]||randomUUID();
  const msg=JSON.stringify(withAuth({id:operationId,command:cmd,args:cArgs,options:cOpts,cwd:process.cwd()}))+"\\n";
  const sock=connect(sockPath);const chunks=[],completion=new AbortController();
  // Long verbs (ship/sync/…) need 10min; everything else stays at 30s.
  const LONG=new Set(["ship","sync","dream","update","upgrade","analyze","init","cloud","qa","gauntlet"]);
  const waitMs=LONG.has(cmd)?600000:30000;
  const t=setTimeout(()=>{if(!completion.signal.aborted){completion.abort();sock.destroy();refuse("timed out; operation "+operationId+". Resume the same command with --operation-id="+operationId+"; add --operation-status to inspect")}},waitMs);
  sock.on("connect",()=>sock.write(msg));
  sock.on("data",c=>{chunks.push(c.toString());const buf=chunks.join("");const n=buf.indexOf("\\n");if(n!==-1){const r=JSON.parse(buf.slice(0,n));completion.abort();clearTimeout(t);sock.end();if(r.retry){if(cOpts["operation-id"]){refuse("Resume requires a ready daemon; retry the same operation id after restart");return}process.env.PRJCT_NO_DAEMON="1";fallback();return}if(r.stdout)console.log(r.stdout);if(r.stderr)console.error(r.stderr);process.exit(r.exitCode)}});
  sock.on("error",e=>{if(!completion.signal.aborted){completion.abort();clearTimeout(t);if(isSafeRetry(e)&&!cOpts["operation-id"])fallback();else refuse((e&&e.message||String(e))+"; resume with --operation-id="+operationId)}});
  sock.on("close",()=>{if(!completion.signal.aborted){completion.abort();clearTimeout(t);refuse("Connection closed before response; resume with --operation-id="+operationId)}});
}else{fallback()}
async function fallback(){if(args.some(a=>a==="--operation-id"||a.startsWith("--operation-id="))){refuse("Resume requires the daemon; start it and repeat the same operation id");return}await import("./prjct-core.mjs")}
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

/** Copy private, offline engineering guidance beside compiled output. */
function bundlePrivateEngineeringSkills() {
  const source = path.join(ROOT, 'assets', 'private-engineering-skills')
  const target = path.join(DIST, 'assets', 'private-engineering-skills')
  const required = [
    'diagnosing-bugs.md',
    'tdd.md',
    'code-review.md',
    'resolving-merge-conflicts.md',
    'research.md',
    'writing-for-agents.md',
    'comment-discipline.md',
    'domain-modeling.md',
    'codebase-design.md',
  ]
  for (const file of required) {
    if (!fs.statSync(path.join(source, file), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing private engineering asset: ${file}`)
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(source, target, { recursive: true, dereference: false })
  console.log(`  → dist/assets/private-engineering-skills (${required.length} files)`)
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
 *
 * `--native-only`: compile ONLY the hook-fast C binaries (no esbuild, no
 * bundles, no clean) — the release workflow's per-OS matrix job uses this
 * to produce each platform's binaries on a runner with no npm install /
 * bun (just node + cc). Without it, a full `npm run build` on ubuntu can
 * only ever embed linux-x64, so the published tarball silently lacked
 * darwin binaries (shipped v3.89.0 that way).
 */
async function main() {
  console.log('prjct-cli build script v3.0')
  console.log('==========================\n')

  if (process.argv.includes('--native-only')) {
    fs.mkdirSync(path.join(DIST, 'bin'), { recursive: true })
    const nativeBuilt = buildNativeHookFast()
    if (nativeBuilt.length > 0) {
      console.log(`  → dist/bin/hook-fast-{${nativeBuilt.join(',')}}`)
    } else {
      console.error('✗ --native-only: no hook-fast binary compiled (no C toolchain?)')
      process.exit(1)
    }
    return
  }

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

  console.log('\nBundling private engineering skills...')
  bundlePrivateEngineeringSkills()

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
