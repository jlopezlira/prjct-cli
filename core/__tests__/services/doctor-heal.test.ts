/**
 * Doctor heal plan (Dynasty D6) — pure planning unit tests.
 */

import { describe, expect, it } from 'bun:test'
import { planDoctorHeal } from '../../services/doctor-heal'

describe('doctor-heal plan', () => {
  it('needs hooks when incomplete', () => {
    const p = planDoctorHeal({
      hooksInstalled: 2,
      hooksExpected: 10,
      liveCount: 3,
      detectedCount: 3,
      organicPct: 100,
    })
    expect(p.actions.find((a) => a.id === 'claude-hooks')?.needed).toBe(true)
    expect(p.neededCount).toBeGreaterThan(0)
    expect(p.line).toMatch(/Doctor heal plan/)
  })

  it('needs multi-runtime when organic incomplete', () => {
    const p = planDoctorHeal({
      hooksInstalled: 10,
      hooksExpected: 10,
      liveCount: 1,
      detectedCount: 4,
      organicPct: 25,
    })
    expect(p.actions.find((a) => a.id === 'multi-runtime-wire')?.needed).toBe(true)
    expect(p.actions.find((a) => a.id === 'organic-board')?.needed).toBe(true)
  })

  it('skips hook reinstall when complete', () => {
    const p = planDoctorHeal({
      hooksInstalled: 12,
      hooksExpected: 12,
      liveCount: 4,
      detectedCount: 4,
      organicPct: 100,
    })
    expect(p.actions.find((a) => a.id === 'claude-hooks')?.needed).toBe(false)
  })

  it('needs portable-skills heal when skill is project-stamped', () => {
    const p = planDoctorHeal({
      hooksInstalled: 12,
      hooksExpected: 12,
      liveCount: 4,
      detectedCount: 4,
      organicPct: 100,
      skillPoisoned: true,
    })
    expect(p.actions.find((a) => a.id === 'portable-skills')?.needed).toBe(true)
  })

  it('skips portable-skills when skill is clean', () => {
    const p = planDoctorHeal({
      hooksInstalled: 12,
      hooksExpected: 12,
      liveCount: 4,
      detectedCount: 4,
      organicPct: 100,
      skillPoisoned: false,
    })
    expect(p.actions.find((a) => a.id === 'portable-skills')?.needed).toBe(false)
  })
})
