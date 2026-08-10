/**
 * Credential non-exposure MUST — PreToolUse pre-secrets.
 */

import { describe, expect, it, spyOn } from 'bun:test'
import { _internal, runPreSecretsHook } from '../../hooks/pre-secrets'
import { PRJCT_HOOKS } from '../../services/settings-installer'
import {
  hookCommandUsesFragileEnv,
  scanForSecrets,
  scanHookToolInput,
} from '../../utils/secret-scanner'

describe('secret-scanner patterns', () => {
  it('hits known credential shapes', () => {
    expect(scanForSecrets('export KEY=sk-abcdefghijklmnopqrstuvwxyz')).toContain('sk-… token')
    expect(scanForSecrets('token=ghp_abcdefghijklmnopqrstuvwxyz012345')).toContain('GitHub PAT')
    expect(scanForSecrets('AKIAIOSFODNN7EXAMPLE')).toContain('AWS access key')
    expect(scanForSecrets('sbp_abcdefghijklmnopqrstuvwxyz12')).toContain('Supabase access token')
    expect(scanForSecrets('prjct_sk_live_abc123xyz99')).toContain('prjct live token')
    expect(scanForSecrets('-----BEGIN RSA PRIVATE KEY-----')).toContain('PEM private key')
  })

  it('is silent on ordinary code', () => {
    expect(scanForSecrets('const x = 1; fetch("https://api.example.com")')).toEqual([])
  })
})

describe('scanHookToolInput', () => {
  it('scans Claude Bash tool_input.command', () => {
    const hits = scanHookToolInput({
      tool_name: 'Bash',
      tool_input: { command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuv"' },
    })
    expect(hits.length).toBeGreaterThan(0)
  })

  it('scans Claude Write content', () => {
    const hits = scanHookToolInput({
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/.env',
        content: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz',
      },
    })
    expect(hits).toContain('OpenAI project key')
  })

  it('scans Gemini-shaped nested args', () => {
    const hits = scanHookToolInput({
      tool_name: 'run_shell_command',
      tool_input: { command: 'echo ghp_abcdefghijklmnopqrstuvwxyz012345' },
    })
    expect(hits).toContain('GitHub PAT')
  })

  it('scans the tail of oversized tool input instead of allowing a padding bypass', () => {
    const syntheticKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz'].join('-')
    const hits = scanHookToolInput({
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/generated.txt',
        content: `${'x'.repeat(200_000)} ${syntheticKey}`,
      },
    })

    expect(hits).toContain('OpenAI project key')
  })

  it('scans secrets in the middle of oversized tool input', () => {
    const syntheticKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz'].join('-')
    const hits = scanHookToolInput({
      tool_name: 'Write',
      tool_input: {
        content: `${'x'.repeat(110_000)} ${syntheticKey} ${'y'.repeat(110_000)}`,
      },
    })

    expect(hits).toContain('OpenAI project key')
  })

  it('scans deeply nested tool input without a depth bypass', () => {
    const syntheticKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz'].join('-')
    const nested = Array.from({ length: 12 }).reduce<unknown>((value) => ({ nested: value }), {
      content: syntheticKey,
    })

    expect(scanHookToolInput({ tool_name: 'custom', tool_input: nested })).toContain(
      'OpenAI project key'
    )
  })

  it('finds a secret crossing a chunk boundary', () => {
    const syntheticKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz'].join('-')
    const content = `${'x'.repeat(65_530)} ${syntheticKey}${'y'.repeat(160_000)}`

    expect(scanHookToolInput({ tool_input: { content } })).toContain('OpenAI project key')
  })

  it('handles cyclic object graphs without skipping nested secrets', () => {
    const syntheticKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz'].join('-')
    const cyclic: { nested: unknown; self?: unknown } = {
      nested: { content: syntheticKey },
    }
    cyclic.self = cyclic

    expect(scanHookToolInput({ tool_input: cyclic })).toContain('OpenAI project key')
  })

  it('scans a 10 MB payload with a middle secret within the hook budget', () => {
    const syntheticKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz'].join('-')
    const content = `${'x'.repeat(5_000_000)} ${syntheticKey}${'y'.repeat(5_000_000)}`

    expect(scanHookToolInput({ tool_input: { content } })).toContain('OpenAI project key')
  }, 1_000)
})

describe('decideSecrets', () => {
  it('denies when secrets present', () => {
    const d = _internal.decideSecrets({
      tool_name: 'Bash',
      tool_input: { command: 'curl https://x -H "Authorization: Bearer sk-abcdefghijklmnopqr"' },
    })
    expect(d).not.toBeNull()
    expect(d!.deny).toMatch(/credential guard/i)
    expect(d!.deny).toMatch(/PPID/i) // documents no-PPID design
  })

  it('allows clean input', () => {
    expect(
      _internal.decideSecrets({
        tool_name: 'Bash',
        tool_input: { command: 'bun test' },
      })
    ).toBeNull()
  })

  it('denies a secret hidden after oversized padding', () => {
    const syntheticKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz'].join('-')
    const decision = _internal.decideSecrets({
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/generated.txt',
        content: `${'x'.repeat(200_000)} ${syntheticKey}`,
      },
    })

    expect(decision?.deny).toMatch(/credential guard/i)
  })
})

describe('runPreSecretsHook deny path', () => {
  it('emits permissionDecision deny on secret hit', async () => {
    const writes: string[] = []
    const spy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'))
      return true
    }) as typeof process.stdout.write)
    const originalIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

    // Daemon-mode path with pre-parsed input (no stdin wait)
    await runPreSecretsHook(process.cwd(), {
      input: {
        tool_name: 'Bash',
        tool_input: { command: 'export TOKEN=sk-abcdefghijklmnopqrstuvwxyz01' },
      },
      sink: (chunk) => writes.push(chunk),
      detachAfterEmit: () => {},
    })

    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
    spy.mockRestore()

    const out = writes.join('')
    expect(out).toMatch(/deny|permissionDecision/i)
    expect(out).toMatch(/credential guard/i)
  })
})

describe('managed hooks never depend on PPID', () => {
  it('PRJCT_HOOKS subcommands are portable (no fragile env in command template)', () => {
    // The install template is: `command -v prjct … && prjct hook <sub> || exit 0`
    for (const spec of PRJCT_HOOKS) {
      const cmd = `command -v prjct >/dev/null 2>&1 && prjct hook ${spec.subcommand} || exit 0`
      expect(hookCommandUsesFragileEnv(cmd)).toBe(false)
      // Gemini variant
      const g = `command -v prjct >/dev/null 2>&1 && PRJCT_HOOK_HOST=gemini prjct hook ${spec.subcommand} || exit 0`
      expect(hookCommandUsesFragileEnv(g)).toBe(false)
    }
  })

  it('flags Supacode-style PPID hooks as fragile', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional fragile-env fixture
    const fragile = '[ -n "${SUPACODE_SURFACE_ID:-}" ] && ps -o tty= -p "$PPID" # supacode'
    expect(hookCommandUsesFragileEnv(fragile)).toBe(true)
  })

  it('registers pre-secrets for both Bash and Edit|Write', () => {
    const secrets = PRJCT_HOOKS.filter((h) => h.subcommand === 'pre-secrets')
    expect(secrets.length).toBe(2)
    const matchers = secrets.map((h) => String(h.matcher)).sort()
    expect(matchers).toEqual(['Bash', 'Edit|Write'])
  })
})
