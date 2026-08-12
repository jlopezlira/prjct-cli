/**
 * Context cache tiers L0–L3 contract.
 */

import { describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildContextTiersReport,
  CONTEXT_TIERS,
  contextTiersOneLiner,
  formatContextTiersMd,
  L0_ROUTING_BYTES_MAX,
  L0_SKILL_TOKENS_MAX,
  measureL0Budget,
  measurePrjctMdBudget,
  PRJCT_MD_BODY_BYTES_MAX,
} from '../../services/context-tiers'
import { WORLD_CLASS } from '../../services/harness-score'

describe('CONTEXT_TIERS', () => {
  it('defines exactly L0–L3', () => {
    expect(CONTEXT_TIERS.map((t) => t.id)).toEqual(['L0', 'L1', 'L2', 'L3'])
  })

  it('each tier has load, contents, pull, antiPattern', () => {
    for (const t of CONTEXT_TIERS) {
      expect(t.load.length).toBeGreaterThan(5)
      expect(t.contents.length).toBeGreaterThan(0)
      expect(t.pull.length).toBeGreaterThan(5)
      expect(t.antiPattern.length).toBeGreaterThan(10)
    }
  })
})

describe('measureL0Budget', () => {
  it('is within WORLD_CLASS SLOs (lockstep constants)', () => {
    expect(L0_SKILL_TOKENS_MAX).toBe(WORLD_CLASS.skillTokensMax)
    expect(L0_ROUTING_BYTES_MAX).toBe(WORLD_CLASS.routingBodyBytesMax)
    const m = measureL0Budget()
    expect(m.ok).toBe(true)
    expect(m.skillTokens).toBeLessThanOrEqual(L0_SKILL_TOKENS_MAX)
    expect(m.routingBytes).toBeLessThanOrEqual(L0_ROUTING_BYTES_MAX)
  })
})

describe('measurePrjctMdBudget', () => {
  it('stays within budget for a normal repo (no package.json)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-md-budget-'))
    try {
      const m = await measurePrjctMdBudget(dir)
      expect(m.max).toBe(PRJCT_MD_BODY_BYTES_MAX)
      expect(m.ok).toBe(true)
      expect(m.bytes).toBeLessThanOrEqual(PRJCT_MD_BODY_BYTES_MAX)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('holds under a polyglot fixture — every ecosystem present at once, deduped by kind', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-md-budget-polyglot-'))
    try {
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'kitchen-sink',
          scripts: {
            typecheck: 'tsc --noEmit -p tsconfig.very.long.custom.path.for.this.monorepo.json',
            lint: 'eslint . --ext .ts,.tsx,.js,.jsx --max-warnings=0 --cache --report-unused-disable-directives',
            test: 'jest --coverage --maxWorkers=50% --runInBand --detectOpenHandles --forceExit',
            build:
              'webpack --config webpack.config.production.very.long.js --mode production --profile',
            dev: 'concurrently "next dev" "nodemon server.js" "docker compose up" --names next,api,db',
            format: 'prettier --write . --config .prettierrc.very.long.custom.config.json --cache',
          },
        })
      )
      await fs.writeFile(path.join(dir, 'Cargo.toml'), '[package]\nname = "fixture"\n')
      await fs.writeFile(path.join(dir, 'go.mod'), 'module fixture\n\ngo 1.22\n')
      await fs.writeFile(
        path.join(dir, 'pyproject.toml'),
        '[project]\nname = "fixture"\n\n[tool.pytest.ini_options]\n\n[tool.ruff]\n\n[tool.black]\n\n[tool.mypy]\n'
      )
      const m = await measurePrjctMdBudget(dir)
      expect(m.ok).toBe(true)
      expect(m.bytes).toBeLessThanOrEqual(PRJCT_MD_BODY_BYTES_MAX)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('holds under a pathological fixture — many scripts, long commands', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-md-budget-patho-'))
    try {
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'pathological-fixture',
          scripts: {
            typecheck: 'tsc --noEmit -p tsconfig.very.long.custom.path.for.this.monorepo.json',
            lint: 'eslint . --ext .ts,.tsx,.js,.jsx --max-warnings=0 --cache --report-unused-disable-directives',
            test: 'jest --coverage --maxWorkers=50% --runInBand --detectOpenHandles --forceExit',
            build:
              'webpack --config webpack.config.production.very.long.js --mode production --profile',
            dev: 'concurrently "next dev" "nodemon server.js" "docker compose up" --names next,api,db',
            format: 'prettier --write . --config .prettierrc.very.long.custom.config.json --cache',
          },
        })
      )
      const m = await measurePrjctMdBudget(dir)
      expect(m.ok).toBe(true)
      expect(m.bytes).toBeLessThanOrEqual(PRJCT_MD_BODY_BYTES_MAX)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe('formatContextTiersMd', () => {
  it('renders table + L0 budget + anti-patterns', () => {
    const md = formatContextTiersMd(buildContextTiersReport())
    expect(md).toContain('# prjct context cache tiers')
    expect(md).toContain('**L0**')
    expect(md).toContain('**L3**')
    expect(md).toContain('L0 budget')
    expect(md).toContain('Anti-patterns')
    expect(md).toMatch(/Never stuff L2/)
  })
})

describe('contextTiersOneLiner', () => {
  it('is short and names all tiers', () => {
    const line = contextTiersOneLiner()
    expect(line.length).toBeLessThan(160)
    expect(line).toMatch(/L0/)
    expect(line).toMatch(/L2/)
  })
})
