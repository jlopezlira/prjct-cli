/** Canonical Kimi user skill path, shared by installation and coverage probes. */
import path from 'node:path'
import { resolveUserHome } from './user-home'

export function getKimiSkillPath(): string {
  const home = resolveUserHome()
  const configured = process.env.KIMI_CODE_HOME?.trim()
  const root = configured?.startsWith('~/')
    ? path.join(home, configured.slice(2))
    : configured
      ? path.resolve(configured)
      : path.join(home, '.kimi-code')
  return path.join(root, 'skills', 'prjct', 'SKILL.md')
}
