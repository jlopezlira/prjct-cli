/**
 * Precision classifier — hard gate before a capture graduates to a public
 * judgment type (spec / gotcha / low-stakes inbox surfaces).
 *
 * Pure + deterministic + zero I/O. Must never fail-open: callers that cannot
 * run this still own their own error paths; this module always returns a
 * verdict.
 *
 * Contract fields for future consumers (intake / RiskClaim renderers):
 *   reasonCode · action · demoteTo · (mem_id assigned at write)
 *
 * Does NOT replace isJunkCaptureContent (tool dumps / noise phrases) — that
 * runs first. This layer catches *typed* pollution: empty specs, open
 * narration labeled as gotcha, sub-substance inbox that would pollute brief.
 */

import { isJunkCaptureContent } from '../services/capture-junk'

/** Stable reason codes — machine-queryable, never free prose alone. */
export type PrecisionReasonCode =
  | 'ok'
  | 'forced'
  | 'empty_content'
  | 'junk'
  | 'empty_spec_mirror'
  | 'bare_id_body'
  | 'gotcha_open_narration'
  | 'gotcha_is_red_herring'
  | 'inbox_no_substance'

export type PrecisionAction = 'accept' | 'refuse' | 'demote'

export interface PrecisionVerdict {
  action: PrecisionAction
  reasonCode: PrecisionReasonCode
  reason: string
  /** When action === 'demote', store as this type instead. */
  demoteTo?: string
}

export interface PrecisionClassifyOpts {
  /** Spec title when known separately from body. */
  title?: string
  /** Spec goal when known separately from body. */
  goal?: string
  /** Bypass shape gates (audit tag should be applied by caller). */
  force?: boolean
}

const LOW_STAKES = new Set(['inbox', 'todo', 'idea', 'question'])

/** UUID / hex / opaque id token (no prose). */
const BARE_ID_RE =
  /^(?:get\s+)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^[0-9a-f]{16,64}$|^[a-z]*[_-]?[0-9a-f]{8,}$/i

/** Action verbs that make a goal more than a lookup label. */
const ACTION_VERB_RE =
  /\b(add|build|create|fix|implement|migrate|refactor|remove|replace|ship|support|enable|disable|update|upgrade|design|audit|verify|ensure|prevent|allow|block|wire|integrate|document|test|measure|reduce|increase|hacer|agregar|crear|arreglar|implementar|migrar|eliminar|actualizar|soportar|permitir|bloquear|integrar|documentar|verificar|evitar)\b/i

/** Closed-knowledge markers (cause → resolution / past trap). */
const CLOSED_GOTCHA_RE =
  /\b(was|were|wasn't|weren't|had been|used to|era|eran|fue|fueron|estaba|estaban|fixed|fix:|resolved|root cause|because|caused|broke|broken|failed|failure|don't|do not|never|always|must not|must never|sin\s+eso|no era|no fue|no es rls|wasn't|instead|rather than|anti-pattern|gotcha:|trap:)\b/i

