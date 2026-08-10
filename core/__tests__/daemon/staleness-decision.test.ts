/**
 * decideRestart contract — the daemon's "should I restart BEFORE serving?"
 * decision. This is the fix for the recurring stale-daemon trap: the daemon
 * used to detect a new build AFTER serving, so the triggering request was
 * answered by the outdated code. These tests pin the ordering and the
 * time-throttled drift probe so that regression can't creep back.
 */

import { describe, expect, test } from 'bun:test'
import { decideRestart, isStrictlyNewerVersion } from '../../daemon/staleness'

describe('isStrictlyNewerVersion', () => {
  test('detects upgrades and ignores equal/older/non-semver', () => {
    expect(isStrictlyNewerVersion('3.49.0', '3.48.0')).toBe(true)
    expect(isStrictlyNewerVersion('3.48.1', '3.48.0')).toBe(true)
    expect(isStrictlyNewerVersion('4.0.0', '3.99.99')).toBe(true)
    expect(isStrictlyNewerVersion('3.48.0', '3.48.0')).toBe(false)
    expect(isStrictlyNewerVersion('3.47.0', '3.48.0')).toBe(false)
    expect(isStrictlyNewerVersion('not-a-version', '3.48.0')).toBe(false)
    expect(isStrictlyNewerVersion('v3.50.0', '3.49.0')).toBe(true)
  })
})

const NEVER = () => false
const ALWAYS = () => true

describe('decideRestart', () => {
  test('a rebuilt entry file (codeStale) restarts immediately, no drift probe', () => {
    const probes: true[] = []
    const d = decideRestart({
      codeStale: true,
      command: 'status',
      ownVersion: '1.0.0',
      now: 10_000,
      lastDriftCheckMs: 0,
      driftMinIntervalMs: 1000,
      checkDrift: () => {
        probes.push(true)
        return false
      },
    })
    expect(d.restart).toBe(true)
    expect(probes).toHaveLength(0) // mtime wins; never pays for the drift probe
  })

  test('global-install drift restarts and advances the throttle timestamp', () => {
    const d = decideRestart({
      codeStale: false,
      command: 'status',
      ownVersion: '1.0.0',
      now: 5000,
      lastDriftCheckMs: 0,
      driftMinIntervalMs: 1000,
      checkDrift: ALWAYS,
    })
    expect(d.restart).toBe(true)
    expect(d.lastDriftCheckMs).toBe(5000)
  })

  test('no staleness → no restart, throttle timestamp still advances after a probe', () => {
    const d = decideRestart({
      codeStale: false,
      command: 'status',
      ownVersion: '1.0.0',
      now: 5000,
      lastDriftCheckMs: 0,
      driftMinIntervalMs: 1000,
      checkDrift: NEVER,
    })
    expect(d.restart).toBe(false)
    expect(d.lastDriftCheckMs).toBe(5000) // a probe ran, so the clock advances
  })

  test('drift probe is throttled — skipped when within the min interval', () => {
    const probes: true[] = []
    const d = decideRestart({
      codeStale: false,
      command: 'status',
      ownVersion: '1.0.0',
      now: 1500, // only 500ms since last check
      lastDriftCheckMs: 1000,
      driftMinIntervalMs: 1000,
      checkDrift: () => {
        probes.push(true)
        return true
      },
    })
    expect(probes).toHaveLength(0) // throttled — no probe, no restart
    expect(d.restart).toBe(false)
    expect(d.lastDriftCheckMs).toBe(1000) // unchanged
  })

  test('drift probe fires once the min interval has elapsed', () => {
    const probes: true[] = []
    const d = decideRestart({
      codeStale: false,
      command: 'status',
      ownVersion: '1.0.0',
      now: 2000, // exactly 1000ms since last check
      lastDriftCheckMs: 1000,
      driftMinIntervalMs: 1000,
      checkDrift: () => {
        probes.push(true)
        return false
      },
    })
    expect(probes).toHaveLength(1)
    expect(d.lastDriftCheckMs).toBe(2000)
  })

  test('health pings (__ping) never trigger the drift probe', () => {
    const probes: true[] = []
    const d = decideRestart({
      codeStale: false,
      command: '__ping',
      ownVersion: '1.0.0',
      now: 999_999,
      lastDriftCheckMs: 0,
      driftMinIntervalMs: 1000,
      checkDrift: () => {
        probes.push(true)
        return true
      },
    })
    expect(probes).toHaveLength(0)
    expect(d.restart).toBe(false)
  })

  test('no ownVersion → drift probe is skipped (nothing to compare)', () => {
    const probes: true[] = []
    const d = decideRestart({
      codeStale: false,
      command: 'status',
      ownVersion: null,
      now: 999_999,
      lastDriftCheckMs: 0,
      driftMinIntervalMs: 1000,
      checkDrift: () => {
        probes.push(true)
        return true
      },
    })
    expect(probes).toHaveLength(0)
    expect(d.restart).toBe(false)
  })
})
