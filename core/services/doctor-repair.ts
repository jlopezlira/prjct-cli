/** Check-driven repairs for doctor --fix. Keep the registry deliberately
 * narrow: only normal, reversible prjct setup operations belong here. */

import type { CheckResult } from '../types/services/extracted'
import context7Service from './context7-service'
import { projectService } from './project-service'

export type DoctorRepairId = 'project-init' | 'context7'

export interface DoctorRepairReport {
  planned: DoctorRepairId[]
  applied: DoctorRepairId[]
  errors: string[]
  line: string
}

export function planDoctorRepairs(checks: CheckResult[]): DoctorRepairId[] {
  return [
    checks.some((check) => check.name === 'prjct config' && check.status === 'error')
      ? 'project-init'
      : null,
    checks.some((check) => check.name === 'context7 mcp' && check.status === 'error')
      ? 'context7'
      : null,
  ].filter((repair): repair is DoctorRepairId => repair !== null)
}

export async function applyPlannedDoctorRepairs(
  checks: CheckResult[],
  projectPath: string
): Promise<DoctorRepairReport> {
  const planned = planDoctorRepairs(checks)
  const applied: DoctorRepairId[] = []
  const errors: string[] = []

  for (const repair of planned) {
    try {
      if (repair === 'project-init') {
        const result = await projectService.ensureInit(projectPath)
        if (!result.success) throw new Error(result.error ?? 'project initialization failed')
      } else {
        await context7Service.ensureReady()
      }
      applied.push(repair)
    } catch (error) {
      errors.push(`${repair}: ${(error as Error).message}`)
    }
  }

  return {
    planned,
    applied,
    errors,
    line: `Check-driven repair: applied ${applied.length}/${planned.length} · errors ${errors.length}`,
  }
}
