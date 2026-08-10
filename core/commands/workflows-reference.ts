/**
 * `prjct workflows` — the quality methodology, pulled on demand from ANY rig.
 *
 * Claude gets this content as `~/.claude/skills/prjct/workflows.md`; every
 * other agent (Codex, Gemini, Cursor, OpenCode, ...) has no skill file to
 * read, so this verb prints the SAME single-source reference (subagent
 * dispatch, model policy, review/judgment/security workflows, decision
 * briefs) straight from the generator. Rig-agnostic by construction — the
 * router files point here instead of inlining methodology.
 */

import { buildPrjctSkillReference } from '../services/skill-generator/prjct-skill-body'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { PrjctCommandsBase } from './base'

export class WorkflowsReferenceCommands extends PrjctCommandsBase {
  async workflows(
    _input: string | null = null,
    _projectPath: string = process.cwd(),
    _options: MdOption = {}
  ): Promise<CommandResult> {
    // Markdown either way — the content IS markdown; --md changes nothing.
    console.log(buildPrjctSkillReference())
    return { success: true }
  }
}
