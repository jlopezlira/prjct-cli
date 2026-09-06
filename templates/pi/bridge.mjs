// prjct-managed pi bridge v1 (transport)
// CLI owns workflow, persistence, review policy and ship gates.
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execAsync = promisify(execFile)
const exec = (command, args, { input, ...options }) => {
  const pending = execAsync(command, args, options)
  // Print mode consumes piped stdin before processing its prompt. Close the
  // unused pipe or a nested pi process waits forever for input from its parent.
  pending.child.stdin?.end(input)
  return pending.catch((error) => {
    const diagnostic = String(error.stdout || error.stderr || error.message).slice(0, limit)
    throw new Error(`${command} failed (${error.code ?? error.name}): ${diagnostic}`)
  })
}
const limit = 50 * 1024

function requireModel(ctx) {
  if (!ctx.model) throw new Error('Pi has no active model; select a model before delegating.')
  return ctx.model
}

// One options shape for every child the bridge spawns: cwd, the scrubbed
// session env, the caller's abort signal, a per-kind timeout, 4 MiB buffer.
function execOptions(ctx, signal, timeout, independent = false) {
  return {
    cwd: ctx.cwd,
    env: sessionEnv(ctx, independent),
    signal,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  }
}

export function sessionEnv(ctx, independent = false) {
  const env = { ...process.env, AI_AGENT: 'pi', PI_CODING_AGENT: 'true', PRJCT_AGENT_RUNTIME: 'pi' }
  for (const key of [
    'PI_SESSION_ID',
    'PI_SESSION_FILE',
    'PI_PROVIDER',
    'PI_MODEL',
    'PI_REASONING_LEVEL',
  ])
    delete env[key]
  if (independent) {
    env.PRJCT_PI_DELEGATE = '1'
    for (const key of ['PRJCT_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID', 'PRJCT_AGENT'])
      delete env[key]
  } else {
    env.PI_SESSION_ID = ctx.sessionManager.getSessionId()
    const file = ctx.sessionManager.getSessionFile()
    if (file) env.PI_SESSION_FILE = file
  }
  if (ctx.model) {
    env.PI_PROVIDER = ctx.model.provider
    env.PI_MODEL = ctx.model.id
  }
  if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel
  return env
}

export function childArgs(ctx, promptFile, readOnly) {
  const model = requireModel(ctx)
  return [
    '--print',
    '--mode',
    'json',
    '--no-session',
    '--no-extensions',
    '--extension',
    fileURLToPath(new URL('./index.ts', import.meta.url)),
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-approve',
    '--provider',
    model.provider,
    '--model',
    model.id,
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
  // A message_end without content is a malformed stream, not a TypeError.
  const text = (Array.isArray(final.content) ? final.content : [])
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
  const result = await execute('prjct', args, execOptions(ctx, signal, 900000))
  return resultText(result.stdout || result.stderr || '(no output)', { command: 'prjct', args })
}

export async function runAgent(prompt, readOnly, ctx, signal, execute = exec) {
  if (!prompt?.trim()) throw new Error('An explicit bounded task is required.')
  const { provider, id: modelId } = requireModel(ctx)
  const dir = await mkdtemp(join(tmpdir(), 'prjct-pi-agent-'))
  const file = join(dir, 'task.txt')
  try {
    await writeFile(
      file,
      `${prompt}\n\nReturn your findings to the parent. Do not spawn agents, ship, approve judgments, or change prjct policy.`,
      { mode: 0o600 }
    )
    const result = await execute(
      'pi',
      childArgs(ctx, file, readOnly),
      execOptions(ctx, signal, 600000, true)
    )
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
        provider,
        model: modelId,
        independent: true,
        readOnly,
      })),
      usage,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Translate native Pi events only; workflow policy stays in the CLI hooks. */
export async function runHook(subcommand, payload, ctx, signal, execute = exec) {
  const options = execOptions(ctx, signal, 10000)
  const result = await execute('prjct', ['hook', subcommand], {
    ...options,
    env: { ...options.env, PRJCT_HOOK_HOST: 'pi' },
    input: JSON.stringify(payload),
  })
  const output = JSON.parse(result.stdout || '{}')
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('Invalid prjct hook response')
  }
  return output
}

export function registerLifecycle(pi, specs, executeHook = runHook) {
  const tools = {
    bash: 'Bash',
    read: 'Read',
    edit: 'Edit',
    write: 'Write',
    grep: 'Grep',
    find: 'Glob',
  }
  const message = (content) => ({ customType: 'prjct-hook', content, display: false })
  const publish = (content) => {
    if (content) pi.sendMessage(message(content), { triggerTurn: false })
  }
  const dispatch = async (eventName, event, ctx) => {
    const toolName = tools[event.toolName] ?? event.toolName ?? ''
    const payload = {
      cwd: ctx.cwd,
      session_id: ctx.sessionManager.getSessionId(),
      transcript_path: ctx.sessionManager.getSessionFile(),
      hook_event_name: eventName,
      tool_name: toolName,
      tool_input: event.input,
      tool_response: event.content,
      tool_use_id: event.toolCallId,
      agent_id: event.toolCallId,
      prompt: event.prompt,
      source: event.reason,
      model: ctx.model?.id,
    }
    const context = []
    for (const spec of specs) {
      if (
        spec.event !== eventName ||
        (spec.matcher && !new RegExp(`^(?:${spec.matcher})$`).test(toolName))
      )
        continue
      try {
        const result = await executeHook(spec.subcommand, payload, ctx, ctx.signal)
        const output = result.hookSpecificOutput
        if (output?.permissionDecision === 'deny') {
          return { block: true, reason: output.permissionDecisionReason || 'Blocked by prjct' }
        }
        const text = output?.additionalContext || result.systemMessage
        if (text) context.push(text)
      } catch (error) {
        const reason = `prjct ${spec.subcommand} unavailable: ${error.message}`
        if (eventName === 'PreToolUse' && ['Bash', 'Edit', 'Write'].includes(toolName)) {
          return { block: true, reason }
        }
        context.push(reason)
      }
    }
    return { context: context.join('\n\n') }
  }
  pi.on('session_start', async (event, ctx) => {
    publish((await dispatch('SessionStart', event, ctx)).context)
  })
  pi.on('before_agent_start', async (event, ctx) => {
    const result = await dispatch('UserPromptSubmit', event, ctx)
    if (result.context) return { message: message(result.context) }
  })
  const handleTool = (phase) => async (event, ctx) => {
    if (phase === 'PostToolUse' && event.isError && event.toolName !== 'prjct_agent') return
    const nativeEvent =
      event.toolName === 'prjct_agent'
        ? phase === 'PreToolUse'
          ? 'SubagentStart'
          : 'SubagentStop'
        : phase
    const result = await dispatch(nativeEvent, event, ctx)
    if (result.block) return { block: true, reason: result.reason }
    publish(result.context)
  }
  pi.on('tool_call', handleTool('PreToolUse'))
  pi.on('tool_result', handleTool('PostToolUse'))
  pi.on('agent_end', async (event, ctx) => {
    publish((await dispatch('Stop', event, ctx)).context)
  })
}
