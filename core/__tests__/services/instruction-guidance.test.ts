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
  })
})
