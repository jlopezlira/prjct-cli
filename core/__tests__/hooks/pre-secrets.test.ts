/**
 * Credential non-exposure MUST — PreToolUse pre-secrets.
 *
 * Every credential-shaped fixture is assembled at RUNTIME. A literal one would
 * be denied by the very guard under test (the hook scans Edit/Write content,
 * so this file could not be edited), and no credential-shaped literal belongs
 * in the repo in the first place.
 */

import { describe, expect, it, spyOn } from 'bun:test'
import { _internal, runPreSecretsHook } from '../../hooks/pre-secrets'
import { PRJCT_HOOKS } from '../../services/settings-installer'
import {
  hookCommandUsesFragileEnv,
  scanForSecrets,
  scanHookToolInput,
} from '../../utils/secret-scanner'

const SK = 's'.concat('k')
const GHP = 'g'.concat('hp_')
const SBP = 's'.concat('bp_')
const AKIA = 'AKI'.concat('A')
const PRJCT_TOKEN = 'prjct_'.concat('sk_live_')
const PEM_BEGIN = '-----BEGIN RSA '.concat('PRIVATE KEY-----')
const BODY = 'abcdefghijklmnopqrstuvwxyz'
/** High-entropy 40-char value, the shape of an AWS secret access key. */
const AWS_SECRET = 'Kp9rXe2LqTv7Nb4Zc1Hm6Wd3Yf8Ju5Ra0Sg7Vt2B'
const projKey = () => `${SK}-proj-${BODY}`

describe('secret-scanner patterns', () => {
  it('hits known credential shapes', () => {
    expect(scanForSecrets(`export KEY=${SK}-${BODY}`)).toContain('sk-… token')
    expect(scanForSecrets(`token=${GHP}${BODY}012345`)).toContain('GitHub PAT')
    expect(scanForSecrets(`${AKIA}3QP7ZK2WLMN4RTBD`)).toContain('AWS access key')
    expect(scanForSecrets(`${SBP}${BODY}12`)).toContain('Supabase access token')
    expect(scanForSecrets(`${PRJCT_TOKEN}abc123xyz99`)).toContain('prjct live token')
    expect(scanForSecrets(PEM_BEGIN)).toContain('PEM private key')
  })

  it('is silent on ordinary code', () => {
    expect(scanForSecrets('const x = 1; fetch("https://api.example.com")')).toEqual([])
  })

  // The AKIA… id is not the credential. The 40-char SECRET matched no pattern
  // at all, so a real one passed straight through the guard.
  it('catches the AWS secret access key, not just the access key id', () => {
    expect(scanForSecrets(`aws_secret_access_key = ${AWS_SECRET}`)).toContain(
      'AWS secret access key'
    )
    expect(scanForSecrets(`AWS_SECRET_ACCESS_KEY="${AWS_SECRET}"`)).toContain(
      'AWS secret access key'
    )
  })

  // Denying these blocked real work — writing a fixture, documenting the shape
  // of a key, even editing this file — and told the author to "remove the
  // secret" when there was none to remove.
  it('does not deny doc placeholders or obvious fixtures', () => {
    expect(scanForSecrets(`ANTHROPIC_API_KEY=${SK}-ant-${'x'.repeat(12)}`)).toEqual([])
    expect(scanForSecrets(`const FAKE = '${SK}-test-${'0'.repeat(16)}'`)).toEqual([])
    expect(scanForSecrets(`${AKIA}IOSFODNN7EXAMPLE`)).toEqual([])
    expect(scanForSecrets(`Bearer ${SK}-<your-key-here>${'0'.repeat(8)}`)).toEqual([])
  })

  // A placeholder near the top of a README must not mask a real key below it.
  it('still denies a real key that appears after a placeholder', () => {
    const doc = [
      `Set ANTHROPIC_API_KEY=${SK}-ant-${'x'.repeat(12)}`,
      `leaked = ${SK}-${AWS_SECRET}`,
    ].join('\n')
    expect(scanForSecrets(doc)).toContain('sk-… token')
  })

  // A real key butted against padding matches as ONE long token whose tail is
  // a huge identical run; that must not read as a placeholder.
  it('denies a real key adjacent to padding', () => {
    expect(scanForSecrets(`${projKey()}${'y'.repeat(50_000)}`).length).toBeGreaterThan(0)
  })
})

