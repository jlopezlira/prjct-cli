/**
 * Model Schema Tests
 *
 * Tests for:
 * - Semver comparison
 * - Minimum CLI version enforcement
 * - Model mismatch detection (provenance stamp, not policy)
 * - The absence of any role→model/effort policy
 *
 * @see PRJ-265
 */

import { describe, expect, it } from 'bun:test'
import {
  ClaudeProvider,
  CursorProvider,
  validateCliVersion,
} from '../../infrastructure/ai-provider'
import * as modelSchema from '../../schemas/model'
import {
  checkModelMismatch,
  compareSemver,
  type ModelMetadata,
  meetsMinVersion,
  SUPPORTED_PROVIDERS,
} from '../../schemas/model'

// Provider registry — names only, no model lists

describe('provider registry', () => {
  it('lists the rigs prjct can drive', () => {
    expect(SUPPORTED_PROVIDERS).toContain('claude')
    expect(SUPPORTED_PROVIDERS).toContain('gemini')
    expect(SUPPORTED_PROVIDERS).toContain('codex')
  })

  it('publishes no model list or default model per provider', () => {
    // prjct does not track which models a rig offers, because it never picks one.
    expect('defaultModel' in ClaudeProvider).toBe(false)
    expect('supportedModels' in ClaudeProvider).toBe(false)
    expect('defaultModel' in CursorProvider).toBe(false)
    expect(ClaudeProvider.minCliVersion).toBe('1.0.0')
    expect(CursorProvider.minCliVersion).toBeNull()
  })
})

// Semver Comparison

describe('compareSemver', () => {
  it('should return 0 for equal versions', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
    expect(compareSemver('2.3.4', '2.3.4')).toBe(0)
  })

  it('should return -1 when a < b', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1)
    expect(compareSemver('1.0.0', '1.1.0')).toBe(-1)
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1)
  })

  it('should return 1 when a > b', () => {
    expect(compareSemver('2.0.0', '1.0.0')).toBe(1)
    expect(compareSemver('1.1.0', '1.0.0')).toBe(1)
    expect(compareSemver('1.0.1', '1.0.0')).toBe(1)
  })

  it('should handle missing patch versions', () => {
    expect(compareSemver('1.0', '1.0.0')).toBe(0)
  })
})

// Version Validation

describe('meetsMinVersion', () => {
  it('should pass when version meets minimum', () => {
    expect(meetsMinVersion('claude', '1.0.0')).toBe(true)
    expect(meetsMinVersion('claude', '2.5.0')).toBe(true)
  })

  it('should fail when version is below minimum', () => {
    expect(meetsMinVersion('claude', '0.9.0')).toBe(false)
    expect(meetsMinVersion('claude', '0.0.1')).toBe(false)
  })

  it('should pass for providers without minimum', () => {
    expect(meetsMinVersion('cursor', '0.1.0')).toBe(true)
    expect(meetsMinVersion('unknown', '0.0.0')).toBe(true)
  })
})

describe('validateCliVersion', () => {
  it('should return null for valid versions', () => {
    expect(validateCliVersion('claude', '1.0.0')).toBeNull()
    expect(validateCliVersion('claude', '2.0.0')).toBeNull()
  })

  it('should return warning for versions below minimum', () => {
    const warning = validateCliVersion('claude', '0.5.0')
    expect(warning).toContain('below minimum')
    expect(warning).toContain('Claude Code')
  })

  it('should return null for undefined version', () => {
    expect(validateCliVersion('claude', undefined)).toBeNull()
  })

  it('should return null for providers without minCliVersion', () => {
    expect(validateCliVersion('cursor', '0.1.0')).toBeNull()
  })
})

// Model Mismatch Detection — provenance only

describe('checkModelMismatch', () => {
  const claudeOpus: ModelMetadata = {
    provider: 'claude',
    model: 'opus',
    cliVersion: '1.5.0',
    recordedAt: '2026-02-07T00:00:00.000Z',
  }

  const claudeSonnet: ModelMetadata = {
    provider: 'claude',
    model: 'sonnet',
    cliVersion: '1.5.0',
    recordedAt: '2026-02-07T00:00:00.000Z',
  }

  const geminiPro: ModelMetadata = {
    provider: 'gemini',
    model: '2.5-pro',
    cliVersion: '1.0.0',
    recordedAt: '2026-02-07T00:00:00.000Z',
  }

  it('should return null when models match', () => {
    expect(checkModelMismatch(claudeOpus, claudeOpus)).toBeNull()
  })

  it('should warn when models differ within same provider', () => {
    const warning = checkModelMismatch(claudeOpus, claudeSonnet)
    expect(warning).toContain('mismatch')
    expect(warning).toContain('opus')
    expect(warning).toContain('sonnet')
  })

  it('should warn when providers differ', () => {
    const warning = checkModelMismatch(claudeOpus, geminiPro)
    expect(warning).toContain('mismatch')
    expect(warning).toContain('claude')
    expect(warning).toContain('gemini')
  })

  it('should return null when either metadata is undefined', () => {
    expect(checkModelMismatch(undefined, claudeOpus)).toBeNull()
    expect(checkModelMismatch(claudeOpus, undefined)).toBeNull()
    expect(checkModelMismatch(undefined, undefined)).toBeNull()
  })
})

// The regression this module exists to prevent

describe('no role→model/effort policy exists', () => {
  // prjct used to cap 10 of 11 roles below the user's model and ship
  // "apply decent, not exhaustive, effort" into every non-implementer
  // dispatch. Nothing may bring that back — on ANY provider.
  const FORBIDDEN_EXPORTS = [
    'AGENT_MODEL_POLICY',
    'getAgentModelPolicy',
    'resolveAgentModel',
    'resolveProviderModel',
    'renderModelDirective',
    'renderModelDirectiveForProvider',
    'capabilityClassForRole',
    'PROVIDER_CAPABILITY_MODELS',
    'MODEL_TIER_FALLBACK',
    'getDefaultModel',
    'getSupportedModels',
    'isValidModelForProvider',
  ]

  it.each(FORBIDDEN_EXPORTS)('does not export %s', (name) => {
    expect(Object.hasOwn(modelSchema, name)).toBe(false)
  })
})
