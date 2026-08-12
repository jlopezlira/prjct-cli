/**
 * Minimal shell lexer — tokenizing + wrapper-unwrapping primitives shared by
 * instruction-guidance.ts and project-command-facts.ts. Pins the sudo
 * combined-short-flag-cluster fix from the 2026-08-12 security review.
 */

import { describe, expect, it } from 'bun:test'
import { shellCommands, unwrapCommand } from '../../services/shell-lexer'

describe('shellCommands', () => {
  it('splits on unquoted separators', () => {
    expect(shellCommands('echo hi; ls')).toEqual([['echo', 'hi'], ['ls']])
    expect(shellCommands('a | b || c && d')).toEqual([['a'], ['b'], ['c'], ['d']])
  })

  it('keeps separator characters inside quotes as part of the token', () => {
    expect(shellCommands(`echo "a; b"`)).toEqual([['echo', 'a; b']])
  })

  it('respects backslash escapes outside single quotes', () => {
    expect(shellCommands('echo a\\;b')).toEqual([['echo', 'a;b']])
  })
})

describe('unwrapCommand', () => {
  it('strips leading VAR=value assignments', () => {
    expect(unwrapCommand(['FOO=bar', 'node', 'x.js'])).toEqual(['node', 'x.js'])
  })

  it('unwraps sudo with separate flags', () => {
    expect(unwrapCommand(['sudo', '-u', 'root', 'killall', 'node'])).toEqual(['killall', 'node'])
  })

  it('unwraps sudo with a combined short-flag cluster ending in a value-taking letter', () => {
    // -Eu root: -E takes no value, -u takes a value — the value belongs to
    // the cluster as a whole (getopt semantics), so "root" must be consumed
    // as -Eu's argument, not misread as the wrapped command.
    expect(unwrapCommand(['sudo', '-Eu', 'root', 'killall', '-9', 'node'])).toEqual([
      'killall',
      '-9',
      'node',
    ])
  })

  it('unwraps env with assignments and flags', () => {
    expect(unwrapCommand(['env', 'NODE_ENV=test', 'npm', 'test'])).toEqual(['npm', 'test'])
    expect(unwrapCommand(['env', '-u', 'PATH', 'node'])).toEqual(['node'])
  })

  it('unwraps nohup', () => {
    expect(unwrapCommand(['nohup', 'node', 'server.js'])).toEqual(['node', 'server.js'])
  })

  it('leaves an unrecognized command untouched', () => {
    expect(unwrapCommand(['git', 'status'])).toEqual(['git', 'status'])
  })
})
