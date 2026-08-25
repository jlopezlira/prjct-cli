/**
 * Template Generator
 *
 * Dynamically generates workflow templates for custom workflows.
 * Templates are created at ~/.claude/commands/p/{workflow-name}.md
 *
 * Architecture:
 * - Templates are thin wrappers that call `prjct run {workflow} --md`
 * - All workflow logic lives in the CLI (via workflow rules)
 * - Templates preserve agentic intelligence (can explore, ask questions, plan)
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { getErrorMessage, isNotFoundError } from '../types/fs'
import { fileExists } from '../utils/file-helper'
import { resolveUserPath } from './user-home'

class TemplateGenerator {
  private commandsPath: string

  constructor() {
    // Templates are installed in ~/.claude/commands/p/
    this.commandsPath = resolveUserPath('.claude', 'commands', 'p')
  }

  /**
   * Generate workflow template at ~/.claude/commands/p/{name}.md
   */
  async generateWorkflowTemplate(
    workflowName: string,
    description: string
  ): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      await fs.mkdir(this.commandsPath, { recursive: true })

      const templatePath = path.join(this.commandsPath, `${workflowName}.md`)
      const content = this.buildTemplateContent(workflowName, description)

      await fs.writeFile(templatePath, content, 'utf-8')

      return { success: true, path: templatePath }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  }

  /**
   * Delete workflow template from ~/.claude/commands/p/{name}.md
   */
  async deleteWorkflowTemplate(
    workflowName: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const templatePath = path.join(this.commandsPath, `${workflowName}.md`)

      await fs.unlink(templatePath)

      return { success: true }
    } catch (error) {
      if (isNotFoundError(error)) {
        // File doesn't exist - that's okay for deletion
        return { success: true }
      }
      return { success: false, error: getErrorMessage(error) }
    }
  }

  /**
   * Check if a workflow template exists
   */
  async templateExists(workflowName: string): Promise<boolean> {
    const templatePath = path.join(this.commandsPath, `${workflowName}.md`)
    return fileExists(templatePath)
  }

  /**
   * Build template content for a custom workflow.
   * Templates are thin wrappers that delegate to CLI.
   */
  private buildTemplateContent(name: string, desc: string): string {
    return `---
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, Task, AskUserQuestion]
---

# p. ${name} $ARGUMENTS

## Description
${desc}

## Step 1: Get workflow context

Execute the workflow to get current configuration:

\`\`\`bash
prjct workflow run ${name} --md
\`\`\`

## Step 2: Execute workflow

The CLI will execute all configured rules for this workflow:

- **Gates** (before) - must pass to continue
- **Hooks** (before/after) - run but don't block
- **Steps** (before/after) - blocking execution

## Step 3: Review results

Present the workflow execution results to the user. If gates failed, explain which checks didn't pass and suggest next steps.

## Next Steps

Suggest relevant actions based on the workflow results:

- View rules: \`prjct workflow ${name} --md\`
- Add rules: \`prjct workflow add "command" before ${name} --md\`
- Run again: \`p. ${name}\`
`
  }
}

// Singleton export
export const templateGenerator = new TemplateGenerator()
