/**
 * Author Detector - Detects author information from multiple sources
 *
 * Detection priority:
 * 1. GitHub CLI (gh api user) - Most reliable for GitHub username
 * 2. Git config (user.name and user.email)
 * 3. Fallback to 'Unknown'
 *
 */

import type { DetectedAuthorInfo } from '../types/infrastructure'
import { execAsync } from '../utils/exec'

// ============ Internal Helpers ============

async function execCommand(command: string): Promise<{ success: boolean; output: string }> {
  try {
    const { stdout } = await execAsync(command, { timeout: 5000 })
    return { success: true, output: stdout.trim() }
  } catch (_error) {
    return { success: false, output: '' }
  }
}

// ============ Detection Functions ============

async function detectGitHubUsername(): Promise<string | null> {
  const cliResult = await execCommand('gh api user --jq .login')
  if (cliResult.success && cliResult.output) return cliResult.output
  const configResult = await execCommand('git config --global github.user')
  return configResult.success && configResult.output ? configResult.output : null
}

async function detectGitName(): Promise<string | null> {
  const result = await execCommand('git config user.name')
  return result.success && result.output ? result.output : null
}

async function detectGitEmail(): Promise<string | null> {
  const result = await execCommand('git config user.email')
  return result.success && result.output ? result.output : null
}

export async function detect(): Promise<DetectedAuthorInfo> {
  const [github, name, email] = await Promise.all([
    detectGitHubUsername(),
    detectGitName(),
    detectGitEmail(),
  ])

  return {
    github,
    email,
    name: name || github || 'Unknown',
  }
}
