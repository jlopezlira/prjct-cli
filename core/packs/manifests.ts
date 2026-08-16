/**
 * Pack manifests — declarative signals, never prescriptive logic.
 *
 * A pack tells prjct (and by extension Claude) **what exists** in this
 * project context — which memory types are in play, which workflow
 * slots are expected, which MCPs this persona leans on. It never
 * dictates HOW to use any of it. Workflow scripts are authored on
 * demand (by Claude or the human), not pre-seeded here.
 *
 * If you find yourself adding `steps`, `pipelines`, or numbered
 * sequences to this file, stop. That's harness. Slots declare a name
 * + description; the implementation lives in `.prjct/workflows/*.sh`.
 */

export interface WorkflowSlot {
  description: string
}

export interface HookSignal {
  /** Which Claude Code hook event this signal augments. */
  event: 'UserPromptSubmit' | 'SessionStart' | 'SubagentStart'
  /**
   * Regex pattern matched against the prompt/source. If matches, the
   * `inject` tag filters get added to the default memory recall.
   */
  ifMatches?: string
  /** Tag filters used to select memory entries for injection. */
  inject: string[]
}

export interface PackManifest {
  name: string
  description: string
  /**
   * Semver of this pack definition (marketplace-lite integrity).
   * Bump when memory types, slots, or defaults change.
   */
  version: string
  /** Starting persona if the user accepts suggestions. */
  suggestedPersona?: {
    role: string
    focus?: string
    mcps?: string[]
  }
  /** Memory types this pack unlocks beyond the base 7. */
  memoryTypes: string[]
  /** Empty workflow slots the user or Claude can fill in on demand. */
  workflowSlots: Record<string, WorkflowSlot>
  /** Hook-level signals for topical recall. */
  hookSignals: HookSignal[]
  /** Free-form tag suggestions for autocomplete consistency. */
  suggestedTags?: Record<string, string[]>
  /**
   * Config defaults applied on first activation only (never overwrites
   * user-set sdd/tdd/loop budgets).
   */
  configDefaults?: {
    sdd?: 'off' | 'advisory' | 'strict'
    tdd?: 'off' | 'assist' | 'strict'
    maxTurnsPerCycle?: number
    deliveryGeometry?: 'off' | 'advisory' | 'strict'
    land?: 'off' | 'advisory' | 'strict'
    /** Closed-loop conflict gate default (first activation only). */
    conflictMode?: 'off' | 'advisory' | 'strict'
  }
}

/**
 * Shared signals between `code` and `code-strict` — both packs declare the
 * same persona, memory types, workflow slots, and hook signals; they only
 * diverge on config strictness (and code's extra suggestedTags). Keeping
 * this as one literal means the two packs can't silently drift apart.
 */
const CODE_PACK_BASE: Pick<
  PackManifest,
  'suggestedPersona' | 'memoryTypes' | 'workflowSlots' | 'hookSignals'
> = {
  suggestedPersona: {
    role: 'DEV',
    mcps: ['github'],
  },
  memoryTypes: ['fact', 'decision', 'learning', 'gotcha', 'pattern', 'anti-pattern', 'shipped'],
  workflowSlots: {
    ship: { description: 'Publish finished work — tests, commit, push, PR.' },
    review: { description: 'Pre-commit or pre-PR review pass.' },
  },
  hookSignals: [],
}

