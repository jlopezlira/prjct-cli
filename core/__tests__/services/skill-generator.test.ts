/**
 * Tests for the single anti-harness skill generator (alpha.11).
 *
 * v1 shipped 4 prescriptive skills (prjct-context, prjct-task,
 * prjct-ship, prjct-workflow) that told Claude WHAT to do step by
 * step. Alpha.11 collapses them into one `prjct` skill whose body
 * follows the canonical Anthropic shape: Use when / What's here /
 * Gotchas. Tests validate shape, not prescription.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  SKILL_DEFINITIONS,
  SkillGenerator,
  skillBodyHasProjectStamp,
} from '../../services/skill-generator'
import { countTokens } from '../../tools/context/token-counter'

describe('GLOBAL_CLAUDE_MD_CONTENT (command-installer)', () => {
  it('does not contain authoritarian instructions or dead references', async () => {
    const src = await fs.readFile(
      path.join(__dirname, '../../infrastructure/command-installer.ts'),
      'utf-8'
    )
    expect(src).not.toContain('MANDATORY')
    expect(src).not.toContain('NEVER end a session')
    expect(src).not.toContain('Context7 MCP is mandatory')
    expect(src).not.toContain('Templates are MANDATORY')
  })
})

describe('SkillGenerator (alpha.11 single skill)', () => {
  const fixture: {
    generator: SkillGenerator
    originalHome: string
    tmpHome: string
  } = {
    generator: undefined as unknown as SkillGenerator,
    originalHome: '',
    tmpHome: '',
  }

  beforeEach(async () => {
    fixture.generator = new SkillGenerator()
    fixture.originalHome = os.homedir()
    fixture.tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-gen-test-'))
    process.env.HOME = fixture.tmpHome
  })

  afterEach(async () => {
    process.env.HOME = fixture.originalHome
    await fs.rm(fixture.tmpHome, { recursive: true, force: true }).catch(() => {})
  })

  describe('definitions', () => {
    it('ships a single `prjct` skill', () => {
      expect(SKILL_DEFINITIONS).toHaveLength(1)
      expect(SKILL_DEFINITIONS[0].name).toBe('prjct')
    })

    it('is user-invocable', () => {
      expect(SKILL_DEFINITIONS[0].userInvocable ?? true).toBe(true)
    })
  })

  describe('generateAndInstall', () => {
    it('generates the `prjct` skill (Claude full + compact fan-out)', async () => {
      const result = await fixture.generator.generateAndInstall()
      expect(result.generated.some((g) => g.name === 'prjct')).toBe(true)
      expect(result.generated.some((g) => g.path.includes('.claude/skills/prjct'))).toBe(true)
      expect(result.skipped).toHaveLength(0)
    })

    it('writes SKILL.md at the expected path', async () => {
      const result = await fixture.generator.generateAndInstall()
      const skill = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      expect(skill).toBeDefined()
      expect(skill!.path).toContain('.claude/skills/')
      expect(skill!.path).toEndWith('/SKILL.md')
      const exists = await fs
        .access(skill!.path)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)
    })

    async function readClaudeSkill(): Promise<string> {
      const result = await fixture.generator.generateAndInstall()
      const claude = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      expect(claude).toBeDefined()
      return fs.readFile(claude!.path, 'utf-8')
    }

    it('skill body includes the canonical anti-harness sections', async () => {
      const content = await readClaudeSkill()
      expect(content).toContain('## Use when')
      expect(content).toContain("## What's here")
      expect(content).toContain('### Agent contract')
      expect(content).toContain('## Gotchas')
    })

    it('surfaces the opt-in tdd + sdd verbs in the always-loaded body', async () => {
      // L0 only lists the verbs (token budget). Methodology (test-first /
      // intent-first intensity) lives in the pulled workflows.md reference.
      const result = await fixture.generator.generateAndInstall()
      const claude = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      const content = await fs.readFile(claude!.path, 'utf-8')
      const ref = await fs.readFile(path.join(path.dirname(claude!.path), 'workflows.md'), 'utf-8')

      expect(content).toContain('`prjct tdd`')
      expect(content).toMatch(/tdd\/sdd|`sdd`/)
      expect(content).not.toMatch(/test-first|intent-first/)

      expect(ref).toMatch(/test-first|TDD/)
      expect(ref).toContain('`prjct tdd`')
      expect(ref).toContain('`prjct sdd`')
      expect(ref).toMatch(/intent-first|SDD/)
    })

    it('teaches the sovereign knowledge base so agents pull it, never inject it', async () => {
      const content = await readClaudeSkill()
      // KB facets are first-class, capturable, and discoverable to any rig.
      for (const facet of ['identity', 'voice', 'glossary', 'framework']) {
        expect(content).toContain(facet)
      }
      expect(content).toContain('sovereign knowledge base')
      expect(content).toContain('prjct context memory <facet>')
      // Clean-repo doctrine surfaced in the skill itself.
      expect(content).toContain('never injected into CLAUDE.md / AGENTS.md')
    })

    it('frames work as task-cycle entrypoint and forbids bin-verb work-wrap', async () => {
      // Lean L0: work for tasks only; known CLI verbs run bare. Spec/test-first
      // pipeline detail stays in workflows.md (not always-on prose).
      const content = await readClaudeSkill()
      expect(content).toContain('`prjct work` is the normal entrypoint **for task cycles only**')
      expect(content).toContain('Never** wrap a bin verb')
      expect(content).toContain('schema v1 JSON')
      expect(content).toContain('Full map in `workflows.md`')
      expect(content).not.toContain('**NO spec, NO audit-spec, NO subagents, NO fan-out.**')
      expect(content).not.toContain('Trivial work proceeds directly')
    })

    it('keeps loop-discipline triggers + model quick-ref in the pulled reference', async () => {
      const result = await fixture.generator.generateAndInstall()
      const claude = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      const content = await fs.readFile(claude!.path, 'utf-8')
      const dir = path.dirname(claude!.path)
      const ref = await fs.readFile(path.join(dir, 'workflows.md'), 'utf-8')

      expect(content).toContain('workflows.md')
      expect(content).not.toContain('## Loop discipline')
      expect(content).not.toContain('Reading **4+ files**')
      expect(content).not.toContain('Touching **2+ non-trivial files**')

      // Stop/delegate triggers remain available, but only when workflows.md
      // is intentionally pulled for quality workflows.
      expect(ref).toContain('## Loop discipline')
      expect(ref).toContain('Reading **4+ files**')
      expect(ref).toContain('Touching **2+ non-trivial files**')
      expect(ref).toContain('commit / push / open a PR')
      expect(ref).toContain('worktree/git accident')
      expect(ref).toContain('`model: "sonnet"`')
      expect(ref).toMatch(/capability class|host vocabulary|Claude Code/i)
    })

    it('states the portable agent contract for Claude and GPT', async () => {
      const content = await readClaudeSkill()
      expect(content).toContain('prjct remembers project state and shows the path')
      expect(content).toContain('Agents decide HOW with native tools and judgment')
      expect(content).toContain('Treat prjct output as durable signals')
    })

    it('exposes v3 primitives (work, intent, remember, context, workflow, seed)', async () => {
      // Compact core table: paired verbs use `/ \`seed\`` shorthand (not
      // the full `prjct seed` string) to stay inside the L0 token budget.
      const content = await readClaudeSkill()
      expect(content).toContain('prjct work')
      expect(content).toContain('prjct intent')
      expect(content).toContain('prjct remember')
      expect(content).toContain('prjct context memory')
      expect(content).toContain('prjct workflow')
      expect(content).toMatch(/`prjct workflow`\s*\/\s*`seed`/)
    })

    it('points knowledge access at tools, not the vault', async () => {
      const content = await readClaudeSkill()
      // Vault retired as a default read surface — the skill routes to tools.
      expect(content).not.toContain('.prjct/wiki/_generated/')
      expect(content).toContain('prjct context memory')
      expect(content).toContain('.prjct/prjct.config.json')
    })

    it('is project-agnostic — never embeds project name/stack/branch (multi-project isolation)', async () => {
      const result = await fixture.generator.generateAndInstall()
      const claude = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      expect(claude).toBeDefined()
      const content = await fs.readFile(claude!.path, 'utf-8')
      expect(content).not.toContain('my-app')
      expect(content).not.toContain('feat/alpha11')
      expect(content).not.toMatch(/^\s*# my-app/m)
      expect(content).toMatch(/portable|cwd-scoped/i)
      expect(content).toContain('Skill ≠ project identity')
    })

    it('frontmatter has valid Claude Code native format', async () => {
      const result = await fixture.generator.generateAndInstall()
      const claude = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      const content = await fs.readFile(claude!.path, 'utf-8')
      expect(content).toStartWith('---\n')
      expect(content).toContain('description:')
      expect(content).toContain('allowed-tools:')
      // Second --- closes frontmatter
      const secondDash = content.indexOf('---', 4)
      expect(secondDash).toBeGreaterThan(0)
    })

    it('multi-project sync isolation: repeated install never stamps project names into L0', async () => {
      await fixture.generator.generateAndInstall()
      await fixture.generator.generateAndInstall()
      const skillPath = path.join(fixture.tmpHome, '.claude', 'skills', 'prjct', 'SKILL.md')
      const content = await fs.readFile(skillPath, 'utf-8')
      expect(content).not.toContain('project-alpha')
      expect(content).not.toContain('## Recent Deliveries')
      expect(skillBodyHasProjectStamp(content)).toBe(false)
    })

    it('fans out compact portable skill to Codex/Gemini host dirs', async () => {
      const result = await fixture.generator.generateAndInstall()
      const compactPaths = result.generated
        .filter((g) => g.name === 'prjct-compact')
        .map((g) => g.path)
      expect(compactPaths.length).toBeGreaterThanOrEqual(1)
      expect(compactPaths.some((p) => p.includes('.codex/skills'))).toBe(true)
      const sample = await fs.readFile(compactPaths[0], 'utf-8')
      expect(sample).toContain('RAG-backed')
      expect(sample).toMatch(/portable|context --md/i)
      expect(sample).not.toContain('my-app')
    })

    it('fans out the compact skill to the shared ~/.agents/skills tier (Kimi Code CLI)', async () => {
      const result = await fixture.generator.generateAndInstall()
      const kimiPath = result.generated.find(
        (g) => g.name === 'prjct-compact' && g.path.includes('.agents/skills/prjct/SKILL.md')
      )
      expect(kimiPath).toBeDefined()
      const content = await fs.readFile(kimiPath!.path, 'utf-8')
      // Kimi requires name + description frontmatter on directory-form skills.
      expect(content).toContain('name: prjct')
      expect(content).toContain('description:')
      expect(content).toContain('RAG-backed')
    })
  })

  describe('rich context isolation (never in L0)', () => {
    it('never embeds rich project sections in global skill', async () => {
      const result = await fixture.generator.generateAndInstall()
      const claude = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      const content = await fs.readFile(claude!.path, 'utf-8')
      expect(content).not.toContain('Storage Layer Abstraction')
      expect(content).not.toContain('## Patterns')
      expect(content).not.toContain('## Velocity')
      expect(content).not.toContain('## Recent Deliveries')
      expect(content).not.toContain('Wire alpha.11 hooks')
    })

    it('omits rich sections when empty (and when rich is provided)', async () => {
      const result = await fixture.generator.generateAndInstall()
      const claude = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      const content = await fs.readFile(claude!.path, 'utf-8')
      expect(content).not.toContain('## Patterns')
      expect(content).not.toContain('## Anti-Patterns')
      expect(content).not.toContain('## Velocity')
    })
  })

  describe('anti-harness enforcement', () => {
    async function readClaude(): Promise<string> {
      const result = await fixture.generator.generateAndInstall()
      const claude = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      return fs.readFile(claude!.path, 'utf-8')
    }

    it('contains no numbered "do X then Y" steps', async () => {
      const content = await readClaude()
      // No "1. ", "2. ", "3. " in the body (outside the frontmatter /
      // data blocks). Keep the check conservative — just look for the
      // numbered-step pattern with a verb that suggests prescription.
      expect(content).not.toMatch(/^\s*1\.\s+Register\b/m)
      expect(content).not.toMatch(/^\s*2\.\s+Tag\b/m)
      expect(content).not.toMatch(/^\s*###\s*1\.\s/m)
    })

    it('contains no BLOCKING / MANDATORY directives', async () => {
      const content = await readClaude()
      expect(content).not.toContain('BLOCKING')
      expect(content).not.toContain('MANDATORY')
      expect(content).not.toContain('## Constraints')
    })

    it('contains no "Pre-flight" ceremony', async () => {
      const content = await readClaude()
      expect(content).not.toContain('Pre-flight')
    })
  })

  // Context-efficiency pivot (2.37): the heavy methodology (subagent
  // dispatch, audit orchestrator, decision-brief, builder ethos, quality
  // workflows) moved OUT of the always-in-context SKILL.md body into the
  // pulled-on-demand `workflows.md` reference written next to it. These
  // tests assert it ships on disk in the reference, and that the lean
  // SKILL.md points to it without inlining it.
  describe('deep-methodology reference (workflows.md)', () => {
    async function readReference(): Promise<string> {
      const result = await fixture.generator.generateAndInstall()
      const claude = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      const dir = path.dirname(claude!.path)
      return fs.readFile(path.join(dir, 'workflows.md'), 'utf-8')
    }

    it('writes workflows.md next to SKILL.md', async () => {
      const result = await fixture.generator.generateAndInstall()
      const claude = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      const dir = path.dirname(claude!.path)
      const exists = await fs
        .access(path.join(dir, 'workflows.md'))
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)
    })

    it('keeps SKILL.md lean — points at the reference, does not inline it', async () => {
      const result = await fixture.generator.generateAndInstall()
      const claude = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      const content = await fs.readFile(claude!.path, 'utf-8')
      expect(content).toContain('workflows.md')
      // Heavy methodology must NOT sit in the always-in-context body.
      expect(content).not.toContain('### Subagent dispatch')
      expect(content).not.toContain('## Quality workflows')
      expect(content).not.toContain('## Builder ethos')
    })

    it('keeps the always-loaded SKILL.md under the token budget', async () => {
      const result = await fixture.generator.generateAndInstall()
      const claude = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      const content = await fs.readFile(claude!.path, 'utf-8')
      // ≤1500 tok always-on. Full verb map + methodology live in workflows.md.
      expect(countTokens(content)).toBeLessThanOrEqual(1500)
    })

    it('declares the subagent dispatch section with general-purpose type', async () => {
      const ref = await readReference()
      expect(ref).toContain('### Subagent dispatch')
      expect(ref).toContain('subagent_type: "general-purpose"')
      expect(ref).toContain('context-rot defense')
    })

    it('instructs review/security/investigate to dispatch as subagents', async () => {
      const ref = await readReference()
      const reviewSection = ref.split('### `review`')[1]?.split('### `qa`')[0] ?? ''
      expect(reviewSection).toContain('Dispatch as subagent')
      const securitySection = ref.split('### `security`')[1]?.split('### `investigate`')[0] ?? ''
      expect(securitySection).toContain('Dispatch as subagent')
      const investigateSection = ref.split('### `investigate`')[1]?.split('### `ship`')[0] ?? ''
      expect(investigateSection).toContain('Dispatch the trace+hypothesis phase as a subagent')
    })

    it('exposes the audit orchestrator with parallel dispatch instructions', async () => {
      const ref = await readReference()
      expect(ref).toContain('### `audit`')
      expect(ref).toContain('IN PARALLEL')
      expect(ref).toMatch(/Subagent A.*review/)
      expect(ref).toMatch(/Subagent B.*security/)
      expect(ref).toMatch(/Subagent C.*investigate/)
    })

    it('scopes heavy-review subagent dispatch to diff size — in the pulled reference, not the always-on description', async () => {
      // The always-on skill description is a lean trigger; the subagent-
      // dispatch scoping rule (don't over-dispatch on small diffs) lives in
      // workflows.md, pulled only when a heavy workflow actually runs.
      const ref = await readReference()
      expect(ref).toMatch(/dispatch the read-and-analyze step as a subagent/i)
      expect(ref).toContain('Skip the subagent only for: diffs under 5 files')
    })

    it('teaches the decision-brief format for non-trivial AskUserQuestion calls', async () => {
      const ref = await readReference()
      expect(ref).toContain('### Decision-brief format')
      expect(ref).toContain('ELI10:')
      expect(ref).toContain('Stakes if we pick wrong')
      expect(ref).toContain('Recommendation:')
    })

    it('embeds the three builder-ethos principles before quality workflows', async () => {
      const ref = await readReference()
      expect(ref).toContain('## Builder ethos')
      expect(ref).toContain('### Boil the Lake')
      expect(ref).toContain('### Search before building')
      expect(ref).toContain('### User sovereignty')
      const ethosIdx = ref.indexOf('## Builder ethos')
      const qualityIdx = ref.indexOf('## Quality workflows')
      expect(ethosIdx).toBeGreaterThan(0)
      expect(qualityIdx).toBeGreaterThan(ethosIdx)
    })

    it('includes user-sovereignty anti-patterns the model must refuse', async () => {
      const ref = await readReference()
      expect(ref).toMatch(/outside voice is right.*Present it\. Ask\./)
      expect(ref).toContain('Agreement is signal, not proof')
    })
  })

  // Verb intent map — always-on carries a CORE table; full map in workflows.md.
  describe('verb intent map (UX phase 1)', () => {
    async function claudeSkillAndRef(): Promise<{ content: string; ref: string }> {
      const result = await fixture.generator.generateAndInstall()
      const claude = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      const content = await fs.readFile(claude!.path, 'utf-8')
      const ref = await fs.readFile(path.join(path.dirname(claude!.path), 'workflows.md'), 'utf-8')
      return { content, ref }
    }

    it('declares a compact core verb table always-on + full map in reference', async () => {
      const { content, ref } = await claudeSkillAndRef()
      expect(content).toContain('### Core verbs')
      expect(content).toMatch(/you run the verb|never types/)
      expect(content).toContain('| Signal | Verb | T |')
      expect(content).toContain('`prjct work` is the normal entrypoint **for task cycles only**')
      expect(content).toContain('`prjct work')
      expect(content).toContain('`prjct search')
      expect(content).toContain('`prjct ship`')
      expect(content).toContain('`prjct sync`')
      // Full map (insights variants, context-save, etc.) lives in reference.
      expect(ref).toContain('## Full verb intent map')
      expect(ref).toContain('`prjct insights value --md`')
      expect(ref).toContain('`prjct insights reliability --md`')
      expect(ref).toContain('`prjct insights report 7 --md`')
      expect(ref).toContain('`prjct performance 7 --md`')
      expect(ref).toContain('`prjct context-save`')
      expect(ref).toContain('`prjct remember decision')
    })

    it('explicitly tells the model NOT to make the user type commands', async () => {
      const { content } = await claudeSkillAndRef()
      expect(content).toMatch(/never types|run the verb/i)
      // Skill description carries the same contract.
      const description = content.split('description:')[1]?.split('\n')[0] ?? ''
      expect(description).toMatch(/run the prjct verb yourself/i)
    })

    it('teaches living context synthesis via pull reference (not always-on dump)', async () => {
      const { content, ref } = await claudeSkillAndRef()
      expect(content).toMatch(/living context|Session close/i)
      expect(ref).toContain('Living context synthesis')
      expect(ref).toContain('same model that just executed the task')
      expect(ref).toContain('Context synthesis')
      expect(ref).toContain('Key data')
      expect(ref).toContain('What happened')
      expect(ref).toContain('Why it mattered')
      expect(ref).toContain('Who/author')
      expect(ref).toContain('Token usage')
      expect(ref).toContain('Next implication')
      expect(ref).toContain('Raw detector output is input, not the final context')
    })
  })

  // Routing protocol — three tiers based on blast radius (condensed from
  // the old per-tier sections into a tight list in the lean body).
  describe('routing protocol (UX phase 2)', () => {
    async function claudeBody(): Promise<string> {
      const result = await fixture.generator.generateAndInstall()
      const claude = result.generated.find((g) => g.path.includes('.claude/skills/prjct/SKILL.md'))
      return fs.readFile(claude!.path, 'utf-8')
    }

    it('declares the three-tier routing protocol by blast radius', async () => {
      const content = await claudeBody()
      expect(content).toContain('### Routing')
      expect(content).toContain('Tier 1 — auto-execute')
      expect(content).toContain('Tier 2 — confirm')
      expect(content).toContain('Tier 3 — decision-brief')
    })

    it('groups memory / guard / insights / performance into Tier 1', async () => {
      const content = await claudeBody()
      const tier1 = content.split('Tier 1 — auto-execute')[1]?.split('Tier 2 —')[0] ?? ''
      expect(tier1).toContain('search')
      expect(tier1).toContain('remember')
      expect(tier1).toContain('guard')
      expect(tier1).toContain('insights')
      expect(tier1).toContain('performance')
    })

    it('groups work / intent / ship into Tier 2 (confirm once)', async () => {
      const content = await claudeBody()
      const tier2 = content.split('Tier 2 — confirm')[1]?.split('Tier 3 —')[0] ?? ''
      expect(tier2).toContain('work')
      expect(tier2).toContain('intent')
      expect(tier2).toContain('ship')
    })

    it('refuses pausing on routine captures and shipping without user OK', async () => {
      const content = await claudeBody()
      expect(content).toMatch(/do not ask permission to save|auto-execute/i)
      expect(content).toMatch(/Never ship without user OK/)
    })
  })
})
