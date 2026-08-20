import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import { analyzeOutputSlop, recordOutputSlop } from '../../services/output-slop-detector'
import type { TranscriptJsonlLine } from '../../services/transcript-jsonl'
import { prjctDb } from '../../storage/database'

const fixture: { root: string; projectId: string } = { root: '', projectId: '' }
const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

const exchange = (prompt: string, response: string): TranscriptJsonlLine[] => [
  { message: { role: 'user', content: prompt } },
  { message: { role: 'assistant', content: response } },
]

describe('output slop detector', () => {
  beforeEach(async () => {
    fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-output-slop-'))
    fixture.projectId = `output-slop-${crypto.randomUUID()}`
    pathManager.getGlobalProjectPath = (projectId: string) => path.join(fixture.root, projectId)
    prjctDb.getDb(fixture.projectId)
  })

  afterEach(async () => {
    prjctDb.close()
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
    await fs.rm(fixture.root, { recursive: true, force: true })
  })

  it('flags only a wide compact-profile excess and persists no transcript text or PII', async () => {
    const privateText = 'person@example.com token-super-secret '
    const lines = exchange('routine status', `${privateText}${'word '.repeat(650)}`)
    const signal = analyzeOutputSlop(lines)
    expect(signal?.reason).toBe('broad-excess')
    expect(JSON.stringify(signal)).not.toContain('person@example.com')
    expect(JSON.stringify(signal)).not.toContain('token-super-secret')

    const first = await recordOutputSlop(fixture.root, fixture.projectId, lines, {
      runtime: 'codex',
      model: 'gpt-5',
      sessionId: 'same-session',
    })
    const duplicate = await recordOutputSlop(fixture.root, fixture.projectId, lines, {
      runtime: 'codex',
      model: 'gpt-5',
      sessionId: 'same-session',
    })
    expect(first?.inserted).toBe(true)
    expect(first?.memoryRecorded).toBe(true)
    expect(duplicate?.inserted).toBe(false)
    expect(duplicate?.memoryRecorded).toBe(false)
    expect(first?.signal.fingerprint).toBe(duplicate?.signal.fingerprint)

    const persisted = prjctDb.get<{ expected_behavior: string; observed_behavior: string }>(
      fixture.projectId,
      "SELECT expected_behavior, observed_behavior FROM instruction_failures WHERE category = 'output-slop'"
    )
    expect(JSON.stringify(persisted)).not.toContain('person@example.com')
    expect(JSON.stringify(persisted)).not.toContain('token-super-secret')

    const memory = prjctDb.get<{ id: string; content: string }>(
      fixture.projectId,
      "SELECT id, content FROM memory_entries WHERE type = 'improvement-signal'"
    )
    const tags = memory
      ? prjctDb.query<{ key: string; value: string }>(
          fixture.projectId,
          'SELECT key, value FROM memory_entry_tags WHERE entry_id = ?',
          memory.id
        )
      : []
    expect(memory?.content).toContain('Adaptive output signal')
    expect(tags).toContainEqual({ key: 'source', value: 'output-slop-detector' })
    expect(tags).toContainEqual({ key: 'profile', value: 'compact' })
    expect(tags).toContainEqual({ key: 'runtime', value: 'codex' })
    expect(tags).toContainEqual({ key: 'model', value: 'gpt-5' })
    expect(tags).toContainEqual({ key: 'session', value: 'same-session' })
    expect(JSON.stringify({ memory, tags })).not.toContain('person@example.com')
    expect(JSON.stringify({ memory, tags })).not.toContain('token-super-secret')

    const globalMemory = prjctDb.get<{ content: string }>(
      'global-kb',
      "SELECT content FROM memory_entries WHERE type = 'improvement-signal'"
    )
    expect(globalMemory?.content).toContain('smallest useful profile')
    expect(JSON.stringify(globalMemory)).not.toContain('person@example.com')
    expect(JSON.stringify(globalMemory)).not.toContain('token-super-secret')
  })

  it('never flags explicit expanded output in English or Spanish', () => {
    const long = 'word '.repeat(2000)
    expect(analyzeOutputSlop(exchange('Give me a detailed full report', long))).toBeNull()
    expect(analyzeOutputSlop(exchange('Dame un informe completo y detallado', long))).toBeNull()
    expect(analyzeOutputSlop(exchange('Analyze the repository in detail', long))).toBeNull()
    expect(analyzeOutputSlop(exchange('Analiza a detalle este repositorio', long))).toBeNull()
  })

  it('does not disable detection for semantic uses of full or detail', () => {
    const long = 'word '.repeat(1300)
    expect(analyzeOutputSlop(exchange('Implement full-text search', long))?.profile).toBe(
      'standard'
    )
    expect(analyzeOutputSlop(exchange('Fix the implementation detail bug', long))?.profile).toBe(
      'standard'
    )
    expect(analyzeOutputSlop(exchange('Implement a detailed logging view', long))).not.toBeNull()
  })

  it('requires strong repeated process updates with no result', () => {
    const process = [
      "I'll inspect the module.",
      'Let me check the tests.',
      "Next I'll inspect the types.",
      "Now I'll run the checks.",
      "I'll investigate the caller.",
    ].join(' ')
    expect(analyzeOutputSlop(exchange('continue', process))?.reason).toBe('process-repetition')
    expect(analyzeOutputSlop(exchange('continue', `${process} Result: tests passed.`))).toBeNull()
    expect(analyzeOutputSlop(exchange('continue', "I'll inspect it, then report back."))).toBeNull()
  })

  it('flags excessive process narration even when a result eventually appears', () => {
    const process = [
      "I'll inspect the module.",
      'Let me check the tests.',
      "Next I'll inspect the types.",
      "Now I'll run the checks.",
      "I'll investigate the caller.",
      'Checking the generated output.',
      'Running the focused suite.',
      'Inspecting the final diff.',
      'Result: tests passed.',
    ].join(' ')
    expect(analyzeOutputSlop(exchange('continue', process))?.reason).toBe('process-repetition')
  })

  it('flags substantial exact repetition without persisting the repeated prose', () => {
    const repeated =
      'The implementation now routes only the relevant private guidance and preserves every security warning while keeping the normal response compact for the caller.'
    const response = `${repeated}\n\n${repeated}\n\n${repeated}`
    const signal = analyzeOutputSlop(exchange('routine status', response))
    expect(signal?.reason).toBe('duplicated-content')
    expect(JSON.stringify(signal)).not.toContain('implementation now routes')
  })

  it('flags compact answers fragmented across too many headings', () => {
    const response = Array.from(
      { length: 6 },
      (_, index) => `## Section ${index + 1}\n${'distinct evidence '.repeat(12)} item-${index}`
    ).join('\n\n')
    expect(analyzeOutputSlop(exchange('routine status', response))?.reason).toBe('structure-sprawl')
  })

  it('uses the standard diagnosis profile before applying the wide-excess threshold', () => {
    expect(
      analyzeOutputSlop(exchange('Diagnostica la regresión y el timeout', 'word '.repeat(700)))
    ).toBeNull()
    expect(
      analyzeOutputSlop(exchange('Diagnostica la regresión y el timeout', 'word '.repeat(1300)))
        ?.profile
    ).toBe('standard')
  })

  it('uses the standard H2 feature profile instead of recording a compact false positive', () => {
    expect(analyzeOutputSlop(exchange('Add account behavior', 'word '.repeat(700)))).toBeNull()
    expect(analyzeOutputSlop(exchange('Add account behavior', 'word '.repeat(1300)))?.profile).toBe(
      'standard'
    )
  })

  it('keeps the active H2 profile when the latest prompt is only continue', () => {
    const active = {
      taskDescription: 'Implement account behavior across the API and storage layers',
      harness: { level: 'H2' as const, kind: 'feature' as const },
    }
    expect(analyzeOutputSlop(exchange('continue', 'word '.repeat(700)), active)).toBeNull()
    expect(analyzeOutputSlop(exchange('continue', 'word '.repeat(1300)), active)?.profile).toBe(
      'standard'
    )
  })
})
