// prjct-managed pi bridge v1
// Transport only: CLI owns workflow, persistence, review policy and ship gates.
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execAsync = promisify(execFile)
const exec = (command, args, options) => {
  const pending = execAsync(command, args, options)
  // Print mode consumes piped stdin before processing its prompt. Close the
  // unused pipe or a nested pi process waits forever for input from its parent.
  pending.child.stdin?.end()
  return pending.catch((error) => {
    const diagnostic = String(error.stdout || error.stderr || error.message).slice(0, limit)
    throw new Error(`${command} failed (${error.code ?? error.name}): ${diagnostic}`)
  })
}
const limit = 50 * 1024

export function sessionEnv(ctx) {
  const env = { ...process.env, AI_AGENT: 'pi', PI_CODING_AGENT: 'true', PRJCT_AGENT_RUNTIME: 'pi' }
  for (const key of [
    'PI_SESSION_ID',
    'PI_SESSION_FILE',
    'PI_PROVIDER',
    'PI_MODEL',
    'PI_REASONING_LEVEL',
  ])
    delete env[key]
  env.PI_SESSION_ID = ctx.sessionManager.getSessionId()
  const file = ctx.sessionManager.getSessionFile()
  if (file) env.PI_SESSION_FILE = file
  if (ctx.model) {
    env.PI_PROVIDER = ctx.model.provider
    env.PI_MODEL = ctx.model.id
  }
  if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel
  return env
}

export function childArgs(ctx, promptFile, readOnly) {
  if (!ctx.model) throw new Error('Pi has no active model; select a model before delegating.')
  return [
    '--print',
    '--mode',
    'json',
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-approve',
    '--provider',
    ctx.model.provider,
    '--model',
    ctx.model.id,
    ...(ctx.thinkingLevel ? ['--thinking', ctx.thinkingLevel] : []),
    '--tools',
    readOnly ? 'read,grep,find,ls' : 'read,bash,edit,write,grep,find,ls',
    '--',
    `@${promptFile}`,
  ]
}

export function parseChildOutput(stdout) {
  const events = stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
  const messages = events
    .filter((event) => event.type === 'message_end' && event.message?.role === 'assistant')
    .map((event) => event.message)
  const final = messages.at(-1)
  if (
    !events.some((event) => event.type === 'agent_end') ||
    !final ||
    final.stopReason !== 'stop'
  ) {
    throw new Error(
      'Pi delegate did not complete successfully; no review approval may be inferred.'
    )
  }
  const text = final.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  if (!text.trim()) throw new Error('Pi delegate returned no final report.')
  return { text, messages }
}

async function resultText(text, details) {
  if (Buffer.byteLength(text) <= limit && text.split('\n').length <= 2000) {
    return { content: [{ type: 'text', text }], details }
  }
  const dir = await mkdtemp(join(tmpdir(), 'prjct-pi-output-'))
  const file = join(dir, 'output.txt')
  await writeFile(file, text, { mode: 0o600 })
  const preview = Buffer.from(text)
    .subarray(0, limit)
    .toString('utf8')
    .split('\n')
    .slice(0, 2000)
    .join('\n')
  return {
    content: [{ type: 'text', text: `${preview}\n[Truncated; full output: ${file}]` }],
    details: { ...details, outputFile: file },
  }
}

export async function runCli(args, ctx, signal, execute = exec) {
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
  ) {
    throw new Error('prjct requires a nonempty argv array of strings.')
  }
  // Never shell-join arguments or replay failed mutation commands.
  const result = await execute('prjct', args, {
    cwd: ctx.cwd,
    env: sessionEnv(ctx),
    signal,
    timeout: 900000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return resultText(result.stdout || result.stderr || '(no output)', { command: 'prjct', args })
}

export async function runAgent(prompt, readOnly, ctx, signal, execute = exec) {
  if (!prompt?.trim()) throw new Error('An explicit bounded task is required.')
  if (!ctx.model) throw new Error('Pi has no active model; select a model before delegating.')
  const dir = await mkdtemp(join(tmpdir(), 'prjct-pi-agent-'))
  const file = join(dir, 'task.txt')
  try {
    await writeFile(
      file,
      `${prompt}\n\nReturn your findings to the parent. Do not spawn agents, ship, approve judgments, or change prjct policy.`,
      { mode: 0o600 }
    )
    const result = await execute('pi', childArgs(ctx, file, readOnly), {
      cwd: ctx.cwd,
      env: sessionEnv(ctx),
      signal,
      timeout: 600000,
      maxBuffer: 4 * 1024 * 1024,
    })
    const parsed = parseChildOutput(result.stdout)
    // Return evidence, not a fabricated ledger verdict. Parent uses existing CLI gates.
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
    for (const message of parsed.messages) {
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
        usage[key] += message.usage?.[key] ?? 0
      }
      for (const key of Object.keys(usage.cost)) usage.cost[key] += message.usage?.cost?.[key] ?? 0
    }
    return {
      ...(await resultText(parsed.text, {
        provider: ctx.model.provider,
        model: ctx.model.id,
        independent: true,
        readOnly,
      })),
      usage,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
