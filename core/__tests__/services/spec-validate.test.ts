/**
 * spec-validate tests (Phase 2).
 *
 * Exercises:
 *   - parseScopePath / parseScopePaths — the shared scope-entry peel
 *     (regression net for the extractScopePaths / inferModule unification)
 *   - each validation rule firing AND passing (severities: delta-model
 *     structural rules are errors; legacy free-text + unresolved scope
 *     paths are warnings)
 *   - command-level strict exit behavior (`spec validate`, `spec audit`)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SpecCommands } from '../../commands/spec'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { applyDelta } from '../../services/spec-delta'
import { specService } from '../../services/spec-service'
import { parseScopePath, parseScopePaths, validateSpec } from '../../services/spec-validate'
import prjctDb from '../../storage/database'
import { emptySpecContent, type Spec, type SpecContent, SpecContentSchema } from '../../types/spec'

function makeSpec(content: SpecContent): Spec {
  return {
    id: 'spec_t',
    title: 'T',
    status: 'draft',
    content,
    tags: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    shippedAt: null,
    shippedPr: null,
    shippedSha: null,
    archivedAt: null,
  }
}

const TS = '2026-01-01T00:00:00.000Z'

const DELTA_FULL = `## ADDED Requirements
### Requirement: User Auth
The system SHALL authenticate requests via bearer tokens.

#### Scenario: valid token
- **GIVEN** a valid token
- **WHEN** the request arrives
- **THEN** access is granted
`

const DELTA_NO_SHALL_NO_SCENARIO = `## ADDED Requirements
### Requirement: User Auth
The system authenticates requests.
`

const DELTA_THEN_ONLY = `## ADDED Requirements
### Requirement: User Auth
The system SHALL authenticate requests.

#### Scenario: valid token
- **THEN** access is granted
`

describe('parseScopePath(s) — shared scope-entry peel', () => {
  test('peels a file path with a "— desc" suffix', () => {
    expect(parseScopePath('core/sync/sync-manager.ts — the manager')).toBe(
      'core/sync/sync-manager.ts'
    )
  })

  test('peels a dir with trailing slash, then a bare dir path', () => {
    expect(parseScopePath('core/auth/ — everything auth')).toBe('core/auth/')
    expect(parseScopePath('core/auth — everything auth')).toBe('core/auth')
  })

  test('returns null for plain prose', () => {
    expect(parseScopePath('the billing module')).toBeNull()
  })

  test('dedupes and caps at 12', () => {
    const scope = Array.from({ length: 15 }, (_, i) => `core/m${i}/f.ts`)
    scope.push('core/m0/f.ts') // duplicate of the first entry
    const out = parseScopePaths(scope)
    expect(out.length).toBe(12)
    expect(new Set(out).size).toBe(12)
  })
})

describe('validateSpec — delta-model rules (errors)', () => {
  test('clean delta-model spec passes with zero findings', () => {
    const content = applyDelta(emptySpecContent('auth'), DELTA_FULL, { ts: TS })
    const v = validateSpec(makeSpec(content))
    expect(v.errors).toEqual([])
    expect(v.warnings).toEqual([])
  })

  test('requirement without a SHALL-style statement → error', () => {
    const content = applyDelta(emptySpecContent('auth'), DELTA_NO_SHALL_NO_SCENARIO, { ts: TS })
    const v = validateSpec(makeSpec(content))
    expect(v.errors.some((e) => e.includes('no SHALL-style statement'))).toBe(true)
  })

  test('requirement without scenarios → error', () => {
    const content = applyDelta(emptySpecContent('auth'), DELTA_NO_SHALL_NO_SCENARIO, { ts: TS })
    const v = validateSpec(makeSpec(content))
    expect(v.errors.some((e) => e.includes('has no scenarios'))).toBe(true)
  })

  test('scenario missing GIVEN/WHEN → error naming the clauses', () => {
    const content = applyDelta(emptySpecContent('auth'), DELTA_THEN_ONLY, { ts: TS })
    const v = validateSpec(makeSpec(content))
    const missing = v.errors.find((e) => e.includes('is missing'))
    expect(missing).toBeTruthy()
    expect(missing).toContain('GIVEN')
    expect(missing).toContain('WHEN')
    expect(missing).not.toContain('THEN)')
  })

  test('SHALL + full scenario ⇒ neither rule fires', () => {
    const content = applyDelta(emptySpecContent('auth'), DELTA_FULL, { ts: TS })
    const v = validateSpec(makeSpec(content))
    expect(v.errors.some((e) => e.includes('SHALL'))).toBe(false)
    expect(v.errors.some((e) => e.includes('scenario'))).toBe(false)
  })

  test('REMOVED op targeting a slug that never existed → error', () => {
    const content = SpecContentSchema.parse({
      goal: 'x',
      delta_log: [
        { id: 'd1', ts: TS, ops: { added: [], modified: [], removed: ['ghost-requirement'] } },
      ],
    })
    const v = validateSpec(makeSpec(content))
    expect(
      v.errors.some((e) => e.includes('ghost-requirement') && e.includes('never existed'))
    ).toBe(true)
  })

  test('REMOVED of a previously-ADDED slug is fine', () => {
    const added = applyDelta(emptySpecContent('auth'), DELTA_FULL, { ts: TS })
    const removed = applyDelta(added, `## REMOVED Requirements\n### Requirement: User Auth\n`, {
      ts: '2026-01-02T00:00:00.000Z',
    })
    const v = validateSpec(makeSpec(removed))
    expect(v.errors).toEqual([])
  })
})

describe('validateSpec — legacy rules (warnings, never errors)', () => {
  test('legacy free-text ACs produce warnings, not errors', () => {
    const content = SpecContentSchema.parse({
      goal: 'x',
      acceptance_criteria: ['it works', 'it is fast'],
    })
    const v = validateSpec(makeSpec(content))
    expect(v.errors).toEqual([])
    expect(v.warnings.some((w) => w.includes('legacy spec'))).toBe(true)
    expect(v.warnings.filter((w) => w.includes('not SHALL-style')).length).toBe(2)
  })

  test('SHALL-style free-text AC skips the per-AC warning (legacy note stays)', () => {
    const content = SpecContentSchema.parse({
      goal: 'x',
      acceptance_criteria: ['The system SHALL work'],
    })
    const v = validateSpec(makeSpec(content))
    expect(v.errors).toEqual([])
    expect(v.warnings.some((w) => w.includes('not SHALL-style'))).toBe(false)
    expect(v.warnings.some((w) => w.includes('legacy spec'))).toBe(true)
  })

  test('hand-written AC alongside a delta-model spec → warning only', () => {
    const content = applyDelta(emptySpecContent('auth'), DELTA_FULL, { ts: TS })
    content.acceptance_criteria.push('ship it')
    const v = validateSpec(makeSpec(content))
    expect(v.errors).toEqual([])
    expect(v.warnings.some((w) => w.includes('not SHALL-style'))).toBe(true)
    // Not "legacy" — the delta model is in use.
    expect(v.warnings.some((w) => w.includes('legacy spec'))).toBe(false)
  })

  test('empty spec body ⇒ no findings at all', () => {
    const v = validateSpec(makeSpec(emptySpecContent('x')))
    expect(v.errors).toEqual([])
    expect(v.warnings).toEqual([])
  })
})

describe('validateSpec — scope path resolution (warnings)', () => {
  const fixture: { root: string } = { root: '' }
  beforeEach(async () => {
    fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-validate-scope-'))
    await fs.mkdir(path.join(fixture.root, 'core', 'sync'), { recursive: true })
    await fs.writeFile(path.join(fixture.root, 'core', 'sync', 'sync-manager.ts'), 'export {}\n')
  })
  afterEach(async () => {
    await fs.rm(fixture.root, { recursive: true, force: true })
  })

  test('existing scope paths resolve clean; missing ones warn', () => {
    const content = SpecContentSchema.parse({
      goal: 'x',
      scope: ['core/sync/sync-manager.ts — exists', 'core/sync/nope.ts — missing', 'plain prose'],
    })
    const v = validateSpec(makeSpec(content), { projectPath: fixture.root })
    expect(v.errors).toEqual([])
    expect(v.warnings).toEqual(['scope path does not resolve in the project: core/sync/nope.ts'])
  })

  test('without projectPath, scope checks are skipped', () => {
    const content = SpecContentSchema.parse({ goal: 'x', scope: ['core/sync/nope.ts'] })
    const v = validateSpec(makeSpec(content))
    expect(v.warnings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Command level: strict exit behavior. Fixture mirrors
// spec-audit-dynamic-lenses.test.ts (real project dir + config + DB).
// ---------------------------------------------------------------------------

const fixture: {
  projectPath: string
  projectId: string
  originalProjectsDir: string | undefined
  originalSddMode: string | undefined
  cmd: SpecCommands
} = {
  projectPath: '',
  projectId: '',
  originalProjectsDir: undefined as unknown as string | undefined,
  originalSddMode: undefined as unknown as string | undefined,
  cmd: undefined as unknown as SpecCommands,
}

beforeEach(async () => {
  prjctDb.close()
  const tempProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-validate-pd-'))
  fixture.originalProjectsDir = process.env.PRJCT_PROJECTS_DIR
  process.env.PRJCT_PROJECTS_DIR = tempProjectsDir
  fixture.originalSddMode = process.env.PRJCT_SDD_MODE
  delete process.env.PRJCT_SDD_MODE

  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-validate-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `validate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
  fixture.cmd = new SpecCommands()
})

afterEach(async () => {
  if (fixture.originalProjectsDir === undefined) delete process.env.PRJCT_PROJECTS_DIR
  else process.env.PRJCT_PROJECTS_DIR = fixture.originalProjectsDir
  if (fixture.originalSddMode === undefined) delete process.env.PRJCT_SDD_MODE
  else process.env.PRJCT_SDD_MODE = fixture.originalSddMode
  if (fixture.projectPath)
    await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  // PRJCT_PROJECTS_DIR is not honored by pathManager (mem_1560), so project
  // data lands in ~/.prjct-cli/projects/<id>; clean it to avoid polluting the
  // real projects dir.
  if (fixture.projectId)
    await fs
      .rm(path.join(os.homedir(), '.prjct-cli', 'projects', fixture.projectId), {
        recursive: true,
        force: true,
      })
      .catch(() => {})
  prjctDb.close()
})

async function legacySpec(): Promise<string> {
  const spec = await specService.create(fixture.projectPath, {
    title: 'legacy',
    content: { goal: 'x', acceptance_criteria: ['it works'] },
    autoContext: false,
  })
  return spec.id
}

async function brokenDeltaSpec(): Promise<string> {
  const spec = await specService.create(fixture.projectPath, {
    title: 'broken delta',
    content: { goal: 'x' },
    autoContext: false,
  })
  await specService.applyDelta(fixture.projectPath, spec.id, DELTA_NO_SHALL_NO_SCENARIO)
  return spec.id
}

describe('prjct spec validate — command-level exit behavior', () => {
  test('errors fail in every mode', async () => {
    const id = await brokenDeltaSpec()
    const res = await fixture.cmd.validate(id, fixture.projectPath, {})
    expect(res.success).toBe(false)
  })

  test('warnings alone pass non-strict, fail under --strict', async () => {
    const id = await legacySpec()
    const advisory = await fixture.cmd.validate(id, fixture.projectPath, {})
    expect(advisory.success).toBe(true)
    const strict = await fixture.cmd.validate(id, fixture.projectPath, { strict: true })
    expect(strict.success).toBe(false)
  })

  test('clean spec passes in both modes', async () => {
    const spec = await specService.create(fixture.projectPath, {
      title: 'clean',
      content: { goal: 'x' },
      autoContext: false,
    })
    await specService.applyDelta(fixture.projectPath, spec.id, DELTA_FULL)
    expect((await fixture.cmd.validate(spec.id, fixture.projectPath, {})).success).toBe(true)
    expect(
      (await fixture.cmd.validate(spec.id, fixture.projectPath, { strict: true })).success
    ).toBe(true)
  })

  test('unknown id fails softly', async () => {
    const res = await fixture.cmd.validate('spec_nope', fixture.projectPath, {})
    expect(res.success).toBe(false)
  })
})

describe('prjct spec audit — validation gate before dispatch', () => {
  test('advisory by default: errors print but the dispatch is emitted', async () => {
    const id = await brokenDeltaSpec()
    const res = await fixture.cmd.audit(id, fixture.projectPath, {})
    expect(res.success).toBe(true)
    expect(res.dispatch).toBe('emitted')
  })

  test('--strict blocks the dispatch on errors', async () => {
    const id = await brokenDeltaSpec()
    const res = await fixture.cmd.audit(id, fixture.projectPath, { strict: true })
    expect(res.success).toBe(false)
    expect(res.dispatch).toBeUndefined()
  })

  test('SDD mode=strict blocks the dispatch without the flag', async () => {
    process.env.PRJCT_SDD_MODE = 'strict'
    const id = await brokenDeltaSpec()
    const res = await fixture.cmd.audit(id, fixture.projectPath, {})
    expect(res.success).toBe(false)
    expect(res.dispatch).toBeUndefined()
  })

  test('warnings alone never block, even under --strict', async () => {
    const id = await legacySpec()
    const res = await fixture.cmd.audit(id, fixture.projectPath, { strict: true })
    expect(res.success).toBe(true)
    expect(res.dispatch).toBe('emitted')
  })

  test('clean spec under --strict dispatches with no validation block', async () => {
    const spec = await specService.create(fixture.projectPath, {
      title: 'clean',
      content: { goal: 'x' },
      autoContext: false,
    })
    await specService.applyDelta(fixture.projectPath, spec.id, DELTA_FULL)
    const res = await fixture.cmd.audit(spec.id, fixture.projectPath, { strict: true })
    expect(res.success).toBe(true)
    expect(res.dispatch).toBe('emitted')
  })
})
