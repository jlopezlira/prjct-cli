/**
 * Built-in tools for the owned agent (Pi-like minimal set).
 * All FS ops are root-scoped via resolveSafePath.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { ensureParentDir, fileExists, resolveSafePath } from './paths'
import { prjctBodyTools, withGuardPrefix } from './prjct-tools'
import type { AgentTool, AgentToolResult } from './types'

const execFileAsync = promisify(execFile)

const DEFAULT_MAX_READ = 256 * 1024
const DEFAULT_BASH_MS = 30_000
const DEFAULT_BASH_OUT = 64 * 1024

function ok(content: string): AgentToolResult {
  return { ok: true, content }
}
function fail(content: string): AgentToolResult {
  return { ok: false, content }
}

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`${name} must be a non-empty string`)
  return v
}

export const readTool: AgentTool = {
  name: 'read',
  description: 'Read a UTF-8 text file under the project root. Path is relative to project root.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path from project root' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    try {
      const rel = asString(args.path, 'path')
      const abs = resolveSafePath(ctx.root, rel)
      if (!fileExists(abs)) return fail(`File not found: ${rel}`)
      const st = fs.statSync(abs)
      if (!st.isFile()) return fail(`Not a file: ${rel}`)
      const max = ctx.maxReadBytes ?? DEFAULT_MAX_READ
      if (st.size > max) return fail(`File too large (${st.size} > ${max} bytes): ${rel}`)
      const text = fs.readFileSync(abs, 'utf-8')
      return ok(text)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  },
}

export const writeTool: AgentTool = {
  name: 'write',
  description:
    'Create or overwrite a UTF-8 text file under the project root. Creates parent dirs. Prefer edit for small changes.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path from project root' },
      content: { type: 'string', description: 'Full file contents' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    try {
      const rel = asString(args.path, 'path')
      const content = typeof args.content === 'string' ? args.content : String(args.content ?? '')
      const abs = resolveSafePath(ctx.root, rel)
      ensureParentDir(abs)
      fs.writeFileSync(abs, content, 'utf-8')
      return withGuardPrefix(ctx, rel, ok(`Wrote ${rel} (${content.length} chars)`))
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  },
}

export const editTool: AgentTool = {
  name: 'edit',
  description:
    'Replace an exact substring in a file once. Fails if old_string is missing or not unique. Surfaces preventive memory for the file when present.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(args, ctx) {
    try {
      const rel = asString(args.path, 'path')
      const oldStr = asString(args.old_string, 'old_string')
      const newStr =
        typeof args.new_string === 'string' ? args.new_string : String(args.new_string ?? '')
      const abs = resolveSafePath(ctx.root, rel)
      if (!fileExists(abs)) return fail(`File not found: ${rel}`)
      const text = fs.readFileSync(abs, 'utf-8')
      const count = text.split(oldStr).length - 1
      if (count === 0) return fail(`old_string not found in ${rel}`)
      if (count > 1) return fail(`old_string not unique in ${rel} (${count} matches)`)
      fs.writeFileSync(abs, text.replace(oldStr, newStr), 'utf-8')
      return withGuardPrefix(ctx, rel, ok(`Edited ${rel}`))
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  },
}

/**
 * Deny destructive / networky / privilege-changing shell shapes (defense in
 * depth — the tool's contract is "no network, no sudo").
 *
 * Two regexes so the network/privilege verbs match only in COMMAND position
 * (string start, or after `;`, `|`, `&&`, `(`, a newline, or a backtick) —
 * that catches `curl|sh`, `x && sudo y`, `nc -e …` while leaving `echo …
 * curl` and `git log --grep=wget` alone. The second regex is for shapes that
 * are dangerous as a substring anywhere (`/dev/tcp`, `rm -rf /`, `dd if=`).
 */
const BASH_DENY_VERB =
  /(?:^|[\n;&|(`])\s*(?:sudo|doas|pkexec|su|curl|wget|nc|ncat|netcat|socat|telnet|ssh|scp|sftp|rsync|ftp|mkfs|shutdown|reboot|halt|chown|chgrp|crontab)\b/i
const BASH_DENY_ALWAYS =
  /(?:\bopenssl\s+s_client\b|\/dev\/(?:tcp|udp)\/|\bpython[23]?\s+-m\s+http\.server\b|\bgit\s+push\b|\bnpm\s+publish\b|\bdd\s+if=|\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(?:\/|~|\$HOME)(?:\s|$)|\bchmod\s+(?:-R\s+)?[0-7]*777\b|\bkill\s+-9\s+-1\b)/i

/** Env vars a shelled-out child must never inherit from the host agent. */
const ENV_SECRET_KEY = /(?:token|secret|passw(?:or)?d|api[_-]?key|private[_-]?key|credential)/i
const ENV_SECRET_PREFIX =
  /^(?:AWS_|GITHUB_|GH_|OPENAI_|ANTHROPIC_|GOOGLE_|AZURE_|NPM_|SUPABASE_|STRIPE_)/

/** Copy of the host env with credential-shaped entries removed. */
export function scrubbedChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (ENV_SECRET_KEY.test(key) || ENV_SECRET_PREFIX.test(key)) continue
    out[key] = value
  }
  return out
}

/** Pure export for unit tests. */
export function bashCommandDenied(command: string): boolean {
  return BASH_DENY_VERB.test(command) || BASH_DENY_ALWAYS.test(command)
}

export const bashTool: AgentTool = {
  name: 'bash',
  description:
    'Run a short shell command in the project root (cwd fixed). Prefer read/edit/write for file changes. No network/sudo.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run' },
    },
    required: ['command'],
  },
  async execute(args, ctx) {
    try {
      const command = asString(args.command, 'command')
      if (bashCommandDenied(command)) {
        return fail('Command blocked by safety policy')
      }
      const timeout = ctx.maxBashMs ?? DEFAULT_BASH_MS
      const maxOut = ctx.maxBashOutputBytes ?? DEFAULT_BASH_OUT
      // `-c`, not `-lc`: a login shell sources the user's profile, which can
      // alias or re-PATH anything the deny list checked by name.
      const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
        cwd: ctx.root,
        timeout,
        maxBuffer: maxOut,
        env: scrubbedChildEnv(),
      })
      const out = [stdout, stderr].filter(Boolean).join('\n').slice(0, maxOut)
      return ok(out || '(no output)')
    } catch (e) {
      const err = e as {
        killed?: boolean
        code?: number
        stdout?: string
        stderr?: string
        message?: string
      }
      if (err.killed) return fail(`Command timed out`)
      const bits = [err.stderr, err.stdout, err.message]
        .filter(Boolean)
        .join('\n')
        .slice(0, DEFAULT_BASH_OUT)
      return fail(bits || 'Command failed')
    }
  },
}

export function defaultTools(): AgentTool[] {
  return [readTool, writeTool, editTool, bashTool, ...prjctBodyTools()]
}

export function getToolMap(tools: AgentTool[]): Map<string, AgentTool> {
  return new Map(tools.map((t) => [t.name, t]))
}