describe('scanHookToolInput', () => {
  it('scans Claude Bash tool_input.command', () => {
    const hits = scanHookToolInput({
      tool_name: 'Bash',
      tool_input: { command: `curl -H "Authorization: Bearer ${SK}-${BODY}"` },
    })
    expect(hits.length).toBeGreaterThan(0)
  })

  it('scans Claude Write content', () => {
    const hits = scanHookToolInput({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/.env', content: `OPENAI_API_KEY=${projKey()}` },
    })
    expect(hits).toContain('OpenAI project key')
  })

  it('scans Gemini-shaped nested args', () => {
    const hits = scanHookToolInput({
      tool_name: 'run_shell_command',
      tool_input: { command: `echo ${GHP}${BODY}012345` },
    })
    expect(hits).toContain('GitHub PAT')
  })

  it('scans the tail of oversized tool input instead of allowing a padding bypass', () => {
    const hits = scanHookToolInput({
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/generated.txt',
        content: `${'x'.repeat(200_000)} ${projKey()}`,
      },
    })

    expect(hits).toContain('OpenAI project key')
  })

  it('scans secrets in the middle of oversized tool input', () => {
    const hits = scanHookToolInput({
      tool_name: 'Write',
      tool_input: {
        content: `${'x'.repeat(110_000)} ${projKey()} ${'y'.repeat(110_000)}`,
      },
    })

    expect(hits).toContain('OpenAI project key')
  })

  it('scans deeply nested tool input without a depth bypass', () => {
    const nested = Array.from({ length: 12 }).reduce<unknown>((value) => ({ nested: value }), {
      content: projKey(),
    })

    expect(scanHookToolInput({ tool_name: 'custom', tool_input: nested })).toContain(
      'OpenAI project key'
    )
  })

  it('finds a secret crossing a chunk boundary', () => {
    const content = `${'x'.repeat(65_530)} ${projKey()}${'y'.repeat(160_000)}`

    expect(scanHookToolInput({ tool_input: { content } })).toContain('OpenAI project key')
  })

  it('handles cyclic object graphs without skipping nested secrets', () => {
    const cyclic: { nested: unknown; self?: unknown } = {
      nested: { content: projKey() },
    }
    cyclic.self = cyclic

    expect(scanHookToolInput({ tool_input: cyclic })).toContain('OpenAI project key')
  })

  it('scans a 10 MB payload with a middle secret within the hook budget', () => {
    const content = `${'x'.repeat(5_000_000)} ${projKey()}${'y'.repeat(5_000_000)}`

    expect(scanHookToolInput({ tool_input: { content } })).toContain('OpenAI project key')
  }, 1_000)
})

describe('decideSecrets', () => {
  it('denies when secrets present', () => {
    const d = _internal.decideSecrets({
      tool_name: 'Bash',
      tool_input: { command: `curl https://x -H "Authorization: Bearer ${SK}-${BODY}"` },
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
    const decision = _internal.decideSecrets({
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/generated.txt',
        content: `${'x'.repeat(200_000)} ${projKey()}`,
      },
    })

    expect(decision?.deny).toMatch(/credential guard/i)
  })

  it('allows an edit whose only match is a documented placeholder', () => {
    expect(
      _internal.decideSecrets({
        tool_name: 'Write',
        tool_input: {
          file_path: '/repo/README.md',
          content: `Set \`ANTHROPIC_API_KEY=${SK}-ant-${'x'.repeat(12)}\` before running.`,
        },
      })
    ).toBeNull()
  })
})

// A scanner crash is not a clean scan (SEC-05). Write-like calls are the
// ones a credential leaves through, so they fail closed; a Read cannot leak
// and keeps the never-brick-the-session contract.
describe('decideOnScannerFailure', () => {
  const boom = new Error('regex blew up')

  it('denies write-like tool calls and names the failure', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'apply_patch', 'write_file', 'Bash']) {
      const d = _internal.decideOnScannerFailure({ tool_name: tool, tool_input: {} }, boom)
      expect(d?.deny).toMatch(/scanner failed/i)
      expect(d?.deny).toContain('regex blew up')
    }
  })

  it('stays fail-soft for read-like calls', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'read_file', undefined]) {
      expect(_internal.decideOnScannerFailure({ tool_name: tool, tool_input: {} }, boom)).toBeNull()
    }
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
        tool_input: { command: `export TOKEN=${SK}-${BODY}01` },
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

  it('registers one consolidated pre-process per Bash/Edit event', () => {
    const preTools = PRJCT_HOOKS.filter((h) => h.event === 'PreToolUse')
    expect(preTools.filter((h) => h.matcher === 'Bash').map((h) => h.subcommand)).toEqual([
      'pre-bash',
    ])
    const preEdit = preTools.filter((h) => h.subcommand === 'pre-edit')
    expect(preEdit.map((h) => h.subcommand)).toEqual(['pre-edit'])
    expect(preEdit[0]?.matcher).toContain('apply_patch')
  })
})
