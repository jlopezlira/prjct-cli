/**
 * Model Schema Tests
 *
 * Tests for:
 * - Provider model validation
 * - Semver comparison
 * - Minimum CLI version enforcement
 * - Model mismatch detection
 * - Default model resolution
 * - Backwards compatibility (missing model field)
 *
 * @see PRJ-265
 */

import { describe, expect, it } from 'bun:test'
import {
  ClaudeProvider,
  CursorProvider,
  GeminiProvider,
  validateCliVersion,
} from '../../infrastructure/ai-provider'
import {
  AGENT_MODEL_POLICY,
  type AgentRole,
  checkModelMismatch,
  compareSemver,
  getAgentModelPolicy,
  getDefaultModel,
  getSupportedModels,
  isValidModelForProvider,
  type ModelMetadata,
  meetsMinVersion,
  renderModelDirective,
  renderModelDirectiveForProvider,
} from '../../schemas/model'

// Provider Model Configuration

describe('Provider model configuration', () => {
  it('should have model fields on Claude provider', () => {
    expect(ClaudeProvider.defaultModel).toBe('sonnet')
    expect(ClaudeProvider.supportedModels).toEqual(['opus', 'sonnet', 'haiku'])
    expect(ClaudeProvider.minCliVersion).toBe('1.0.0')
  })

  it('should have model fields on Gemini provider', () => {
    expect(GeminiProvider.defaultModel).toBe('2.5-flash')
    // 2026-07: include Gemini 3.1 Pro in the supported set (frontier).
    expect(GeminiProvider.supportedModels).toContain('3.1-pro')
    expect(GeminiProvider.supportedModels).toContain('2.5-pro')
    expect(GeminiProvider.supportedModels).toContain('2.5-flash')
    expect(GeminiProvider.minCliVersion).toBe('1.0.0')
  })

  it('should have null model fields on multi-model IDEs', () => {
    expect(CursorProvider.defaultModel).toBeNull()
    expect(CursorProvider.supportedModels).toEqual([])
    expect(CursorProvider.minCliVersion).toBeNull()
  })
})

// Model Validation

describe('isValidModelForProvider', () => {
  it('should accept valid Claude models', () => {
    expect(isValidModelForProvider('claude', 'opus')).toBe(true)
    expect(isValidModelForProvider('claude', 'sonnet')).toBe(true)
    expect(isValidModelForProvider('claude', 'haiku')).toBe(true)
  })

  it('should reject invalid Claude models', () => {
    expect(isValidModelForProvider('claude', 'gpt-4')).toBe(false)
    expect(isValidModelForProvider('claude', 'unknown')).toBe(false)
  })

  it('should accept valid Gemini models', () => {
    expect(isValidModelForProvider('gemini', '3.1-pro')).toBe(true)
    expect(isValidModelForProvider('gemini', '2.5-pro')).toBe(true)
    expect(isValidModelForProvider('gemini', '2.5-flash')).toBe(true)
    expect(isValidModelForProvider('gemini', '2.0-flash')).toBe(true)
  })

  it('should accept 2026-07 benchmark Codex / OpenAI models', () => {
    expect(isValidModelForProvider('codex', 'gpt-5.5')).toBe(true)
    expect(isValidModelForProvider('openai', 'gpt-5.5')).toBe(true)
    expect(isValidModelForProvider('codex', 'o3')).toBe(true)
  })

  it('should reject invalid Gemini models', () => {
    expect(isValidModelForProvider('gemini', 'sonnet')).toBe(false)
  })

  it('should accept any model for multi-model IDEs (empty supportedModels)', () => {
    expect(isValidModelForProvider('cursor', 'gpt-4')).toBe(true)
    expect(isValidModelForProvider('cursor', 'anything')).toBe(true)
    expect(isValidModelForProvider('antigravity', 'claude-sonnet')).toBe(true)
  })

  it('should accept any model for unknown providers', () => {
    expect(isValidModelForProvider('future-provider', 'some-model')).toBe(true)
  })
})

// Default Model Resolution

describe('getDefaultModel', () => {
  it('should return sonnet for Claude', () => {
    expect(getDefaultModel('claude')).toBe('sonnet')
  })

  it('should return 2.5-flash for Gemini', () => {
    expect(getDefaultModel('gemini')).toBe('2.5-flash')
  })

  it('should return null for providers without defaults', () => {
    expect(getDefaultModel('cursor')).toBeNull()
    expect(getDefaultModel('unknown')).toBeNull()
  })
})

