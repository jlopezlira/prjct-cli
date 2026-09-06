/**
 * Unknown-key reporting must recognise every key `LocalConfig` defines —
 * a working key reported as a typo is the inverse of the bug this module
 * exists to catch (`enforce` and `gauntlet` were flagged while honoured).
 */

import { describe, expect, it } from 'bun:test'
import {
  KNOWN_CONFIG_KEYS,
  unknownConfigKeys,
  unknownConfigKeysMessage,
} from '../../services/config-validation'

describe('unknownConfigKeys', () => {
  it('recognises enforce and gauntlet as top-level keys', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('enforce')
    expect(KNOWN_CONFIG_KEYS).toContain('gauntlet')
    expect(
      unknownConfigKeys({
        projectId: 'p',
        enforce: { knowledgeFirst: false },
        gauntlet: { commands: { test: 'swift test' } },
      })
    ).toEqual([])
    expect(
      unknownConfigKeysMessage({ enforce: { knowledgeFirst: false }, gauntlet: {} })
    ).toBeNull()
  })

  it('names a near-miss and stays silent on comment keys', () => {
    const unknown = unknownConfigKeys({
      '// note': 'ignored',
      $schema: 'x',
      maxTokenPerCycle: 1,
      enforcee: {},
    })
    expect(unknown.map((u) => u.key)).toEqual(['maxTokenPerCycle', 'enforcee'])
    expect(unknown[0]?.didYouMean).toBe('maxTokensPerCycle')
    expect(unknown[1]?.didYouMean).toBe('enforce')
  })

  it('ignores non-object input', () => {
    expect(unknownConfigKeys(null)).toEqual([])
    expect(unknownConfigKeys(['enforce'])).toEqual([])
  })
})