export const PACK_MANIFESTS: Record<string, PackManifest> = {
  code: {
    name: 'code',
    version: '1.1.0',
    description: 'Coding work: features, bugs, refactors, TDD, shipping.',
    ...CODE_PACK_BASE,
    suggestedTags: {
      domain: ['auth', 'api', 'frontend', 'infra', 'data'],
    },
    configDefaults: {
      sdd: 'advisory',
      tdd: 'assist',
      maxTurnsPerCycle: 25,
      deliveryGeometry: 'advisory',
      // Session-close is not optional on code packs (gentle-ai land ritual,
      // code-enforced cue via land-cue + Stop).
      land: 'strict',
      // SUPERIOR: conflict gate on by default for code (not off).
      conflictMode: 'advisory',
    },
  },

  'code-strict': {
    name: 'code-strict',
    version: '1.1.0',
    description: 'Ship-grade coding: SDD+TDD strict, delivery-geometry gate, forced land. Opt-in.',
    ...CODE_PACK_BASE,
    configDefaults: {
      sdd: 'strict',
      tdd: 'strict',
      maxTurnsPerCycle: 25,
      deliveryGeometry: 'strict',
      land: 'strict',
      conflictMode: 'strict',
    },
  },

  daily: {
    name: 'daily',
    version: '1.0.0',
    description: 'Day-to-day capture + review. GTD-style inbox + weekly review.',
    memoryTypes: ['inbox', 'todo', 'idea'],
    workflowSlots: {
      morning: { description: 'Morning briefing — pull open todos + upcoming commitments.' },
      clarify: { description: 'Reclassify inbox entries to real memory types.' },
      review: { description: 'Weekly/biweekly review across memory.' },
    },
    hookSignals: [],
  },

  pm: {
    name: 'pm',
    version: '1.0.0',
    description: 'Product Management: specs, user interviews, roadmap, backlog triage.',
    suggestedPersona: {
      role: 'PM',
      mcps: ['linear', 'posthog'],
    },
    memoryTypes: ['insight', 'question', 'stakeholder', 'decision', 'source'],
    workflowSlots: {
      spec: { description: 'Draft a technical/product spec from captured insights.' },
      triage: { description: 'Review Linear backlog and prioritize.' },
      interview: { description: 'User interview pre-brief + post-synthesis.' },
    },
    hookSignals: [
      {
        event: 'UserPromptSubmit',
        ifMatches: 'spec|requirements?|prd',
        inject: ['type=insight', 'type=question'],
      },
    ],
    suggestedTags: {
      audience: ['team', 'stakeholders'],
      quarter: ['q1', 'q2', 'q3', 'q4'],
    },
  },

  founder: {
    name: 'founder',
    version: '1.0.0',
    description: 'Founder ops: strategy, fundraising, hiring, stakeholder comms.',
    suggestedPersona: {
      role: 'Founder',
      mcps: ['gmail', 'linear', 'posthog'],
    },
    memoryTypes: ['goal', 'okr', 'person', 'stakeholder', 'decision', 'shipped'],
    workflowSlots: {
      'investor-update': { description: 'Monthly investor update draft.' },
      '1on1': { description: '1:1 prep + synthesis.' },
      strategy: { description: 'Strategy checkpoint — OKR progress + pivots.' },
    },
    hookSignals: [
      {
        event: 'UserPromptSubmit',
        ifMatches: 'investor|board|update|fundrais',
        inject: ['type=okr', 'type=shipped', 'type=stakeholder'],
      },
    ],
    suggestedTags: {
      audience: ['board', 'investors', 'team'],
    },
  },

  lean: {
    name: 'lean',
    version: '1.0.0',
    description: 'Anti-over-engineering: minimal-code review, debt ledger, intensity modes.',
    memoryTypes: ['over-engineering', 'lean-debt'],
    workflowSlots: {
      review: { description: 'Flag over-engineering in the current diff.' },
      audit: { description: 'Repo-wide over-engineering assessment.' },
      debt: { description: 'Harvest deferred-simplification (lean:) markers.' },
    },
    hookSignals: [
      {
        event: 'UserPromptSubmit',
        ifMatches: 'simplif|over-?engineer|yagni|too complex|leaner',
        inject: ['type=over-engineering', 'type=lean-debt'],
      },
    ],
    suggestedTags: {
      intensity: ['lite', 'full', 'ultra'],
    },
  },

  research: {
    name: 'research',
    version: '1.0.0',
    description: 'Research: deep-dives, literature review, competitive scans.',
    suggestedPersona: {
      role: 'Research',
      mcps: ['web'],
    },
    memoryTypes: ['source', 'claim', 'question', 'insight'],
    workflowSlots: {
      'lit-review': { description: 'Literature review across captured sources.' },
      analyze: { description: 'Data analysis run via MCP, persist findings.' },
    },
    hookSignals: [],
    suggestedTags: {
      confidence: ['high', 'medium', 'low'],
    },
  },
}

export const PACK_NAMES = Object.keys(PACK_MANIFESTS) as Array<keyof typeof PACK_MANIFESTS>

export function getPackManifest(name: string): PackManifest | null {
  return PACK_MANIFESTS[name] ?? null
}

/**
 * Aggregate memory types from a set of active packs. Union, unique.
 * Base types (fact/decision/learning/gotcha/pattern/anti-pattern/shipped)
 * are always available — this just reports what each pack *adds on top*.
 */
export function aggregateMemoryTypes(packNames: string[]): string[] {
  const out = new Set<string>()
  for (const name of packNames) {
    const m = PACK_MANIFESTS[name]
    if (!m) continue
    for (const t of m.memoryTypes) out.add(t)
  }
  return [...out].sort()
}

/**
 * Aggregate workflow slots. If two packs declare the same slot name, the
 * first-listed pack wins (so user pack order is meaningful for
 * precedence). Merging logic lives here so callers don't reimplement.
 */
export function aggregateSlots(
  packNames: string[]
): Record<string, WorkflowSlot & { pack: string }> {
  const out: Record<string, WorkflowSlot & { pack: string }> = {}
  for (const name of packNames) {
    const m = PACK_MANIFESTS[name]
    if (!m) continue
    for (const [slot, body] of Object.entries(m.workflowSlots)) {
      if (!out[slot]) out[slot] = { ...body, pack: name }
    }
  }
  return out
}
