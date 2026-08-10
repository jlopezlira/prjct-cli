/**
 * Living context synthesis contract.
 *
 * Product behavior, not a repo-local convention: every project that installs
 * prjct gets the same context shape when work closes. The executing model is
 * the synthesizer because it has the freshest task state, user sentiment, code
 * edits, and tool outcomes. Automatic detectors are only inputs.
 */

export const LIVING_CONTEXT_FIELDS = [
  'Context synthesis',
  'Key data',
  'What happened',
  'Why it mattered',
  'Who/author',
  'Model',
  'Token usage',
  'Sentiment',
  'Related files',
  'Feature/domain',
  'Pattern',
  'Anti-pattern',
  'Decision/trap',
  'Outcome',
  'Next implication',
] as const

export const LIVING_CONTEXT_FIELD_LIST = LIVING_CONTEXT_FIELDS.join(' · ')

export const LIVING_CONTEXT_SYNTHESIS_GUIDANCE =
  'Living context synthesis: the same model that just executed the task writes durable project context while fresh. ' +
  `Capture: ${LIVING_CONTEXT_FIELD_LIST}. ` +
  'Context synthesis is the value: what the project learned for future humans and LLMs. ' +
  'Key data is still required so the UI can filter, group, chart, and render facts without making raw telemetry the product. ' +
  'For Model and Token usage, write exact values or `unknown`. Raw detector output is input, not the final context.'

export const LIVING_CONTEXT_REMEMBER_EXAMPLE =
  'prjct remember context "<Context synthesis: ... · Key data: ... · What happened: ... · Why it mattered: ... · Who/author: ... · Model: ... · Token usage: ... · Sentiment: ... · Related files: ... · Feature/domain: ... · Pattern: ... · Anti-pattern: ... · Decision/trap: ... · Outcome: ... · Next implication: ...>"'

export interface LivingContextFields {
  contextSynthesis?: string
  keyData?: string
  whatHappened?: string
  whyItMattered?: string
  whoAuthor?: string
  model?: string
  tokenUsage?: string
  sentiment?: string
  relatedFiles?: string[]
  featureDomain?: string
  pattern?: string
  antiPattern?: string
  decisionTrap?: string
  outcome?: string
  nextImplication?: string
}

const FIELD_KEY_MAP: Record<string, keyof LivingContextFields> = {
  'context synthesis': 'contextSynthesis',
  'key data': 'keyData',
  'what happened': 'whatHappened',
  'why it mattered': 'whyItMattered',
  'who/author': 'whoAuthor',
  model: 'model',
  'token usage': 'tokenUsage',
  sentiment: 'sentiment',
  'related files': 'relatedFiles',
  'feature/domain': 'featureDomain',
  pattern: 'pattern',
  'anti-pattern': 'antiPattern',
  'decision/trap': 'decisionTrap',
  outcome: 'outcome',
  'next implication': 'nextImplication',
}

export function buildLivingContextPrompt(): string {
  return [
    'Task closed. Capture rich CONTEXT for this project before details fade.',
    LIVING_CONTEXT_SYNTHESIS_GUIDANCE,
    '',
    'Write one concise English entry with this command:',
    `  ${LIVING_CONTEXT_REMEMBER_EXAMPLE}`,
    '',
    'Ground it in the actual task, changed files, user intent/sentiment, and outcome. Do not store a raw quote, transcript snippet, hot-file counter, or detector row as final context.',
    'prjct auto-anchors context entries to commit, author, and files so future sessions can recall the living synthesis.',
  ].join('\n')
}

export function parseLivingContextFields(content: string): LivingContextFields {
  const fields: LivingContextFields = {}
  const fieldPattern =
    /(Context synthesis|Key data|What happened|Why it mattered|Who\/author|Model|Token usage|Sentiment|Related files|Feature\/domain|Pattern|Anti-pattern|Decision\/trap|Outcome|Next implication)\s*:\s*/gi
  const matches = [...content.matchAll(fieldPattern)]
  for (const i of matches.keys()) {
    const match = matches[i]
    const key = FIELD_KEY_MAP[match[1].toLowerCase()]
    if (!key || match.index === undefined) continue
    const valueStart = match.index + match[0].length
    const valueEnd = matches[i + 1]?.index ?? content.length
    const raw = content
      .slice(valueStart, valueEnd)
      .replace(/^[\s·|,;-]+|[\s·|,;-]+$/g, '')
      .trim()
    if (!raw) continue
    if (key === 'relatedFiles') fields.relatedFiles = splitRelatedFiles(raw)
    else fields[key] = raw
  }
  return fields
}

export function livingContextTagsFromContent(content: string): Record<string, string> {
  const fields = parseLivingContextFields(content)
  const tags: Record<string, string> = {
    context_schema: 'living-v2',
    synthesis: 'model-authored',
  }
  if (fields.keyData) tags.key_data = fields.keyData
  if (fields.sentiment) tags.sentiment = fields.sentiment
  if (fields.model) tags.model = fields.model
  if (fields.tokenUsage) tags.token_usage = fields.tokenUsage
  if (fields.featureDomain) tags.feature = fields.featureDomain
  if (fields.relatedFiles?.length) tags.related_files = fields.relatedFiles.join(',')
  if (fields.pattern) tags.pattern = fields.pattern
  if (fields.antiPattern) tags.anti_pattern = fields.antiPattern
  if (fields.decisionTrap) tags.decision_trap = fields.decisionTrap
  return tags
}

function splitRelatedFiles(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((file) => file.trim())
    .filter(Boolean)
}
