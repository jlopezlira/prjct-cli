import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  formatModelOnlyGuidance,
  materializeEmbeddedPrivateSkillPath,
  outputProfileFor,
  PRIVATE_SKILL_ASSET_ROOT,
  PRIVATE_SKILL_MANIFEST,
  resolvePrivateSkillPath,
  routePrivateSkills,
  tddRoutingMode,
} from '../../services/private-skill-router'

const temporary: string[] = []

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('private engineering skill router', () => {
  it('defaults to no route and caps selection at one workflow plus one reference', () => {
    expect(routePrivateSkills({ intent: 'rename a local variable' })).toEqual({})

    const routed = routePrivateSkills({
      intent: 'Diagnose a flaky regression while refactoring AGENTS.md domain invariants',
      harness: { level: 'H2', kind: 'refactor' },
      tddMode: 'strict',
    })
    expect(routed.workflow?.id).toBe('diagnosing-bugs')
    expect(routed.reference?.id).toBe('writing-for-agents')
    expect(Object.keys(routed).sort()).toEqual(['reference', 'workflow'])
  })

  it('uses state-first workflow precedence and enables TDD only for behavior-changing code', () => {
    expect(
      routePrivateSkills({
        intent: 'Diagnose a timeout while resolving the branch',
        hasMergeConflicts: true,
        harness: { level: 'H2', kind: 'bug' },
        tddMode: 'strict',
      }).workflow?.id
    ).toBe('resolving-merge-conflicts')
    expect(
      routePrivateSkills({
        intent: 'Fix a timeout regression in behavior',
        harness: { level: 'H1', kind: 'bug' },
        tddMode: 'strict',
      }).workflow?.id
    ).toBe('diagnosing-bugs')
    expect(
      routePrivateSkills({
        intent: 'Fix the save button',
        harness: { level: 'H1', kind: 'bug' },
        tddMode: 'off',
      }).workflow?.id
    ).toBe('diagnosing-bugs')
    expect(
      routePrivateSkills({
        intent: 'Add account behavior',
        harness: { level: 'H2', kind: 'feature' },
        tddMode: 'assist',
      }).workflow?.id
    ).toBe('tdd')
    expect(
      routePrivateSkills({
        intent: 'Add account behavior',
        harness: { level: 'H2', kind: 'feature' },
      }).workflow?.id
    ).toBe('tdd')
    expect(
      routePrivateSkills({
        intent: 'Add account behavior',
        harness: { level: 'H2', kind: 'feature' },
        tddMode: 'off',
      }).workflow
    ).toBeUndefined()
    expect(
      routePrivateSkills({ intent: 'Review the branch diff', tddMode: 'strict' }).workflow?.id
    ).toBe('code-review')
    expect(
      routePrivateSkills({ intent: 'Review existing tests', tddMode: 'strict' }).workflow
    ).toBe(undefined)
    const spanish = routePrivateSkills({ intent: 'Diagnosticar una regresión intermitente' })
    expect(spanish.workflow?.id).toBe('diagnosing-bugs')
    expect(outputProfileFor({ intent: 'Diagnosticar una regresión intermitente' })).toBe('standard')
    expect(routePrivateSkills({ intent: 'Produce an RCA for this failure' }).workflow?.id).toBe(
      'diagnosing-bugs'
    )
    expect(
      routePrivateSkills({ intent: 'Haz un análisis de causa raíz de este fallo' }).workflow?.id
    ).toBe('diagnosing-bugs')
  })

  it('routes review, conflict resolution, and primary-source research in English and Spanish', () => {
    expect(
      routePrivateSkills({ intent: 'Review this pull request against the spec' }).workflow?.id
    ).toBe('code-review')
    expect(routePrivateSkills({ intent: 'Review the auth changes' }).workflow?.id).toBe(
      'code-review'
    )
    expect(
      routePrivateSkills({ intent: 'Revisar este diff contra la especificación' }).workflow?.id
    ).toBe('code-review')
    expect(
      routePrivateSkills({ intent: 'Address the review feedback', purpose: 'review' }).workflow
    ).toBeUndefined()
    expect(outputProfileFor({ intent: 'Address the review feedback', purpose: 'review' })).toBe(
      'standard'
    )
    expect(routePrivateSkills({ intent: 'Resolve the rebase conflicts' }).workflow?.id).toBe(
      'resolving-merge-conflicts'
    )
    expect(routePrivateSkills({ intent: 'Resolver conflictos de fusión' }).workflow?.id).toBe(
      'resolving-merge-conflicts'
    )
    expect(
      routePrivateSkills({ intent: 'Look up the official API documentation' }).workflow?.id
    ).toBe('research')
    expect(
      routePrivateSkills({ intent: 'Research the framework compatibility' }).workflow?.id
    ).toBe('research')
    expect(routePrivateSkills({ intent: 'Buscar en la documentación oficial' }).workflow?.id).toBe(
      'research'
    )
    expect(
      routePrivateSkills({ intent: 'answer the question', needsExternalResearch: true }).workflow
        ?.id
    ).toBe('research')
    expect(routePrivateSkills({ intent: 'Fix the auth token refresh bug' }).workflow?.id).toBe(
      'diagnosing-bugs'
    )
  })

  it('uses reference precedence: agent writing, comments, domain modeling, codebase design', () => {
    expect(
      routePrivateSkills({ intent: 'Edit AGENTS.md for a domain invariant architecture' }).reference
        ?.id
    ).toBe('writing-for-agents')
    expect(
      routePrivateSkills({ intent: 'Refactor the architecture', changedCommentLines: 3 }).reference
        ?.id
    ).toBe('comment-discipline')
    expect(routePrivateSkills({ intent: 'Remove verbose code comments' }).reference?.id).toBe(
      'comment-discipline'
    )
    expect(routePrivateSkills({ intent: 'Limpiar comentarios verbosos' }).reference?.id).toBe(
      'comment-discipline'
    )
    expect(
      routePrivateSkills({ intent: 'Define a domain invariant at an architecture seam' }).reference
        ?.id
    ).toBe('domain-modeling')
    expect(routePrivateSkills({ intent: 'Refactor the architecture seam' }).reference?.id).toBe(
      'codebase-design'
    )
    expect(
      routePrivateSkills({ intent: 'Editar las instrucciones para agentes' }).reference?.id
    ).toBe('writing-for-agents')
    expect(
      routePrivateSkills({ intent: 'Definir un invariante del modelo de dominio' }).reference?.id
    ).toBe('domain-modeling')
    expect(
      routePrivateSkills({ intent: 'Refactorizar la arquitectura de la interfaz' }).reference?.id
    ).toBe('codebase-design')
  })

  it('selects compact, standard, and expanded profiles with explicit-detail precedence', () => {
    expect(outputProfileFor({ intent: 'routine status', purpose: 'status' })).toBe('compact')
    expect(
      outputProfileFor({ intent: 'implement feature', harness: { level: 'H2', kind: 'feature' } })
    ).toBe('standard')
    expect(outputProfileFor({ intent: 'give a detailed status', purpose: 'status' })).toBe(
      'expanded'
    )
    expect(outputProfileFor({ intent: 'Dame una explicación detallada y a fondo' })).toBe(
      'expanded'
    )
    expect(
      outputProfileFor({
        intent: 'Implement the cross-project change; keep it concise',
        harness: { level: 'H2', kind: 'feature' },
      })
    ).toBe('compact')
    expect(
      outputProfileFor({
        intent: 'Implementa el cambio; sé breve',
        harness: { level: 'H2', kind: 'feature' },
      })
    ).toBe('compact')
    expect(outputProfileFor({ intent: 'Give a detailed but concise full report' })).toBe('expanded')
    expect(outputProfileFor({ intent: 'Analyze the repository in detail' })).toBe('expanded')
    expect(outputProfileFor({ intent: 'Analiza a detalle este repositorio' })).toBe('expanded')
    expect(outputProfileFor({ intent: 'Revísalo detalladamente' })).toBe('expanded')
  })

  it('does not mistake semantic full/detail words for an expanded-output request', () => {
    expect(outputProfileFor({ intent: 'Implement full-text search' })).not.toBe('expanded')
    expect(outputProfileFor({ intent: 'Fix this implementation detail' })).not.toBe('expanded')
    expect(outputProfileFor({ intent: 'Implement a detailed logging view' })).not.toBe('expanded')
    expect(outputProfileFor({ intent: 'Use a fully qualified class name' })).not.toBe('expanded')
    expect(outputProfileFor({ intent: 'Write a fully qualified class name' })).not.toBe('expanded')
    expect(outputProfileFor({ intent: 'Documenta la clase completamente tipada' })).not.toBe(
      'expanded'
    )
  })

  it('preserves explicit TDD config/env and distinguishes absence for auto-assist', () => {
    expect(tddRoutingMode(undefined, undefined)).toBeUndefined()
    expect(tddRoutingMode(undefined, 'off')).toBe('off')
    expect(tddRoutingMode(undefined, 'assist')).toBe('assist')
    expect(tddRoutingMode('strict', 'off')).toBe('strict')
    expect(tddRoutingMode(undefined, 'bogus')).toBe('off')
  })

  it('emits exact package paths and soft, non-truncating output guidance', () => {
    const route = routePrivateSkills({ intent: 'Refactor an interface' })
    const text = formatModelOnlyGuidance(route, 'standard')
    expect(text).toContain(route.reference?.path ?? 'missing')
    expect(text).toContain('soft target: 300 words')
    expect(text).toContain('Preserve errors')
  })
})

