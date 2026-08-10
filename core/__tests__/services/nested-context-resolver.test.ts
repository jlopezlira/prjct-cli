/**
 * Tests for NestedContextResolver - AGENTS.md discovery and resolution
 * PRJ-101: Hierarchical scope system
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import NestedContextResolver from '../../services/nested-context-resolver'

// Test directory setup
const fixture: {
  testDir: string
  resolver: NestedContextResolver
} = {
  testDir: '',
  resolver: undefined as unknown as NestedContextResolver,
}

beforeEach(async () => {
  // Create temp directory for tests
  fixture.testDir = path.join(os.tmpdir(), `prjct-test-${Date.now()}`)
  await fs.mkdir(fixture.testDir, { recursive: true })
  fixture.resolver = new NestedContextResolver(fixture.testDir)
})

afterEach(async () => {
  // Cleanup temp directory
  try {
    await fs.rm(fixture.testDir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
})

// PRJCT.md Discovery Tests (existing functionality)

describe('NestedContextResolver - PRJCT.md', () => {
  test('discovers root PRJCT.md', async () => {
    await fs.writeFile(path.join(fixture.testDir, 'PRJCT.md'), '## Rules\n\n- Rule 1\n- Rule 2')

    const contexts = await fixture.resolver.discoverContextFiles()

    expect(contexts).toHaveLength(1)
    expect(contexts[0].depth).toBe(0)
    expect(contexts[0].sections).toHaveLength(1)
    expect(contexts[0].sections[0].name).toBe('Rules')
  })

  test('parses sections with override marker', async () => {
    await fs.writeFile(
      path.join(fixture.testDir, 'PRJCT.md'),
      '## Rules @override\n\n- Override rule'
    )

    const contexts = await fixture.resolver.discoverContextFiles()

    expect(contexts[0].sections[0].override).toBe(true)
    expect(contexts[0].sections[0].name).toBe('Rules')
  })

  test('handles empty project (no PRJCT.md)', async () => {
    const contexts = await fixture.resolver.discoverContextFiles()
    expect(contexts).toHaveLength(0)
  })
})

// AGENTS.md Discovery Tests (new functionality)

describe('NestedContextResolver - AGENTS.md Discovery', () => {
  test('discovers root AGENTS.md', async () => {
    await fs.writeFile(
      path.join(fixture.testDir, 'AGENTS.md'),
      `## Backend

Handles backend development.

### Triggers
- api
- endpoint

### Rules
- Use async/await
`
    )

    const agentFiles = await fixture.resolver.discoverAgentFiles()

    expect(agentFiles).toHaveLength(1)
    expect(agentFiles[0].depth).toBe(0)
    expect(agentFiles[0].agents).toHaveLength(1)
    expect(agentFiles[0].agents[0].name).toBe('Backend')
  })

  test('parses multiple agents from single file', async () => {
    await fs.writeFile(
      path.join(fixture.testDir, 'AGENTS.md'),
      `## Frontend

Frontend specialist.

### Triggers
- component
- ui

## Backend

Backend specialist.

### Triggers
- api
- database
`
    )

    const agentFiles = await fixture.resolver.discoverAgentFiles()

    expect(agentFiles[0].agents).toHaveLength(2)
    expect(agentFiles[0].agents[0].name).toBe('Frontend')
    expect(agentFiles[0].agents[1].name).toBe('Backend')
  })

  test('parses agent triggers as array', async () => {
    await fs.writeFile(
      path.join(fixture.testDir, 'AGENTS.md'),
      `## Testing

Testing specialist.

### Triggers
- write test
- add test
- unit test
`
    )

    const agentFiles = await fixture.resolver.discoverAgentFiles()
    const agent = agentFiles[0].agents[0]

    expect(agent.triggers).toEqual(['write test', 'add test', 'unit test'])
  })

  test('parses agent rules as array', async () => {
    await fs.writeFile(
      path.join(fixture.testDir, 'AGENTS.md'),
      `## Backend

Backend specialist.

### Rules
- Use TypeScript
- Validate inputs
- Log errors
`
    )

    const agentFiles = await fixture.resolver.discoverAgentFiles()
    const agent = agentFiles[0].agents[0]

    expect(agent.rules).toEqual(['Use TypeScript', 'Validate inputs', 'Log errors'])
  })

  test('parses code patterns from code blocks', async () => {
    await fs.writeFile(
      path.join(fixture.testDir, 'AGENTS.md'),
      `## Backend

Backend specialist.

### Patterns
\`\`\`typescript
async function handler(req: Request) {
  return new Response('ok')
}
\`\`\`
`
    )

    const agentFiles = await fixture.resolver.discoverAgentFiles()
    const agent = agentFiles[0].agents[0]

    expect(agent.patterns).toHaveLength(1)
    expect(agent.patterns![0]).toContain('async function handler')
  })

  test('detects @override marker on agent', async () => {
    await fs.writeFile(
      path.join(fixture.testDir, 'AGENTS.md'),
      `## Frontend @override

Overrides parent frontend agent.
`
    )

    const agentFiles = await fixture.resolver.discoverAgentFiles()
    const agent = agentFiles[0].agents[0]

    expect(agent.name).toBe('Frontend')
    expect(agent.override).toBe(true)
  })

  test('handles empty AGENTS.md', async () => {
    await fs.writeFile(path.join(fixture.testDir, 'AGENTS.md'), '# AGENTS.md\n\nNo agents defined.')

    const agentFiles = await fixture.resolver.discoverAgentFiles()

    expect(agentFiles).toHaveLength(1)
    expect(agentFiles[0].agents).toHaveLength(0)
  })

  test('handles missing AGENTS.md', async () => {
    const agentFiles = await fixture.resolver.discoverAgentFiles()
    expect(agentFiles).toHaveLength(0)
  })
})

// AGENTS.md Hierarchy Tests

describe('NestedContextResolver - AGENTS.md Hierarchy', () => {
  test('discovers nested AGENTS.md in subdirectories', async () => {
    // Create root AGENTS.md
    await fs.writeFile(
      path.join(fixture.testDir, 'AGENTS.md'),
      `## GlobalAgent

Global agent for all.
`
    )

    // Create subdirectory with AGENTS.md
    const subDir = path.join(fixture.testDir, 'packages', 'web')
    await fs.mkdir(subDir, { recursive: true })
    await fs.writeFile(
      path.join(subDir, 'AGENTS.md'),
      `## WebAgent

Web-specific agent.
`
    )

    const agentFiles = await fixture.resolver.discoverAgentFiles()

    expect(agentFiles).toHaveLength(2)
    expect(agentFiles.find((af) => af.depth === 0)?.agents[0].name).toBe('GlobalAgent')
  })

  test('builds parent-child relationships', async () => {
    // Create root AGENTS.md
    await fs.writeFile(path.join(fixture.testDir, 'AGENTS.md'), '## Root\n\nRoot agent.')

    // Create child AGENTS.md
    const childDir = path.join(fixture.testDir, 'src')
    await fs.mkdir(childDir, { recursive: true })
    await fs.writeFile(path.join(childDir, 'AGENTS.md'), '## Child\n\nChild agent.')

    const agentFiles = await fixture.resolver.discoverAgentFiles()

    const root = agentFiles.find((af) => af.depth === 0)
    const child = agentFiles.find((af) => af.depth > 0)

    expect(root).toBeDefined()
    expect(child).toBeDefined()
    expect(child?.parent).toBe(root)
    expect(root?.children).toContain(child)
  })

  test('resolves agents for path with inheritance', async () => {
    // Root defines base agents
    await fs.writeFile(
      path.join(fixture.testDir, 'AGENTS.md'),
      `## Shared

Shared rules for all.

### Rules
- Rule from root
`
    )

    // Child adds more rules
    const childDir = path.join(fixture.testDir, 'packages', 'api')
    await fs.mkdir(childDir, { recursive: true })
    await fs.writeFile(
      path.join(childDir, 'AGENTS.md'),
      `## Shared

Extended in child.

### Rules
- Rule from child
`
    )

    const resolved = await fixture.resolver.resolveAgentsForPath(childDir)

    expect(resolved.agents).toHaveLength(1)
    expect(resolved.agents[0].name).toBe('Shared')
    // Rules should be merged
    expect(resolved.agents[0].rules).toContain('Rule from root')
    expect(resolved.agents[0].rules).toContain('Rule from child')
  })

  test('override replaces parent agent entirely', async () => {
    // Root defines agent
    await fs.writeFile(
      path.join(fixture.testDir, 'AGENTS.md'),
      `## Frontend

Root frontend agent.

### Rules
- Root rule 1
- Root rule 2
`
    )

    // Child overrides
    const childDir = path.join(fixture.testDir, 'web')
    await fs.mkdir(childDir, { recursive: true })
    await fs.writeFile(
      path.join(childDir, 'AGENTS.md'),
      `## Frontend @override

Completely new frontend agent.

### Rules
- Child rule only
`
    )

    const resolved = await fixture.resolver.resolveAgentsForPath(childDir)

    expect(resolved.agents).toHaveLength(1)
    expect(resolved.agents[0].rules).toHaveLength(1)
    expect(resolved.agents[0].rules).toContain('Child rule only')
    expect(resolved.overrides).toContain(`web/AGENTS.md:Frontend`)
  })

  test('adds new agents from child without affecting parent agents', async () => {
    // Root has one agent
    await fs.writeFile(path.join(fixture.testDir, 'AGENTS.md'), '## Backend\n\nBackend agent.')

    // Child adds different agent
    const childDir = path.join(fixture.testDir, 'mobile')
    await fs.mkdir(childDir, { recursive: true })
    await fs.writeFile(path.join(childDir, 'AGENTS.md'), '## Mobile\n\nMobile agent.')

    const resolved = await fixture.resolver.resolveAgentsForPath(childDir)

    expect(resolved.agents).toHaveLength(2)
    expect(resolved.agents.map((a) => a.name).sort()).toEqual(['Backend', 'Mobile'])
  })

  test('tracks sources in resolution', async () => {
    await fs.writeFile(path.join(fixture.testDir, 'AGENTS.md'), '## Agent\n\nRoot.')

    const level1 = path.join(fixture.testDir, 'level1')
    await fs.mkdir(level1)
    await fs.writeFile(path.join(level1, 'AGENTS.md'), '## Agent\n\nLevel 1.')

    const level2 = path.join(level1, 'level2')
    await fs.mkdir(level2)
    await fs.writeFile(path.join(level2, 'AGENTS.md'), '## Agent\n\nLevel 2.')

    const resolved = await fixture.resolver.resolveAgentsForPath(level2)

    expect(resolved.sources).toHaveLength(3)
    expect(resolved.sources[0]).toBe('AGENTS.md')
    expect(resolved.sources[1]).toBe('level1/AGENTS.md')
    expect(resolved.sources[2]).toBe('level1/level2/AGENTS.md')
  })
})

// Edge Cases

describe('NestedContextResolver - Edge Cases', () => {
  test('ignores node_modules directories', async () => {
    await fs.writeFile(path.join(fixture.testDir, 'AGENTS.md'), '## Root\n\nRoot.')

    // Create AGENTS.md in node_modules (should be ignored)
    const nmDir = path.join(fixture.testDir, 'node_modules', 'some-package')
    await fs.mkdir(nmDir, { recursive: true })
    await fs.writeFile(path.join(nmDir, 'AGENTS.md'), '## ShouldIgnore\n\nIgnored.')

    const agentFiles = await fixture.resolver.discoverAgentFiles()

    expect(agentFiles).toHaveLength(1)
    expect(agentFiles[0].agents[0].name).toBe('Root')
  })

  test('ignores dot directories', async () => {
    await fs.writeFile(path.join(fixture.testDir, 'AGENTS.md'), '## Root\n\nRoot.')

    // Create AGENTS.md in .git (should be ignored)
    const gitDir = path.join(fixture.testDir, '.git', 'hooks')
    await fs.mkdir(gitDir, { recursive: true })
    await fs.writeFile(path.join(gitDir, 'AGENTS.md'), '## ShouldIgnore\n\nIgnored.')

    const agentFiles = await fixture.resolver.discoverAgentFiles()

    expect(agentFiles).toHaveLength(1)
  })

  test('handles malformed AGENTS.md gracefully', async () => {
    await fs.writeFile(
      path.join(fixture.testDir, 'AGENTS.md'),
      `# Not a proper agent header

Some text here

### Rules without agent
- orphan rule

## Proper Agent

This one is valid.
`
    )

    const agentFiles = await fixture.resolver.discoverAgentFiles()

    // Should only find the valid agent
    expect(agentFiles[0].agents).toHaveLength(1)
    expect(agentFiles[0].agents[0].name).toBe('Proper Agent')
  })

  test('limits scanning depth to prevent infinite recursion', async () => {
    // Create deeply nested directory structure
    const directories = Array.from({ length: 10 }, (_, index) =>
      path.join(
        fixture.testDir,
        ...Array.from({ length: index + 1 }, (_unused, level) => `level${level}`)
      )
    )
    for (const [i, currentDir] of directories.entries()) {
      await fs.mkdir(currentDir, { recursive: true })
      await fs.writeFile(path.join(currentDir, 'AGENTS.md'), `## Level${i}\n\nLevel ${i} agent.`)
    }

    // Should complete without hanging (depth limit is 5)
    const agentFiles = await fixture.resolver.discoverAgentFiles()

    // Should find root + up to 5 levels deep
    expect(agentFiles.length).toBeLessThanOrEqual(6)
  })
})
