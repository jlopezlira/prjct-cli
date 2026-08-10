/**
 * Output Module Tests
 * Minimal output system for prjct-cli
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import out, {
  formatForHuman,
  getOutputTier,
  getTierConfig,
  limitLines,
  OUTPUT_TIERS,
  setOutputTier,
} from '../../utils/output'

describe('Output Module', () => {
  const fixture: {
    consoleLogSpy: ReturnType<typeof spyOn>
    consoleErrorSpy: ReturnType<typeof spyOn>
    stdoutWriteSpy: ReturnType<typeof spyOn>
  } = {
    consoleLogSpy: undefined as unknown as ReturnType<typeof spyOn>,
    consoleErrorSpy: undefined as unknown as ReturnType<typeof spyOn>,
    stdoutWriteSpy: undefined as unknown as ReturnType<typeof spyOn>,
  }

  beforeEach(() => {
    fixture.consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {})
    fixture.consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {})
    fixture.stdoutWriteSpy = spyOn(process.stdout, 'write').mockImplementation(() => true)
    out.stop()
  })

  afterEach(() => {
    fixture.consoleLogSpy.mockRestore()
    fixture.consoleErrorSpy.mockRestore()
    fixture.stdoutWriteSpy.mockRestore()
    out.stop()
  })

  describe('done()', () => {
    it('should output success message with checkmark', () => {
      out.done('task completed')

      expect(fixture.consoleLogSpy).toHaveBeenCalledTimes(1)
      const output = fixture.consoleLogSpy.mock.calls[0][0]
      expect(output).toContain('✓')
      expect(output).toContain('task completed')
    })

    it('should truncate long messages in TTY mode', () => {
      const prevOut = process.stdout.isTTY
      process.stdout.isTTY = true
      try {
        const longMessage = 'a'.repeat(100)
        out.done(longMessage)

        const output = fixture.consoleLogSpy.mock.calls[0][0]
        expect(output.length).toBeLessThan(80)
      } finally {
        process.stdout.isTTY = prevOut
      }
    })

    it('should NOT truncate in non-TTY (agent/pipe) mode', () => {
      const prevOut = process.stdout.isTTY
      const prevErr = process.stderr.isTTY
      process.stdout.isTTY = false as never
      process.stderr.isTTY = false as never
      try {
        const longMessage = 'a'.repeat(100)
        out.done(longMessage)

        const output = fixture.consoleLogSpy.mock.calls[0][0]
        expect(output).toContain(longMessage)
      } finally {
        process.stdout.isTTY = prevOut
        process.stderr.isTTY = prevErr
      }
    })

    it('should return self for chaining', () => {
      const result = out.done('test')
      expect(result).toBe(out)
    })
  })

  describe('fail()', () => {
    it('should output error message with X mark', () => {
      out.fail('something failed')

      expect(fixture.consoleErrorSpy).toHaveBeenCalledTimes(1)
      const output = fixture.consoleErrorSpy.mock.calls[0][0]
      expect(output).toContain('✗')
      expect(output).toContain('something failed')
    })

    it('should truncate long error messages in TTY mode', () => {
      const prevOut = process.stdout.isTTY
      process.stdout.isTTY = true
      try {
        const longMessage = 'error '.repeat(50)
        out.fail(longMessage)

        const output = fixture.consoleErrorSpy.mock.calls[0][0]
        expect(output.length).toBeLessThan(80)
      } finally {
        process.stdout.isTTY = prevOut
      }
    })

    it('should NOT truncate error messages in non-TTY (agent/pipe) mode', () => {
      const prevOut = process.stdout.isTTY
      const prevErr = process.stderr.isTTY
      process.stdout.isTTY = false as never
      process.stderr.isTTY = false as never
      try {
        const longMessage = 'error '.repeat(50)
        out.fail(longMessage)

        const output = fixture.consoleErrorSpy.mock.calls[0][0]
        expect(output).toContain(longMessage.trim())
      } finally {
        process.stdout.isTTY = prevOut
        process.stderr.isTTY = prevErr
      }
    })

    it('should return self for chaining', () => {
      const result = out.fail('test')
      expect(result).toBe(out)
    })
  })

  describe('warn()', () => {
    it('should output warning message with warning symbol', () => {
      out.warn('be careful')

      expect(fixture.consoleLogSpy).toHaveBeenCalledTimes(1)
      const output = fixture.consoleLogSpy.mock.calls[0][0]
      expect(output).toContain('⚠')
      expect(output).toContain('be careful')
    })

    it('should return self for chaining', () => {
      const result = out.warn('test')
      expect(result).toBe(out)
    })
  })

  describe('spin()', () => {
    it('should start spinner with message', async () => {
      out.spin('loading')

      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(fixture.stdoutWriteSpy).toHaveBeenCalled()
      const output = fixture.stdoutWriteSpy.mock.calls[0][0]
      expect(output).toContain('loading')

      out.stop()
    })

    it('should return self for chaining', () => {
      const result = out.spin('test')
      out.stop()
      expect(result).toBe(out)
    })
  })

  describe('stop()', () => {
    it('should stop spinner and clear line', async () => {
      out.spin('loading')
      await new Promise((resolve) => setTimeout(resolve, 150))

      fixture.stdoutWriteSpy.mockClear()
      out.stop()

      // In TTY, stop() writes a clear sequence; in non-TTY, spinner doesn't
      // use setInterval so stop() is a no-op (clear skips in non-TTY)
      if (process.stdout.isTTY) {
        expect(fixture.stdoutWriteSpy).toHaveBeenCalled()
      } else {
        expect(fixture.stdoutWriteSpy).not.toHaveBeenCalled()
      }
    })

    it('should be safe to call multiple times', () => {
      expect(() => {
        out.stop()
        out.stop()
        out.stop()
      }).not.toThrow()
    })

    it('should return self for chaining', () => {
      const result = out.stop()
      expect(result).toBe(out)
    })
  })

  describe('edge cases', () => {
    it('should handle empty messages', () => {
      expect(() => out.done('')).not.toThrow()
      expect(() => out.fail('')).not.toThrow()
      expect(() => out.warn('')).not.toThrow()
    })

    it('should handle null/undefined messages', () => {
      expect(() => out.done(null as unknown as string)).not.toThrow()
      expect(() => out.done(undefined as unknown as string)).not.toThrow()
    })

    it('should handle messages with special characters', () => {
      out.done('test with émojis 🎉 and spëcial çhars')
      expect(fixture.consoleLogSpy).toHaveBeenCalled()
    })
  })

  describe('Output Tiers', () => {
    afterEach(() => {
      setOutputTier('compact') // Reset to default
    })

    it('should have correct tier configs', () => {
      expect(OUTPUT_TIERS.silent.maxLines).toBe(0)
      expect(OUTPUT_TIERS.minimal.maxLines).toBe(1)
      expect(OUTPUT_TIERS.compact.maxLines).toBe(4)
      expect(OUTPUT_TIERS.verbose.maxLines).toBe(Infinity)
    })

    it('should get and set output tier', () => {
      setOutputTier('verbose')
      expect(getOutputTier()).toBe('verbose')

      setOutputTier('minimal')
      expect(getOutputTier()).toBe('minimal')
    })

    it('should return correct tier config', () => {
      setOutputTier('compact')
      const config = getTierConfig()
      expect(config.maxLines).toBe(4)
      expect(config.maxCharsPerLine).toBe(80)
      expect(config.showMetrics).toBe(true)
    })
  })

  describe('limitLines()', () => {
    it('should limit content to maxLines', () => {
      setOutputTier('compact') // maxLines = 4
      const content = 'line1\nline2\nline3\nline4\nline5\nline6'
      const result = limitLines(content)

      expect(result.split('\n').length).toBe(5) // 4 lines + "...2 more lines"
      expect(result).toContain('...2 more lines')
    })

    it('should not truncate if under limit', () => {
      setOutputTier('compact')
      const content = 'line1\nline2'
      const result = limitLines(content)

      expect(result).toBe(content)
    })

    it('should respect custom maxLines parameter', () => {
      const content = 'line1\nline2\nline3\nline4'
      const result = limitLines(content, 2)

      expect(result.split('\n').length).toBe(3) // 2 lines + indicator
      expect(result).toContain('...2 more lines')
    })

    it('should return content unchanged for verbose tier', () => {
      setOutputTier('verbose')
      const content = 'line1\nline2\nline3\nline4\nline5'
      const result = limitLines(content)

      expect(result).toBe(content)
    })
  })

  describe('formatForHuman()', () => {
    afterEach(() => {
      setOutputTier('compact')
    })

    it('should format Linear issue object', () => {
      const issue = {
        identifier: 'PRJ-123',
        title: 'Test issue title',
        status: 'in_progress',
        priority: 'high',
        url: 'https://linear.app/test',
      }

      const result = formatForHuman(issue)
      expect(result).toContain('PRJ-123')
      expect(result).toContain('Test issue title')
      expect(result).toContain('in_progress')
    })

    it('should format issue list', () => {
      const list = {
        issues: [
          { identifier: 'PRJ-1', title: 'First issue', priority: 'high' },
          { identifier: 'PRJ-2', title: 'Second issue', priority: 'none' },
        ],
      }

      const result = formatForHuman(list)
      expect(result).toContain('PRJ-1')
      expect(result).toContain('PRJ-2')
    })

    it('should return empty string for silent tier', () => {
      setOutputTier('silent')
      const result = formatForHuman({ test: 'data' })
      expect(result).toBe('')
    })

    it('should return full JSON for verbose tier', () => {
      setOutputTier('verbose')
      const data = { test: 'data', nested: { key: 'value' } }
      const result = formatForHuman(data)
      expect(result).toBe(JSON.stringify(data, null, 2))
    })
  })
})