describe('private engineering asset boundary', () => {
  it('materializes embedded assets for sidecar-free standalone binaries', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-embedded-skills-'))
    temporary.push(fixture)
    const materialized = materializeEmbeddedPrivateSkillPath('tdd.md', fixture)
    expect(materialized.startsWith(fs.realpathSync(fixture))).toBe(true)
    expect(fs.readFileSync(materialized, 'utf8')).toBe(
      fs.readFileSync(path.join(PRIVATE_SKILL_ASSET_ROOT, 'tdd.md'), 'utf8')
    )
    expect(() => materializeEmbeddedPrivateSkillPath('../escape.md', fixture)).toThrow()
  })

  it('ships every immutable manifest asset under the canonical package root', () => {
    expect(Object.isFrozen(PRIVATE_SKILL_MANIFEST)).toBe(true)
    for (const entry of Object.values(PRIVATE_SKILL_MANIFEST)) {
      expect(Object.isFrozen(entry)).toBe(true)
      const resolved = resolvePrivateSkillPath(entry.file)
      expect(
        resolved.startsWith(`${fs.realpathSync.native(PRIVATE_SKILL_ASSET_ROOT)}${path.sep}`)
      ).toBe(true)
      expect(fs.readFileSync(resolved, 'utf8').length).toBeGreaterThan(80)
    }
  })

  it('rejects absolute paths, traversal, missing assets, and escaping symlinks', () => {
    expect(() => resolvePrivateSkillPath('/etc/passwd')).toThrow('relative path')
    expect(() => resolvePrivateSkillPath('../NOTICE')).toThrow('escapes')
    expect(() => resolvePrivateSkillPath('not-present.md')).toThrow('missing')

    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-private-skills-'))
    temporary.push(fixture)
    const root = path.join(fixture, 'root')
    const outside = path.join(fixture, 'outside.md')
    fs.mkdirSync(root)
    fs.writeFileSync(outside, 'outside')
    fs.symlinkSync(outside, path.join(root, 'escape.md'))
    expect(() => resolvePrivateSkillPath('escape.md', root)).toThrow('escapes')
  })

  it('contains no network, secret, or native-skill installation behavior', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'core/services/private-skill-router.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/fetch\(|https?:|secret/i)
    expect(source.match(/process\.env\.[A-Z0-9_]+/g)).toEqual(['process.env.PRJCT_TDD_MODE'])
    expect(fs.existsSync(path.join(process.cwd(), 'templates/skills/diagnosing-bugs'))).toBe(false)
  })

  it('includes private assets and the complete upstream MIT notice in package output', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      files: string[]
    }
    expect(pkg.files).toContain('assets/')
    expect(pkg.files).toContain('NOTICE')
    const notice = fs.readFileSync(path.join(process.cwd(), 'NOTICE'), 'utf8')
    expect(notice).toContain('Copyright (c) 2026 Matt Pocock')
    expect(notice).toContain('Permission is hereby granted, free of charge')
    expect(notice).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
    expect(notice).toContain('0ab1b63')
  })
})
