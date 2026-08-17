import { describe, expect, it } from 'bun:test'
import { COMMANDS } from '../../commands/command-data'
import { getHelp } from '../../utils/help'

describe('getHelp', () => {
  it('does not advertise removed bug command in main help', () => {
    const help = getHelp()

    expect(help).not.toContain('p. bug')
    expect(help).not.toContain('Report and track bugs with priority')
  })

  it('does not render terminal-only commands as p. commands', () => {
    expect(getHelp('login')).toContain('prjct login - Authenticate with prjct cloud')
    expect(getHelp('login')).not.toContain('p. login -')
    expect(getHelp('commands')).not.toContain('p. login')
  })

  it('does not list commands removed during cleanup', () => {
    const help = getHelp('commands')

    for (const command of ['suggest', 'git', 'test', 'migrate']) {
      expect(help).not.toContain(`p. ${command}`)
      expect(help).not.toContain(`prjct ${command}`)
    }
  })

  it('presents the v3 harness surface instead of task-manager primitives', () => {
    const help = getHelp()

    expect(help).toContain('agentic harness')
    expect(help).toContain('p. work')
    expect(help).toContain('p. intent')
    expect(help).toContain('p. insights')
    expect(help).toContain('p. performance')
    expect(help).not.toContain('p. task')
    expect(help).not.toContain('p. status')
    expect(help).not.toContain('p. tag')
    expect(help).not.toContain('p. capture')
  })

  it('hides legacy task-manager aliases from the command list', () => {
    const help = getHelp('commands')

    for (const command of ['task', 'status', 'tag', 'capture', 'spec', 'audit-spec']) {
      expect(help).not.toContain(`p. ${command}`)
    }
    expect(help).toContain('p. work')
    expect(help).toContain('p. intent')
  })

  it('derives the terminal command list from the manifest (no drift)', () => {
    const help = getHelp()
    const terminalOnly = COMMANDS.filter(
      (c) =>
        Boolean(c.usage?.terminal) &&
        (c.routingMode === 'bin-only' || !c.usage?.claude) &&
        c.surface !== 'legacy' &&
        c.surface !== 'internal'
    )

    // Previously invisible verbs are now listed…
    for (const name of ['health', 'retro', 'seed', 'harness', 'daemon']) {
      expect(help).toContain(`prjct ${name}`)
    }
    // …and EVERY manifest terminal command shows up — the list is derived,
    // not hand-maintained, so this holds by construction.
    for (const cmd of terminalOnly) {
      expect(help).toContain(`prjct ${cmd.name}`)
    }
    // Legacy/internal entries stay hidden.
    expect(help).not.toContain('prjct task ')
    expect(help).not.toContain('prjct analysis-save-llm')
  })

  it('explains the p. router syntax in the quick start', () => {
    const help = getHelp()

    expect(help).toContain('p. work "improve auth"')
    expect(help).toContain('in-agent command router')
  })

  it('documents colliding short flags in the affected command help entries', () => {
    expect(getHelp('watch')).toContain('--verbose|-v')
    expect(getHelp('daemon')).toContain('--follow|-f')
    expect(getHelp('daemon')).toContain('--foreground|-f')
    expect(getHelp('daemon')).toContain('-n N')
    expect(getHelp('stop')).toContain('--force|-f')
    expect(getHelp('uninstall')).toContain('--dry-run|-n')
    expect(getHelp('uninstall')).toContain('--force|-f')
  })

  it('serves per-command help for bin-only verbs from the manifest', () => {
    const help = getHelp('hooks')

    expect(help).toContain('prjct hooks')
    expect(help).toContain('install | uninstall | status')
  })
})