// Supported Models

describe('getSupportedModels', () => {
  it('should return Claude models', () => {
    expect(getSupportedModels('claude')).toEqual(['opus', 'sonnet', 'haiku'])
  })

  it('should return empty for multi-model IDEs', () => {
    expect(getSupportedModels('cursor')).toEqual([])
  })

  it('should return empty for unknown providers', () => {
    expect(getSupportedModels('unknown')).toEqual([])
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

// Model Mismatch Detection

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

// Backwards Compatibility

describe('backwards compatibility', () => {
  it('should handle configs without model field gracefully', () => {
    // Simulates loading an old config without model fields
    const oldProviderConfig = {
      name: 'claude' as const,
      displayName: 'Claude Code',
      cliCommand: 'claude',
    }
    // getDefaultModel should work even if provider config has no model field
    expect(getDefaultModel(oldProviderConfig.name)).toBe('sonnet')
  })

  it('should resolve default model when preferredModel is not set', () => {
    const preferredModel: string | undefined = undefined
    const provider = 'claude'
    const resolved = preferredModel ?? getDefaultModel(provider)
    expect(resolved).toBe('sonnet')
  })
})

describe('AGENT_MODEL_POLICY — per-role model + effort for subagent dispatch', () => {
  it('gives ONLY the implementer the max model + max effort', () => {
    expect(AGENT_MODEL_POLICY.implementer).toEqual({ model: 'opus', effort: 'max' })
    // No other role may be opus/max — that is the regression being fixed.
    for (const [role, policy] of Object.entries(AGENT_MODEL_POLICY)) {
      if (role === 'implementer') continue
      expect(policy.model).not.toBe('opus')
      expect(policy.effort).not.toBe('max')
    }
  })

  it('routes pure orchestration to haiku + decent', () => {
    expect(AGENT_MODEL_POLICY.orchestrator).toEqual({ model: 'haiku', effort: 'decent' })
  })

  it('routes every judgment/review role to sonnet + decent', () => {
    const reviewerRoles: AgentRole[] = [
      'strategic-review',
      'architecture-review',
      'design-review',
      'review',
      'security',
      'investigate',
      'reviewer',
    ]
    for (const role of reviewerRoles) {
      expect(getAgentModelPolicy(role)).toEqual({ model: 'sonnet', effort: 'decent' })
    }
  })

  it('falls back to the reviewer tier for an unknown role — never to implementer/max', () => {
    const policy = getAgentModelPolicy('totally-unknown-role' as AgentRole)
    expect(policy).toEqual({ model: 'sonnet', effort: 'decent' })
    expect(policy.model).not.toBe('opus')
  })

  it('renderModelDirective: implementer keeps full effort + opus', () => {
    const d = renderModelDirective('implementer')
    expect(d).toContain('model: "opus"')
    expect(d).toContain('full reasoning effort')
    expect(d).toContain('IMPLEMENTER')
  })

  it('renderModelDirective: non-implementer is told to drop off the parent max model', () => {
    const d = renderModelDirective('security')
    expect(d).toContain('model: "sonnet"')
    expect(d).toContain("NOT the parent's max model")
    expect(d).toContain('decent')
    expect(d).not.toContain('model: "opus"')
  })

  it('renderModelDirective: a classOverride routes a narrow specialist to the cheap model', () => {
    // Default review-tier (no override) → sonnet; opting down to `fast` → haiku.
    expect(renderModelDirective('spec-review')).toContain('model: "sonnet"')
    const fast = renderModelDirective('spec-review', undefined, 'fast')
    expect(fast).toContain('model: "haiku"')
    expect(fast).not.toContain('model: "sonnet"')
  })

  it('renderModelDirectiveForProvider: classOverride picks the rig-correct cheap model', () => {
    // Behavior-preserving default for gemini review-tier → 2.5-flash (balanced).
    expect(renderModelDirectiveForProvider('spec-review', 'gemini')).toContain('2.5-flash')
    // Opting down to `fast` on gemini → the fast-class model.
    const fast = renderModelDirectiveForProvider('spec-review', 'gemini', undefined, 'fast')
    expect(fast).toContain('2.0-flash')
  })
})
