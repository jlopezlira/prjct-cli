/**
 * Single source of truth for routing `prjct spec [<sub-verb>] [args...]`
 * into the right SDD method on PrjctCommands.
 *
 * Previously this routing was duplicated in TWO places — `routeSpec` in
 * core/index.ts (direct CLI path) and `routeSpecDaemon` in
 * core/daemon/dispatch.ts (daemon path). They drifted silently:
 *   - both omitted `breakdown` from `knownSubverbs`, so `spec breakdown`
 *     was misrouted to "create a spec titled 'breakdown …'";
 *   - the daemon path passed `undefined` as cwd to every spec method, so
 *     spec commands resolved against the DAEMON's cwd, not the project the
 *     request came from — a latent "works in terminal, broken via daemon"
 *     correctness bug.
 *
 * One router, taking an explicit `cwd`, consumed by both call sites, makes
 * those whole bug classes impossible. A parity test pins it.
 */

import type { CommandResult } from '../types/commands'
import type { PrjctCommands } from './commands'

/** Sub-verbs that route to a dedicated SDD method. Anything else is a
 *  draft title (`prjct spec "rate limiting"` ergonomics). */
export const SPEC_SUBVERBS = new Set([
  'list',
  'show',
  'update',
  'apply-delta',
  'set-status',
  'record-review',
  'link-task',
  'ship',
  'audit',
  'validate',
  'breakdown',
  'inventory',
])

/** Friendly aliases: there is no `draft` subverb — `prjct spec "<title>"`
 *  IS the draft action — but agents/users routinely type
 *  `prjct spec draft "x"` (and `new`/`create`). Strip the leading word so
 *  the title isn't polluted with literal "draft x". */
export const SPEC_DRAFT_ALIASES = new Set(['draft', 'new', 'create'])

/**
 * Route spec sub-commands. `tokens` are the already-split positional args
 * (e.g. `['update', 'spec_3', ...]`); `cwd` is the project the request
 * originated from (the user's cwd, NOT the daemon's).
 */
export async function routeSpec(
  commands: PrjctCommands,
  tokens: string[],
  options: Record<string, string | boolean>,
  cwd: string
): Promise<CommandResult> {
  const md = options.md === true
  const sub = tokens[0]
  const rest = tokens.slice(1).join(' ') || null
  const fullTitle = tokens.join(' ') || null

  const draftOpts = {
    md,
    goal: options.goal ? String(options.goal) : undefined,
    tags: options.tags ? String(options.tags) : undefined,
  }

  if (sub && SPEC_DRAFT_ALIASES.has(sub)) {
    return commands.spec(rest, cwd, draftOpts)
  }
  if (!sub || !SPEC_SUBVERBS.has(sub)) {
    return commands.spec(fullTitle, cwd, draftOpts)
  }

  switch (sub) {
    case 'list':
      return commands.specList(cwd, {
        md,
        status: options.status ? String(options.status) : undefined,
      })
    case 'show':
      return commands.specShow(rest, cwd, { md })
    case 'update':
      return commands.specUpdate(rest, cwd, {
        md,
        json: options.json ? String(options.json) : undefined,
      })
    case 'apply-delta':
      // `--md` doubles as the inline-delta payload for this subverb (string),
      // so it is forwarded raw instead of reduced to the output-mode boolean.
      return commands.specApplyDelta(rest, cwd, {
        md: options.md,
        file: options.file ? String(options.file) : undefined,
      })
    case 'set-status':
      return commands.specSetStatus(rest, cwd, {
        md,
        status: options.status ? String(options.status) : undefined,
      })
    case 'record-review':
      return commands.specRecordReview(rest, cwd, {
        md,
        reviewer: options.reviewer ? String(options.reviewer) : undefined,
        verdict: options.verdict ? String(options.verdict) : undefined,
        notes: options.notes ? String(options.notes) : undefined,
      })
    case 'link-task':
      return commands.specLinkTask(rest, cwd, {
        md,
        taskId: options['task-id'] ? String(options['task-id']) : undefined,
      })
    case 'ship':
      return commands.specShip(rest, cwd, {
        md,
        pr: options.pr ? String(options.pr) : undefined,
      })
    case 'audit':
      return commands.specAudit(rest, cwd, {
        md,
        lenses: options.lenses ? String(options.lenses) : undefined,
        strict: options.strict === true,
      })
    case 'validate':
      return commands.specValidate(rest, cwd, { md, strict: options.strict === true })
    case 'breakdown':
      return commands.specBreakdown(rest, cwd, { md, force: options.force === true })
    case 'inventory':
      return commands.specInventory(cwd, { md, json: options.json === true })
    default:
      return { success: false, error: `unknown spec subverb: ${sub}` }
  }
}
