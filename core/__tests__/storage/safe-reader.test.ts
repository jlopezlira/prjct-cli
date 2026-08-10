/**
 * Safe Reader Tests
 *
 * Tests for Zod-validated storage reads:
 * - Valid data passes through
 * - Corrupted JSON creates .backup + returns null
 * - Valid JSON with wrong schema creates .backup + returns null
 * - Missing files return null (no backup)
 * - Extra fields are preserved (forward compatibility)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { safeRead } from '../../storage/safe-reader'

// Test Schema

const TestSchema = z.object({
  name: z.string(),
  count: z.number(),
  items: z.array(z.string()),
})

type TestData = z.infer<typeof TestSchema>

// Setup

const fixture: {
  tmpDir: string
} = {
  tmpDir: '',
}

beforeEach(async () => {
  fixture.tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-safe-reader-test-'))
})

afterEach(async () => {
  await fs.rm(fixture.tmpDir, { recursive: true, force: true })
})

// Tests

describe('safeRead', () => {
  describe('valid data', () => {
    it('should return validated data for valid JSON matching schema', async () => {
      const filePath = path.join(fixture.tmpDir, 'valid.json')
      const data: TestData = { name: 'test', count: 42, items: ['a', 'b'] }
      await fs.writeFile(filePath, JSON.stringify(data, null, 2))

      const result = await safeRead<TestData>(filePath, TestSchema)

      expect(result).toEqual(data)
    })

    it('should preserve extra fields not in schema', async () => {
      const filePath = path.join(fixture.tmpDir, 'extra-fields.json')
      const data = {
        name: 'test',
        count: 1,
        items: [],
        extraField: 'preserved',
        nested: { deep: true },
      }
      await fs.writeFile(filePath, JSON.stringify(data, null, 2))

      const result = await safeRead<typeof data>(filePath, TestSchema)

      expect(result).not.toBeNull()
      expect(result!.name).toBe('test')
      expect(result!.extraField).toBe('preserved')
      expect(result!.nested).toEqual({ deep: true })
    })

    it('should not create .backup for valid data', async () => {
      const filePath = path.join(fixture.tmpDir, 'no-backup.json')
      const data: TestData = { name: 'ok', count: 0, items: [] }
      await fs.writeFile(filePath, JSON.stringify(data))

      await safeRead<TestData>(filePath, TestSchema)

      const backupExists = await fs
        .access(`${filePath}.backup`)
        .then(() => true)
        .catch(() => false)
      expect(backupExists).toBe(false)
    })
  })

  describe('missing files', () => {
    it('should return null for non-existent file', async () => {
      const result = await safeRead<TestData>(path.join(fixture.tmpDir, 'missing.json'), TestSchema)

      expect(result).toBeNull()
    })

    it('should not create .backup for missing file', async () => {
      const filePath = path.join(fixture.tmpDir, 'missing.json')
      await safeRead<TestData>(filePath, TestSchema)

      const backupExists = await fs
        .access(`${filePath}.backup`)
        .then(() => true)
        .catch(() => false)
      expect(backupExists).toBe(false)
    })
  })

  describe('corrupted JSON', () => {
    it('should return null for malformed JSON', async () => {
      const filePath = path.join(fixture.tmpDir, 'malformed.json')
      await fs.writeFile(filePath, 'not valid json {{{')

      const result = await safeRead<TestData>(filePath, TestSchema)

      expect(result).toBeNull()
    })

    it('should create .backup for malformed JSON', async () => {
      const filePath = path.join(fixture.tmpDir, 'malformed.json')
      const badContent = 'not valid json {{{'
      await fs.writeFile(filePath, badContent)

      await safeRead<TestData>(filePath, TestSchema)

      const backup = await fs.readFile(`${filePath}.backup`, 'utf-8')
      expect(backup).toBe(badContent)
    })

    it('should return null for empty file', async () => {
      const filePath = path.join(fixture.tmpDir, 'empty.json')
      await fs.writeFile(filePath, '')

      const result = await safeRead<TestData>(filePath, TestSchema)

      expect(result).toBeNull()
    })

    it('write-once: a second corrupt read does NOT clobber the first .backup', async () => {
      const filePath = path.join(fixture.tmpDir, 'recurring.json')
      const firstBad = '{ first corrupt evidence'
      await fs.writeFile(filePath, firstBad)
      await safeRead<TestData>(filePath, TestSchema)
      expect(await fs.readFile(`${filePath}.backup`, 'utf-8')).toBe(firstBad)

      // File gets corrupted differently and read again. The OLD code
      // overwrote .backup, destroying the first forensic copy.
      await fs.writeFile(filePath, '{ second DIFFERENT corruption')
      await safeRead<TestData>(filePath, TestSchema)

      expect(await fs.readFile(`${filePath}.backup`, 'utf-8')).toBe(firstBad)
    })
  })

  describe('valid JSON with wrong schema', () => {
    it('should return null when required field is missing', async () => {
      const filePath = path.join(fixture.tmpDir, 'missing-field.json')
      await fs.writeFile(filePath, JSON.stringify({ name: 'test' })) // missing count and items

      const result = await safeRead<TestData>(filePath, TestSchema)

      expect(result).toBeNull()
    })

    it('should create .backup when schema validation fails', async () => {
      const filePath = path.join(fixture.tmpDir, 'wrong-schema.json')
      const data = { name: 123, count: 'not a number', items: 'not an array' }
      await fs.writeFile(filePath, JSON.stringify(data))

      await safeRead<TestData>(filePath, TestSchema)

      const backupExists = await fs
        .access(`${filePath}.backup`)
        .then(() => true)
        .catch(() => false)
      expect(backupExists).toBe(true)
    })

    it('should return null when field has wrong type', async () => {
      const filePath = path.join(fixture.tmpDir, 'wrong-type.json')
      await fs.writeFile(filePath, JSON.stringify({ name: 42, count: 1, items: [] }))

      const result = await safeRead<TestData>(filePath, TestSchema)

      expect(result).toBeNull()
    })

    it('should return null when array contains wrong types', async () => {
      const filePath = path.join(fixture.tmpDir, 'wrong-array.json')
      await fs.writeFile(filePath, JSON.stringify({ name: 'test', count: 1, items: [1, 2, 3] }))

      const result = await safeRead<TestData>(filePath, TestSchema)

      expect(result).toBeNull()
    })
  })

  describe('optional fields and defaults', () => {
    it('should handle schema with optional fields', async () => {
      const OptionalSchema = z.object({
        name: z.string(),
        description: z.string().optional(),
      })

      const filePath = path.join(fixture.tmpDir, 'optional.json')
      await fs.writeFile(filePath, JSON.stringify({ name: 'test' }))

      const result = await safeRead<z.infer<typeof OptionalSchema>>(filePath, OptionalSchema)

      expect(result).not.toBeNull()
      expect(result!.name).toBe('test')
      expect(result!.description).toBeUndefined()
    })

    it('should handle schema with nullable fields', async () => {
      const NullableSchema = z.object({
        currentTask: z.object({ id: z.string() }).nullable(),
        lastUpdated: z.string(),
      })

      const filePath = path.join(fixture.tmpDir, 'nullable.json')
      await fs.writeFile(filePath, JSON.stringify({ currentTask: null, lastUpdated: '2026-01-01' }))

      const result = await safeRead<z.infer<typeof NullableSchema>>(filePath, NullableSchema)

      expect(result).not.toBeNull()
      expect(result!.currentTask).toBeNull()
    })
  })

  describe('integration with StorageManager pattern', () => {
    it('should work with real StateJsonSchema', async () => {
      // Import the actual schema used in production
      const { StateJsonSchema } = await import('../../schemas/state')

      const filePath = path.join(fixture.tmpDir, 'state.json')
      const stateData = {
        currentTask: null,
        lastUpdated: '2026-02-07T00:00:00.000Z',
        // Extra fields that exist in real state.json but not in schema
        projectId: 'test-123',
        stack: { language: 'TypeScript', framework: 'Hono' },
      }
      await fs.writeFile(filePath, JSON.stringify(stateData, null, 2))

      const result = await safeRead<typeof stateData>(filePath, StateJsonSchema)

      expect(result).not.toBeNull()
      expect(result!.currentTask).toBeNull()
      expect(result!.projectId).toBe('test-123') // Extra field preserved
    })

    it('should reject corrupted state data', async () => {
      const { StateJsonSchema } = await import('../../schemas/state')

      const filePath = path.join(fixture.tmpDir, 'bad-state.json')
      // currentTask should be an object or null, not a number
      const badData = { currentTask: 42, lastUpdated: '2026-02-07' }
      await fs.writeFile(filePath, JSON.stringify(badData))

      const result = await safeRead(filePath, StateJsonSchema)

      expect(result).toBeNull()
      // Backup should exist
      const backupExists = await fs
        .access(`${filePath}.backup`)
        .then(() => true)
        .catch(() => false)
      expect(backupExists).toBe(true)
    })
  })
})
