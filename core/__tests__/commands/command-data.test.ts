import { describe, expect, it } from 'bun:test'
import { COMMANDS } from '../../commands/command-data'
import { REMOVED_VERBS } from '../../commands/removed-verbs'
import { BIN_COMMANDS_SET, REGISTERED_VERBS_SET } from '../../commands/verb-names'

describe('COMMANDS', () => {
  it('treats ship feature name as optional', () => {
    const ship = COMMANDS.find((command) => command.name === 'ship')

    expect(ship).toBeDefined()
    expect(ship?.params).toBe('[feature]')
  })

  it('registers agents doctor as the compatibility audit command', () => {
    const agents = COMMANDS.find((command) => command.name === 'agents')

    expect(agents?.routing).toEqual({ group: 'agents', method: 'agents' })
    expect(agents?.optionSchema).toEqual({ booleans: ['fix'] })
    expect(agents?.requiresProject).toBe(false)
    expect(REGISTERED_VERBS_SET.has('agents')).toBe(true)
  })

  it('does not advertise stale slash-command usage to agent surfaces', () => {
    const offenders = COMMANDS.filter((command) => command.usage.claude?.includes('/p:')).map(
      (command) => `${command.name}: ${command.usage.claude}`
    )

    expect(offenders).toEqual([])
  })

  it('does not advertise low-value shell-duplicate commands', () => {
    const removed = ['suggest', 'git', 'test', 'migrate']
    const names = COMMANDS.map((command) => command.name)

    for (const command of removed) {
      expect(names).not.toContain(command)
      expect(REGISTERED_VERBS_SET.has(command)).toBe(false)
      expect(BIN_COMMANDS_SET.has(command)).toBe(false)
    }
  })

  it('keeps removed v2 verbs unroutable', () => {
    for (const verb of Object.keys(REMOVED_VERBS)) {
      expect(COMMANDS.some((command) => command.name === verb)).toBe(false)
      expect(REGISTERED_VERBS_SET.has(verb)).toBe(false)
      expect(BIN_COMMANDS_SET.has(verb)).toBe(false)
    }
  })

  it('keeps agent usage on the p. grammar', () => {
    const offenders = COMMANDS.filter(
      (command) => command.usage.claude && !command.usage.claude.startsWith('p. ')
    ).map((command) => `${command.name}: ${command.usage.claude}`)

    expect(offenders).toEqual([])
  })

  it('registers paid-tier proof commands through the product command group', () => {
    const expected = [
      ['insights', 'insights'],
      ['performance', 'performance'],
      ['cost', 'cost'],
    ] as const

    for (const [name, method] of expected) {
      const command = COMMANDS.find((entry) => entry.name === name)
      expect(command?.routing).toEqual({ group: 'product', method })
      expect(command?.requiresProject).toBe(true)
      expect(REGISTERED_VERBS_SET.has(name)).toBe(true)
      expect(command?.surface).toBe('ai-agile')
    }

    expect(COMMANDS.find((entry) => entry.name === 'performance')?.optionSchema).toEqual({
      numbers: ['days'],
    })
    expect(COMMANDS.find((entry) => entry.name === 'cost')?.optionSchema).toEqual({
      numbers: ['days'],
      booleans: ['all'],
    })
  })

  it('registers v3 work-cycle primitives and keeps task-manager verbs as legacy aliases', () => {
    for (const name of ['work', 'intent', 'insights', 'performance', 'cost']) {
      const command = COMMANDS.find((entry) => entry.name === name)
      expect(command?.surface).toBe('ai-agile')
      expect(REGISTERED_VERBS_SET.has(name)).toBe(true)
    }

    for (const name2 of ['task', 'status', 'tag', 'capture', 'spec', 'audit-spec']) {
      const command = COMMANDS.find((entry) => entry.name === name2)
      expect(command?.surface).toBe('legacy')
      expect(command?.usage.claude).toBeNull()
      expect(REGISTERED_VERBS_SET.has(name2)).toBe(true)
    }
  })
})
