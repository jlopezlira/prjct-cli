/**
 * classifyBroadProcessTermination — the PreToolUse deny gate for
 * killall/pkill-style broad process termination (core/hooks/pre-bash.ts).
 * Pins both the original contract and the bypass fixes found in the
 * 2026-08-12 security review.
 */

import { describe, expect, it } from 'bun:test'
import {
  broadProcessTerminationDenial,
  classifyBroadProcessTermination,
} from '../../services/instruction-guidance'

describe('classifyBroadProcessTermination', () => {
  describe('sanctioned path stays allowed', () => {
    it('allows kill by exact PID, any signal flag', () => {
      expect(classifyBroadProcessTermination('kill 12345')).toBe(false)
      expect(classifyBroadProcessTermination('kill -9 12345')).toBe(false)
      expect(classifyBroadProcessTermination('kill -TERM 12345')).toBe(false)
    })

    it('allows kill fed by a PID lookup in an unwrapped-argument position — not obfuscation', () => {
      // The executable itself ("kill") is a literal, unambiguous token —
      // command substitution in an ARGUMENT is the sanctioned "look up the
      // PID, then kill it" pattern, not an evasion of the classifier.
      expect(classifyBroadProcessTermination('kill -9 $(pgrep -f node)')).toBe(false)
    })

    it('allows unrelated commands', () => {
      expect(classifyBroadProcessTermination('npm test')).toBe(false)
      expect(classifyBroadProcessTermination('echo $HOME && ls')).toBe(false)
    })

    // `VAR=$(cmd …)` is ONE assignment, not an env-prefixed command. The
    // unwrapper used to strip the `VAR=` prefix (right for `FOO=bar cmd`),
    // which promoted the inner command's ARGUMENTS to command position — so
    // any `$` among them read as an unresolved executable and these everyday
    // shapes were denied, with advice about PIDs that made no sense.
    it('allows a command-substitution assignment whose inner command takes $ arguments', () => {
      const benign = [
        'OUT=$(echo "$CWD") ; echo done',
        'N=$(cat "$F" | wc -l); echo $N',
        'ROOT=$(git rev-parse --show-toplevel) && cd "$ROOT"',
        'JSON=$(printf \'{"cwd":"%s"}\' "$PWD") && echo "$JSON"',
        'SHA=$(gh pr view --json headRefOid -q .headRefOid); echo "$SHA"',
      ]
      for (const command of benign) {
        expect(classifyBroadProcessTermination(command)).toBe(false)
      }
    })

    // A quoted heredoc body is inert text to the shell. Lexed as commands, its
    // words landed in command position — so any `${…}` inside a Python/JS
    // payload denied the whole call.
    it('allows a heredoc whose body contains $ and backticks', () => {
      const heredoc = [
        "python3 - <<'PYEOF'",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this literal placeholder inside the heredoc body is exactly what used to trigger the denial.
        'print("${m.modelDirective(\'orchestrator\')}")',
        'print(`echo pkill`)',
        'PYEOF',
      ].join('\n')
      expect(classifyBroadProcessTermination(heredoc)).toBe(false)
    })
  })

  describe('killall — always denied', () => {
    it('denies plain killall', () => {
      expect(classifyBroadProcessTermination('killall node')).toBe(true)
    })

    it('denies killall regardless of case (case-insensitive PATH lookup on macOS/Windows)', () => {
      expect(classifyBroadProcessTermination('KILLALL node')).toBe(true)
      expect(classifyBroadProcessTermination('Killall node')).toBe(true)
    })
  })

  describe('pkill — always denied, not just with -f', () => {
    it('denies pkill -f / --full (original contract)', () => {
      expect(classifyBroadProcessTermination('pkill -f "vite --host"')).toBe(true)
      expect(classifyBroadProcessTermination('pkill --full vite')).toBe(true)
    })

    it('denies bare pkill without -f — same blast radius (matches by name across every process)', () => {
      expect(classifyBroadProcessTermination('pkill node')).toBe(true)
      expect(classifyBroadProcessTermination('pkill -9 node')).toBe(true)
    })

    it('denies pkill regardless of case', () => {
      expect(classifyBroadProcessTermination('PKILL node')).toBe(true)
    })
  })

  describe('wrapped in sh/bash/zsh -c', () => {
    it('denies a nested broad-termination command', () => {
      expect(classifyBroadProcessTermination("bash -lc 'pkill -f vite'")).toBe(true)
      expect(classifyBroadProcessTermination('sh -c "killall node"')).toBe(true)
    })
  })

  describe('xargs — inherently applies to a list of inputs', () => {
    it('denies xargs wrapping killall/pkill', () => {
      expect(classifyBroadProcessTermination('pgrep -f node | xargs killall')).toBe(true)
      expect(classifyBroadProcessTermination('pgrep -f node | xargs pkill')).toBe(true)
    })

    it('denies xargs wrapping bare kill — same "no single verified PID" outcome', () => {
      expect(classifyBroadProcessTermination('pgrep -f vite | xargs kill')).toBe(true)
      expect(
        classifyBroadProcessTermination("ps aux | grep node | awk '{print $2}' | xargs kill -9")
      ).toBe(true)
    })
  })

  describe('obfuscated executable identity — fail closed', () => {
    it('denies a variable-assigned executable used in command position', () => {
      expect(classifyBroadProcessTermination('a=killall; $a -9 node')).toBe(true)
    })

    it('denies a command-substituted executable', () => {
      expect(classifyBroadProcessTermination('$(echo killall) node')).toBe(true)
      expect(classifyBroadProcessTermination('`echo pkill` -f node')).toBe(true)
    })

    it('still sees a broad kill hidden INSIDE a substitution', () => {
      expect(classifyBroadProcessTermination('OUT=$(killall node); echo "$OUT"')).toBe(true)
      expect(classifyBroadProcessTermination('echo "$(pkill -f vite)"')).toBe(true)
    })
  })

  describe('sudo-wrapped commands, including combined short-flag clusters', () => {
    it('denies sudo with separate flags (original contract)', () => {
      expect(classifyBroadProcessTermination('sudo -u root killall node')).toBe(true)
    })

    it('denies sudo with a combined short-flag cluster that takes a value (-Eu root)', () => {
      expect(classifyBroadProcessTermination('sudo -Eu root killall -9 node')).toBe(true)
    })
  })

  describe('broadProcessTerminationDenial', () => {
    it('returns the denial message only when the command is classified as broad termination', () => {
      expect(broadProcessTerminationDenial('kill 12345')).toBeNull()
      expect(broadProcessTerminationDenial('pkill node')).toContain('prjct: denied')
    })

    it('gives PID advice for a real broad kill', () => {
      expect(broadProcessTerminationDenial('killall node')).toContain('exact numeric PID')
    })

    // Telling an agent to "identify the exact numeric PID" when it ran no
    // kill at all is unactionable — it retries blind. Name the token and rule.
    it('explains the actual rule for an unresolved executable, not PIDs', () => {
      const denial = broadProcessTerminationDenial('$a -9 node') ?? ''
      expect(denial).toContain('$a')
      expect(denial).toContain('resolves at runtime')
      expect(denial).not.toContain('exact numeric PID')
    })
  })
})
