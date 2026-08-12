/**
 * Friction detector — extracts user-pushback signals from a Claude
 * Code session transcript. Tests pin: classifier coverage,
 * idempotent dedup, English markers, conservative cap, specific
 * constraint distillation, and recurring-pushback → feedback promote.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { projectMemory } from '../../memory/project-memory'
import { _internal, detectFriction } from '../../services/friction-detector'

const fixture: {
  projectPath: string
  projectId: string
} = {
  projectPath: '',
  projectId: '',
}

async function freshProject(): Promise<void> {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-friction-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `fric-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
}

describe('friction-detector classify', () => {
  it('flags negation markers', () => {
    expect(_internal.classify('no, that is wrong')).toBe('negation')
    expect(_internal.classify('No. that is wrong')).toBe('negation')
    expect(_internal.classify('stop please')).toBe('negation')
    expect(_internal.classify('wait — ')).toBe('negation')
    expect(_internal.classify('cancel that')).toBe('negation')
  })

  it('flags correction markers', () => {
    expect(_internal.classify('that should be feat: not fix:')).toBe('correction')
    expect(_internal.classify('rather than X, try Y')).toBe('correction')
    expect(_internal.classify('use Y instead of X')).toBe('correction')
  })

  it('flags complaint markers', () => {
    expect(_internal.classify("doesn't work")).toBe('complaint')
    expect(_internal.classify('this is broken')).toBe('complaint')
  })

  it('returns null for ordinary discussion', () => {
    expect(_internal.classify('let me see if that works')).toBeNull()
    expect(_internal.classify('ok proceed')).toBeNull()
    expect(_internal.classify('sounds good, continue')).toBeNull()
  })
})

describe('friction-detector parseJsonl + extractSignals', () => {
  it('extracts a friction signal from user negation after assistant action', () => {
    const lines = _internal.parseJsonl(
      [
        JSON.stringify({ role: 'assistant', content: "I'll run prjct ship now." }),
        JSON.stringify({ role: 'user', content: 'no, run the tests first' }),
      ].join('\n')
    )
    const signals = _internal.extractSignals(lines)
    expect(signals.length).toBe(1)
    expect(signals[0]?.category).toBe('negation')
    expect(signals[0]?.precedingAssistantPreview).toContain('prjct ship')
  })

  it('handles Anthropic content-block format', () => {
    const lines = _internal.parseJsonl(
      [
        JSON.stringify({
          role: 'assistant',
          content: [{ type: 'text', text: 'Done. Anything else?' }],
        }),
        JSON.stringify({
          role: 'user',
          content: [{ type: 'text', text: "doesn't work, try again" }],
        }),
      ].join('\n')
    )
    const signals = _internal.extractSignals(lines)
    expect(signals.length).toBe(1)
    expect(signals[0]?.category).toBe('complaint')
  })

  it('skips malformed JSONL lines silently', () => {
    const raw = [
      'not-json-at-all',
      JSON.stringify({ role: 'user', content: 'no, do something else' }),
      '',
    ].join('\n')
    const lines = _internal.parseJsonl(raw)
    expect(lines.length).toBe(1)
    const signals = _internal.extractSignals(lines)
    expect(signals.length).toBe(1)
  })

  it('hashSignal normalises whitespace and casing for dedup', () => {
    const a = _internal.hashSignal('No,   THIS is broken')
    const b = _internal.hashSignal('no, this is broken')
    expect(a).toBe(b)
  })

  it('formats friction as a structured lesson instead of a raw quote lead', () => {
    const signal = {
      category: 'negation' as const,
      excerpt: 'no, run the tests first',
      precedingAssistantPreview: "I'll run prjct ship now.",
    }
    const formatted = _internal.formatSignal(signal)

    expect(formatted).toStartWith('[negation] Lesson:')
    expect(formatted).toContain('What happened: The user pushed back after the assistant response.')
    expect(formatted).toContain('Why it mattered:')
    expect(formatted).toContain('Pattern:')
    expect(formatted).toContain('Anti-pattern:')
    expect(formatted).toContain('Next action:')
    expect(formatted).not.toContain('Evidence:')
    // Raw quote never stored; distilled constraint is.
    expect(formatted).not.toContain('no, run the tests first')
    expect(formatted).not.toContain("I'll run prjct ship now.")
    expect(formatted).not.toStartWith('[negation] User pushback:')
    expect(formatted).toContain('Run the tests first')
    expect(formatted).toMatch(/Next action: Always: Run the tests first/i)
  })

  it('extractSpecificConstraint distills corrections without raw dumps', () => {
    expect(_internal.extractSpecificConstraint('that should be feat: not fix:')).toMatch(
      /Prefer feat:/i
    )
    expect(_internal.extractSpecificConstraint('no, run the tests first')).toBe(
      'Run the tests first'
    )
    expect(_internal.extractSpecificConstraint('use bun instead of npm')).toMatch(/bun/i)
    expect(_internal.extractSpecificConstraint('sounds good continue')).toBeNull()
  })

  it('caps signals at MAX_SIGNALS_PER_SESSION', () => {
    expect(_internal.MAX_SIGNALS_PER_SESSION).toBeLessThanOrEqual(10)
  })
})

describe('friction-detector promote recurring pushback to feedback', () => {
  beforeEach(freshProject)
  afterEach(async () => {
    if (fixture.projectPath) {
      await fs.rm(fixture.projectPath, { recursive: true, force: true })
      fixture.projectPath = ''
    }
  })

  it('records a signal once, then promotes standing preference on repeat', async () => {
    const transcript = [
      JSON.stringify({ role: 'assistant', content: "I'll ship now." }),
      JSON.stringify({ role: 'user', content: 'no, run the tests first' }),
    ].join('\n')
    const file = path.join(fixture.projectPath, 't.jsonl')
    await fs.writeFile(file, transcript)

    const first = await detectFriction(fixture.projectPath, file, 'sess-1', {
      runtime: 'codex',
      model: 'gpt-5.6',
    })
    expect(first.signalsRecorded).toBe(1)
    expect(first.failures).toEqual([
      {
        category: 'negation',
        expectedBehavior: 'Follow the user constraint without requiring correction.',
        observedBehavior: 'The assistant response triggered user negation.',
        relatedRuleId: null,
      },
    ])
    const attributed = projectMemory.recall(fixture.projectId, {
      types: ['improvement-signal'],
      tags: { source: 'friction-detector' },
    })[0]
    expect(attributed?.tags.runtime).toBe('codex')
    expect(attributed?.tags.model).toBe('gpt-5.6')

    const second = await detectFriction(fixture.projectPath, file, 'sess-2')
    expect(second.signalsRecorded).toBe(0)
    expect(second.signalsSkipped).toBeGreaterThanOrEqual(1)

    const prefs = projectMemory.recall(fixture.projectId, {
      types: ['feedback'],
      tags: { source: _internal.PROMOTE_SOURCE },
      limit: 5,
      dedupeByKey: false,
    })
    expect(prefs.length).toBe(1)
    expect(prefs[0]?.content).toMatch(/Always: Run the tests first/i)
  })
})
