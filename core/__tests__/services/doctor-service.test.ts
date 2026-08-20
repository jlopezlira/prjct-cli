import { describe, expect, it } from 'bun:test'
import { summarizeDoctorResult } from '../../services/doctor-service'

describe('doctor health result', () => {
  it('includes critical context burn in success and exit-code health semantics', () => {
    const result = summarizeDoctorResult(
      [{ name: 'git', status: 'ok' }],
      [{ name: 'prjct config', status: 'ok' }],
      [{ name: 'codex sessions', status: 'error', message: 'ACTION REQUIRED' }],
      []
    )

    expect(result.success).toBe(false)
    expect(result.hasErrors).toBe(true)
    expect(result.context[0]?.status).toBe('error')
  })

  it('keeps optional missing tools non-fatal', () => {
    const result = summarizeDoctorResult(
      [{ name: 'gh', status: 'error', optional: true }],
      [],
      [],
      []
    )

    expect(result.success).toBe(true)
    expect(result.hasErrors).toBe(false)
    expect(result.hasWarnings).toBe(true)
  })
})