/** Open narration / in-progress intent (not knowledge yet). */
const OPEN_NARRATION_RE =
  /^(reviso|revisando|voy a|estoy|vamos a|i('ll| will)|i am |i'm |checking|looking at|let me |need to |tengo que |hay que |todo:|wip:)/i

/**
 * Negative knowledge — discarded investigated cause (not-the-cause).
 * Require discard-of-cause framing + resolution signal; block common FPs
 * ("no era necesario", "wasn't hard", domain scoping "no es X-related").
 */
const RED_HERRING_FP_RE =
  /\b(no era necesario|no era necesaria|no fue necesario|wasn't hard|was not hard|wasn't easy|was not easy|wasn't difficult|no fue difícil|wasn't necessary|was not necessary)\b/i

/** Discarded-cause phrasing (hypothesis that was wrong). */
const RED_HERRING_DISCARD_RE =
  /\b(no era rls|no fue rls|no es rls|not the cause|red herring|false lead|not an? rls\b|not a(?:n)? rls\b|is not (?:an? )?rls(?:\s+bug)?|was not (?:an? )?rls(?:\s+bug)?|this is not (?:an? )?(?:rls|auth)|is not the bottleneck|not the bottleneck)\b/i

/** "No era X" / "wasn't X" where X looks like a technical cause noun (not "necesario"/"hard"). */
const RED_HERRING_NO_ERA_TECH_RE =
  /\b(?:no era|no fue)\s+(?!necesario|necesaria|difícil|facil|fácil)([a-z][\w-]{1,40})\b/i

const RED_HERRING_WASNT_TECH_RE =
  /\b(?:wasn't|was not|weren't|were not)\s+(?!hard|easy|difficult|necessary|needed)((?:an?\s+)?[a-z][\w-]{1,40})\b/i

/** Resolution / real-cause / fix — pairs with discard to form negative knowledge. */
const RED_HERRING_RESOLUTION_RE =
  /\b(causa real|root cause|fix:|real cause|was correct|were correct|estaban (?:perfectas|correctas|bien)|already (?:wraps|wrapped)|declare|volatile|instead|en realidad|coincidencia|misleading|actually|policies (?:were|estaban)|can_access_company)\b/i

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Strip common mirror prefixes for comparison. */
function stripGoalPrefix(s: string): string {
  return s.replace(/^goal:\s*/i, '').trim()
}

/**
 * Parse the memory-mirror shape used by spec-service:
 *   `${title}\n\nGoal: ${goal}`
 */
export function parseSpecMirrorContent(content: string): { title: string; goal: string } | null {
  const m = content.trim().match(/^([\s\S]*?)\n\nGoal:\s*([\s\S]+)$/i)
  if (!m) return null
  return { title: m[1]!.trim(), goal: m[2]!.trim() }
}

/**
 * True when title and goal are the same knowledge-free mirror
 * (client: "get 3a9aa714… Goal: get 3a9aa714").
 */
export function isEmptySpecMirror(title: string, goal: string): boolean {
  const t = normalize(title)
  const g = normalize(stripGoalPrefix(goal))
  if (!t || !g) return true
  if (t === g) return true
  // "get <id>" repeated as both sides
  if (
    t.replace(/^get\s+/i, '') === g.replace(/^get\s+/i, '') &&
    BARE_ID_RE.test(g.replace(/^get\s+/i, ''))
  ) {
    return true
  }
  return false
}

/** Body is essentially an id/UUID with no action verb — not a spec goal. */
export function isBareIdBody(text: string): boolean {
  const n = normalize(stripGoalPrefix(text))
  if (!n) return true
  if (BARE_ID_RE.test(n)) return true
  // "get <uuid>" / "show mem_123" style lookups
  if (/^(get|show|open|fetch|load|ver|obtener)\s+\S+$/i.test(n) && !ACTION_VERB_RE.test(n)) {
    const rest = n.replace(/^(get|show|open|fetch|load|ver|obtener)\s+/i, '')
    if (BARE_ID_RE.test(rest) || /^[a-z0-9_-]{8,}$/i.test(rest)) return true
  }
  return false
}

/**
 * Gotcha must look like closed knowledge, not live narration.
 * Open: present/future intent, trailing open colon, no cause→fix signals.
 */
export function isOpenGotchaNarration(content: string): boolean {
  const raw = content.trim()
  if (!raw) return true
  const flat = raw.replace(/\s+/g, ' ')

  // Explicit open colon at end ("Reviso X:") without closed body after.
  if (/:\s*$/.test(flat) && !CLOSED_GOTCHA_RE.test(flat)) return true

  if (OPEN_NARRATION_RE.test(flat) && !CLOSED_GOTCHA_RE.test(flat)) return true

  // No closed markers and very short present-tense review → not a gotcha.
  if (
    !CLOSED_GOTCHA_RE.test(flat) &&
    flat.length < 80 &&
    /^(reviso|checking|looking)\b/i.test(flat)
  ) {
    return true
  }

  return false
}

/**
 * True when content is closed negative knowledge (discarded cause → real cause/fix).
 * Used to retype gotcha → red-herring without catching decisions/scoping/difficulty.
 */
export function looksLikeRedHerring(content: string): boolean {
  const flat = content.trim().replace(/\s+/g, ' ')
  if (!flat || RED_HERRING_FP_RE.test(flat)) return false

  // Domain scoping only: "no es X-related, es frontend" without investigation outcome
  if (
    /\bno es\s+[\w-]+-related\b/i.test(flat) &&
    !/\b(causa real|root cause|fix:|was correct|were correct|policies)\b/i.test(flat)
  ) {
    return false
  }

  const discarded =
    RED_HERRING_DISCARD_RE.test(flat) ||
    RED_HERRING_NO_ERA_TECH_RE.test(flat) ||
    (RED_HERRING_WASNT_TECH_RE.test(flat) && !/\bwasn't hard\b/i.test(flat))

  if (!discarded) return false

  // Prefer discard + resolution pair; allow strong discard alone (explicit "not the cause" / "no era RLS")
  const strongDiscard =
    /\b(no era rls|no fue rls|not the cause|red herring|false lead|not an? rls\b|is not (?:an? )?rls(?:\s+bug)?|this is not (?:an? )?rls)\b/i.test(
      flat
    )
  if (strongDiscard) return true
  return RED_HERRING_RESOLUTION_RE.test(flat) || CLOSED_GOTCHA_RE.test(flat)
}

/**
 * Low-stakes substance floor beyond junk phrases: needs real tokens.
 * "upgrade" is already junk; this catches "do it" / "fix later" fluff.
 */
export function lacksInboxSubstance(content: string): boolean {
  const n = content.trim().replace(/\s+/g, ' ')
  // Align with junk ultra-short floor; allow short two-token notes
  // ("random thought", "call Ana") while still killing "upgrade" / "fix later".
  if (n.length < 12) return true
  const tokens = n.split(' ').filter((t) => t.length > 1)
  if (tokens.length < 2) return true
  // Only stopwords / filler
  const filler = new Set([
    'the',
    'a',
    'an',
    'to',
    'for',
    'and',
    'or',
    'of',
    'in',
    'on',
    'it',
    'this',
    'that',
    'el',
    'la',
    'de',
    'en',
    'y',
    'o',
    'un',
    'una',
    'por',
    'para',
  ])
  const contentTokens = tokens.filter((t) => !filler.has(t.toLowerCase()))
  return contentTokens.length < 2
}

/**
 * Classify whether content may graduate as `type`.
 *
 * Order: empty → force → junk → type-specific shape.
 */
export function classifyCapturePrecision(
  content: string,
  type?: string,
  opts: PrecisionClassifyOpts = {}
): PrecisionVerdict {
  const trimmed = (content ?? '').trim()
  if (!trimmed) {
    return { action: 'refuse', reasonCode: 'empty_content', reason: 'empty content' }
  }

  if (opts.force) {
    return { action: 'accept', reasonCode: 'forced', reason: 'force override' }
  }

  const junk = isJunkCaptureContent(trimmed, type)
  if (junk.junk) {
    return { action: 'refuse', reasonCode: 'junk', reason: `junk capture: ${junk.reason}` }
  }

  // --- Spec graduation ---
  if (type === 'spec') {
    const title = opts.title ?? parseSpecMirrorContent(trimmed)?.title ?? ''
    const goal = opts.goal ?? parseSpecMirrorContent(trimmed)?.goal ?? trimmed

    if (title && goal && isEmptySpecMirror(title, goal)) {
      return {
        action: 'refuse',
        reasonCode: 'empty_spec_mirror',
        reason: 'empty spec: goal identical to title (lookup, not a goal)',
      }
    }
    // Content-only path (mirror or freeform)
    const mirror = parseSpecMirrorContent(trimmed)
    if (mirror && isEmptySpecMirror(mirror.title, mirror.goal)) {
      return {
        action: 'refuse',
        reasonCode: 'empty_spec_mirror',
        reason: 'empty spec: goal identical to title (lookup, not a goal)',
      }
    }
    const goalText = mirror?.goal ?? goal ?? trimmed
    if (isBareIdBody(goalText) && !ACTION_VERB_RE.test(goalText)) {
      return {
        action: 'refuse',
        reasonCode: 'bare_id_body',
        reason: 'empty spec: body is an id/lookup without an action verb',
      }
    }
  }

  // Spec create path with separate title/goal (before type is set)
  if (opts.title !== undefined && opts.goal !== undefined && type === 'spec') {
    // already handled above
  }

  // --- Gotcha shape ---
  if (type === 'gotcha') {
    if (isOpenGotchaNarration(trimmed)) {
      return {
        action: 'demote',
        reasonCode: 'gotcha_open_narration',
        reason: 'open narration is not a gotcha — demote to context',
        demoteTo: 'context',
      }
    }
    // Closed negative knowledge → first-class red-herring (not generic gotcha).
    if (looksLikeRedHerring(trimmed)) {
      return {
        action: 'demote',
        reasonCode: 'gotcha_is_red_herring',
        reason: 'negative knowledge (not-the-cause) — store as red-herring',
        demoteTo: 'red-herring',
      }
    }
  }

  // --- Inbox / low-stakes substance ---
  if (type && LOW_STAKES.has(type) && lacksInboxSubstance(trimmed)) {
    return {
      action: 'refuse',
      reasonCode: 'inbox_no_substance',
      reason: 'sub-substance low-stakes capture — keep out of brief',
    }
  }

  return { action: 'accept', reasonCode: 'ok', reason: 'ok' }
}

/**
 * Spec *table* create gate — ergonomic drafts may seed goal=title
 * (`prjct spec "rate limiting"`). Hard-refuse only lookup/id pollution.
 *
 * Public *memory* graduation still uses {@link classifyCapturePrecision}
 * with type=spec, which refuses empty_spec_mirror so brief surfaces stay clean.
 */
export function classifySpecCreate(title: string, goal: string): PrecisionVerdict {
  const t = title.trim()
  const g = goal.trim()
  if (!t || !g) {
    return { action: 'refuse', reasonCode: 'empty_content', reason: 'empty title or goal' }
  }
  if (isBareIdBody(g) && !ACTION_VERB_RE.test(g)) {
    return {
      action: 'refuse',
      reasonCode: 'bare_id_body',
      reason: 'empty spec: goal is an id/lookup without an action verb',
    }
  }
  // goal===title is a draft seed, not a memory graduation — allow create.
  // Bare "get <uuid>" still fails via isBareIdBody above.
  if (isEmptySpecMirror(t, g) && isBareIdBody(t)) {
    return {
      action: 'refuse',
      reasonCode: 'empty_spec_mirror',
      reason: 'empty spec: goal identical to title (lookup, not a goal)',
    }
  }
  return { action: 'accept', reasonCode: 'ok', reason: 'ok' }
}

/**
 * True when a draft may exist in the specs table but must NOT mirror into
 * living memory as type=spec (goal is still a placeholder).
 */
export function shouldMirrorSpecToMemory(title: string, goal: string): boolean {
  if (isEmptySpecMirror(title, goal)) return false
  if (isBareIdBody(goal) && !ACTION_VERB_RE.test(goal)) return false
  return (
    classifyCapturePrecision(`${title}\n\nGoal: ${goal}`, 'spec', { title, goal }).action ===
    'accept'
  )
}

/**
 * Strip internal pipeline labels from human/LLM-facing text.
 * Storage may still keep structured fields; presentation must not leak
 * "Context synthesis:" as a user-facing prefix.
 */
export function stripPipelineLabelsForHuman(content: string): string {
  if (!content) return content
  return content
    .replace(/^Context synthesis:\s*/i, '')
    .replace(/(\s*[·|]\s*)Context synthesis:\s*/gi, '$1')
    .replace(/^\s*[·|]\s*/, '')
    .trim()
}
