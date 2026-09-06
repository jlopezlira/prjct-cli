/**
 * Prompt-injection scanner — defense layer for user-captured content
 * that later gets inlined into LLM context (topical-memory hook, MCP
 * memory tools, vault `.md` files read by subagents).
 *
 * Mirrors `secret-scanner`'s contract on purpose:
 *   - pure regex, no I/O
 *   - no imports from `storage/*`, `infrastructure/*`, `path-manager`
 *   - same `scan*(): string[]` shape so callers can compose both
 *
 * Conservative list — any hit blocks the capture unless the caller
 * passes `--force`. Better a false positive than a poisoned memory
 * entry hijacking a future session.
 */

/**
 * Phrase patterns run on NORMALISED text: lower-cased, diacritics stripped,
 * every punctuation run collapsed to one space. `ignore. previous
 * instructions`, `IGNORE—PREVIOUS`, and `ignora las instrucciones
 * anteriores` all reach the same regex. The windows are word counts, not
 * character counts, because the normaliser already removed the sentence
 * punctuation that used to bound them.
 */
const PHRASE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    name: 'instruction-override',
    // A verb (en/es/pt/fr/de/it) then, within a few filler words, an
    // instruction NOUN — or the bare object "above"/"everything above". The
    // object must be the noun, not a lone adjective, so "ignore the previous
    // cache" (previous = adjective, cache = not an instruction noun) no longer
    // trips it, while "ignore previous instructions" and "ignora las
    // instrucciones anteriores" do.
    re: /\b(ignore|disregard|override|forget|ignora|ignorar|olvida|olvidar|olvide|descarta|descartar|desobedece|esquece|esqueca|ignorez|oublie|oubliez|ignoriere|ignorieren|vergiss|vergessen|dimentica|ignorare)\b(?:\s+\w+){0,5}?\s+(instructions?|rules?|constraints?|guidelines?|directives?|prompt|prompts|system prompt|above|everything above|instruccion|instrucciones|instrucao|instrucoes|reglas|regras|restriccion|restricciones|restricoes|consignes?|regles|anweisungen|regeln|istruzioni|regole)\b/,
  },
  {
    name: 'role-play-injection',
    re: /\b(you are now|from now on you are|act as|pretend to be|roleplay as|assume the role|eres ahora|ahora eres|a partir de ahora eres|actua como|finge ser|haz de|voce agora e|aja como|finja ser|tu es maintenant|agis comme|fais comme si|du bist jetzt|verhalte dich als|tu dich als|sei ora|agisci come|fingi di essere)\b(?:\s+\w+){0,6}?\s+(system|admin|administrator|root|developer|operator|jailbreak|unrestricted|unfiltered|sistema|administrador|desarrollador|operador|sin restricciones|sin limites|sem restricoes|sans restrictions?|sans limites|ohne einschrankungen|senza restrizioni)\b/,
  },
  {
    name: 'jailbreak-phrase',
    re: /\b(dan mode|do anything now|without (?:any )?restrictions?|no restrictions|unrestricted mode|bypass (?:safety|filters?|guidelines?|restrictions?)|jailbreak(?: mode)?|developer mode enabled|sin restricciones|sin filtros|sin limites|modo sin restricciones|sem restricoes|sans restrictions?|sans filtre|ohne einschrankungen|ohne filter|senza restrizioni|senza filtri)\b/,
  },
  {
    name: 'system-prompt-exfil',
    re: /\b(reveal|print|show|repeat|output|dump|leak|revela|muestra|imprime|repite|revele|affiche|zeige|mostra)\b(?:\s+\w+){0,4}?\s+(system prompt|hidden prompt|initial prompt|your instructions|tus instrucciones|prompt del sistema|prompt de sistema|prompt systeme|systemprompt)\b/,
  },
  {
    name: 'hidden-instruction',
    re: /\b(do not|don t|never|dont|no le|no se lo|ne le|nicht|non)\b(?:\s+\w+){0,3}?\s+(tell|mention|reveal|disclose|show|digas|menciones|reveles|muestres|dis|revele|sage|erzahle|dire|rivelare)\b(?:\s+\w+){0,3}?\s+(the )?(user|human|operator|usuario|humano|utilisateur|benutzer|utente)\b/,
  },
]

/** Structural markers run on the RAW text — normalisation strips brackets. */
const MARKER_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    name: 'fake-system-tag',
    // <system>, [SYSTEM], [[system]], {system}, <|system|>, <<SYS>>
    re: /(?:<\s*\|?|\[\[?|\{\{?|<<)\s*(?:system|assistant|developer|tool[_-]?call|function[_-]?call|sys|inst)\s*(?:\|?\s*>|\]\]?|\}\}?|>>)/i,
  },
  {
    name: 'fake-role-header',
    // A chat-transcript turn boundary a model may honour: a markdown header
    // whose whole text is a role (`### System`), or a `Role:` label at a line
    // start (`SYSTEM:`, `Assistant:`). "Systems design" / "system: ok inline"
    // do not qualify — the role must stand alone or own the label.
    re: /^\s*(?:#{1,6}\s*(?:system|assistant|developer)\s*(?:prompt|message)?\s*$|(?:system|assistant|developer)\s*(?:prompt|message)?\s*:)/im,
  },
]

export const PROMPT_INJECTION_PATTERN_NAMES: ReadonlyArray<string> = [
  ...PHRASE_PATTERNS,
  ...MARKER_PATTERNS,
].map((p) => p.name)

/** Lower-case, strip diacritics, collapse punctuation/whitespace runs. */
export function normalizeForInjectionScan(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function scanForPromptInjection(text: string): string[] {
  const hits: string[] = []
  const normalized = normalizeForInjectionScan(text)
  for (const { name, re } of PHRASE_PATTERNS) if (re.test(normalized)) hits.push(name)
  for (const { name, re } of MARKER_PATTERNS) if (re.test(text)) hits.push(name)
  return hits
}

/**
 * Escape markdown control characters in a tag VALUE so an attacker
 * can't smuggle wikilinks, code-fences, or bracketed pseudo-tool-calls
 * through `--tags k=<payload>`. Keys are already validated upstream
 * (`/^[a-z][a-z0-9_-]*$/`); only values need this.
 */
export function escapeMarkdownInline(s: string): string {
  return s.replace(/[`*_[\](){}<>\\]/g, (m) => `\\${m}`)
}
