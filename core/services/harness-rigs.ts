/**
 * Harness creation paths — the two ways to build the Body (Phase C).
 *
 *   1. INDUCTION — you did a flow once by hand; prjct emits a dispatch telling
 *      the host to analyze that flow and synthesize repeatable organs (a
 *      command/workflow, a skill recipe, gates), then PERSIST them via prjct
 *      verbs. prjct describes; the host does the LLM work and persists.
 *   2. STEAL-A-RIG — adopt an existing open-source rig as the Body's base.
 *      prjct emits the adoption plan (which organs to install, via which verbs).
 *
 * Both are pure renderers (no execution) — the anti-harness contract: prjct
 * names WHERE the work lives + the verbs to persist it; the host runs it.
 */

export interface InductionContext {
  /** The active work cycle's intent, if any — the flow just performed. */
  activeCycle?: string | null
  /** Whether the project is a git repo (so we can point at git history). */
  hasGit: boolean
}

/**
 * The induction dispatch: point the host at the just-performed flow, have it
 * synthesize harness organs, and persist them through prjct verbs.
 */
export function buildInductionDispatch(ctx: InductionContext): string {
  const flowLine = ctx.activeCycle
    ? `The flow you just performed: **${ctx.activeCycle}**.`
    : 'The flow you just performed (read it from the sources below).'
  const read = [
    ctx.hasGit ? '- `git log --oneline -20` + `git diff` — the concrete edits you made.' : null,
    '- `prjct work --md` — the work cycle + related context.',
    '- `prjct search "<topic>"` / `prjct context memory <topic>` — decisions/gotchas/learnings captured.',
  ]
    .filter(Boolean)
    .join('\n')
  return `${[
    '# prjct harness — induction (learn from what you just did)',
    '',
    flowLine,
    'Read it from prjct (never assume — pull):',
    read,
    '',
    'Then SYNTHESIZE the repeatable organs of the harness and PERSIST each through prjct (prjct owns the Body; you build + persist, it stores):',
    '',
    '1. **Command / workflow** — the repeatable procedure. Register it: `prjct workflow create <name> "<what it does>"`, then add each step with `prjct workflow add "<status:<value>|script:<path>|git:commit>" before <task|ship|sync>`.',
    '2. **Skill recipe** — the judgment/how-to that is NOT a fixed script. Capture it as durable knowledge: `prjct remember learning "<the recipe/heuristic>"` (and `prjct remember decision "<choice + why>"` for any fork resolved).',
    '3. **Gates (Stop-Slop)** — what must be true before "done": add a blocking check with `prjct workflow gate ship "verify:auto"` (or `prjct workflow gate ship "<your test command>"`) so it runs every time.',
    '4. **Roster** — if the flow needed specialists, note which review lenses it raised (architecture + security/data/perf/design/strategic) so future runs compose them.',
    '',
    'Keep each organ MODEL-AGNOSTIC: name verbs and capabilities, never a specific model. Persist ONLY through prjct verbs — SQLite is the only surface.',
  ].join('\n')}\n`
}

export interface RigOrgan {
  organ: 'knowledge-base' | 'skills-commands' | 'agent-catalog' | 'stop-slop'
  /** How to install this organ into prjct, as prjct verbs. */
  install: string
}

export interface RigTemplate {
  name: string
  description: string
  source: string
  organs: RigOrgan[]
}

/**
 * Curated rigs you can steal as a base. Each names the organs it brings and the
 * prjct verbs to install them — model-agnostic, owned in prjct once adopted.
 */
export const RIGS: readonly RigTemplate[] = [
  {
    name: 'safe-agentic-workflow',
    description:
      'A cautious build→review→ship rig: intent brief, dynamic review specialists, and a verify gate before ship.',
    source: 'https://github.com/safe-agentic-workflow',
    organs: [
      {
        organ: 'agent-catalog',
        install:
          'prjct crew install — leader/implementer + review specialists composed per change.',
      },
      {
        organ: 'stop-slop',
        install:
          'prjct crew checkpoints set --content "<acceptance bar>" + `prjct workflow gate ship "verify:auto"`.',
      },
      {
        organ: 'knowledge-base',
        install: 'prjct remember framework "<the workflow\'s operating principles>".',
      },
    ],
  },
  {
    name: 'solo-sovereign',
    description:
      'A single-agent rig for non-Claude / local models: emulated crew (one agent plays the roles) + a KB + verify gate. Maximum portability.',
    source: 'built-in',
    organs: [
      {
        organ: 'agent-catalog',
        install:
          'prjct crew install — on a non-Claude rig this stores the emulated crew protocol in project SQLite (no repo files).',
      },
      {
        organ: 'knowledge-base',
        install: 'prjct remember identity/voice/glossary "<who you are + terms>".',
      },
      { organ: 'stop-slop', install: 'prjct workflow gate ship "verify:auto".' },
    ],
  },
  {
    name: 'grok-build',
    description:
      'Grok as Brain, prjct as Body: multi-host skill/MCP projection, plan-mode approval gate, crew checkpoints, and SQLite memory (Grok memory is experimental). Steal patterns from the open Grok Build harness — not the Rust agent loop.',
    source: 'https://github.com/xai-org/grok-build',
    organs: [
      {
        organ: 'skills-commands',
        install:
          'prjct install — native ~/.grok/config.toml MCP + ~/.grok/skills/prjct + ~/.grok/plugins/prjct; hooks still via Claude compat. Keep AGENTS.md + MCP prjct_* as the portable contract.',
      },
      {
        organ: 'knowledge-base',
        install:
          'prjct remember decision/learning/gotcha — prjct SQLite is the durable memory plane; do not rely on Grok experimental memory alone.',
      },
      {
        organ: 'agent-catalog',
        install:
          'prjct crew install + `prjct plan` ceremony (draft read-only until `prjct plan approve`) before implementer edits on ambiguous work.',
      },
      {
        organ: 'stop-slop',
        install:
          'prjct crew checkpoints set + `prjct workflow gate ship "verify:auto"`; map delivery-geometry tier to host permission mode advice (default/dontAsk/acceptEdits) without owning OS sandbox.',
      },
    ],
  },
]

export function findRig(name: string): RigTemplate | undefined {
  return RIGS.find((r) => r.name === name.trim().toLowerCase())
}

/** List the stealable rigs as markdown. */
export function renderRigList(): string {
  return `${[
    '# prjct harness — rigs you can steal',
    '',
    "Adopt one as your Body's base: `prjct harness use <name>`.",
    '',
    ...RIGS.map((r) => `- **${r.name}** — ${r.description}`),
  ].join('\n')}\n`
}

/** The adoption plan for a rig: which organs, installed via which prjct verbs. */
export function renderRigAdoption(rig: RigTemplate): string {
  return `${[
    `# prjct harness — adopt rig: ${rig.name}`,
    '',
    rig.description,
    `Source: ${rig.source}`,
    '',
    'Install its organs into prjct (owned in SQLite, then projected to your host):',
    '',
    ...rig.organs.map((o) => `- **${o.organ}** — ${o.install}`),
    '',
    'After adopting, the rig is YOURS: model-agnostic, owned in prjct, re-projected when you swap the Brain.',
  ].join('\n')}\n`
}
