import { describe, expect, it } from 'bun:test'
import { planDoctorRepairs } from '../../services/doctor-repair'
import type { CheckResult } from '../../types/services/extracted'

const check = (name: string, status: CheckResult['status']): CheckResult => ({ name, status })

describe('doctor repair planning', () => {
  it('maps every safe known failed check to a repair without waiting for user selection', () => {
    const plan = planDoctorRepairs([
      check('prjct config', 'error'),
      check('context7 mcp', 'error'),
      check('claude hooks', 'warn'),
    ])

    expect(plan).toEqual(['project-init', 'context7'])
  })

  it('does not invent destructive repairs for host/session or system boundaries', () => {
    const plan = planDoctorRepairs([
      check('git', 'error'),
      check('kimi catalog', 'error'),
      check('codex sessions', 'error'),
    ])

    expect(plan).toEqual([])
  })

  it('does nothing when the known checks are healthy', () => {
    expect(planDoctorRepairs([check('prjct config', 'ok'), check('context7 mcp', 'ok')])).toEqual(
      []
    )
  })
})
