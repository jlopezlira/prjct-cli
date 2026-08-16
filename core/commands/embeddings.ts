/**
 * `prjct embeddings` — configure the GLOBAL semantic-embeddings provider
 * (BYOT). One key, stored securely (macOS Keychain, else a 0600 file), used by
 * every project. Without it, recall uses the always-on local subword embedder.
 *
 * Subcommands:
 *   set --key <K> [--model <M>] [--base-url <U>]   Store key + global settings
 *   status                                          Show provider + key location
 *   test                                            Embed a probe to validate
 *   clear                                           Forget key + settings
 */

import {
  clearGlobalEmbeddings,
  DEFAULT_EMBEDDINGS_MODEL,
  detectBaseUrlFromKey,
  resolveActiveProvider,
  resolveGlobalEmbeddings,
  setGlobalEmbeddings,
} from '../services/embeddings'
import {
  clearEmbeddingsKey,
  getKeyLocation,
  setEmbeddingsKey,
} from '../services/embeddings/secure-key'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { flag } from '../utils/cli-flags'
import { failHard, notifyFail, notifyInfo } from '../utils/md-aware'
import { mdOutput, mdSection, mdStats } from '../utils/md-formatter'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

/**
 * Best-effort, actionable hint derived from a failed-embedding error string.
 * The common failures are config mismatches the user can fix; map them to a
 * concrete next step instead of leaving the raw HTTP body to speak for itself.
 */
function embeddingsFailureHint(detail: string): string | undefined {
  if (/\b401\b|invalid_api_key|incorrect api key|unauthor/i.test(detail)) {
    return "The endpoint rejected the key (401). The base URL must match the key's provider — e.g. an OpenRouter key (sk-or-…) needs `--base-url https://openrouter.ai/api/v1`, not OpenAI's. Re-set with: prjct embeddings set --key <api-key> --base-url <url>"
  }
  if (/\b404\b|not found/i.test(detail)) {
    return "No /embeddings route at that base URL (404). Check the base URL is the provider's OpenAI-compatible root (e.g. https://openrouter.ai/api/v1, https://api.openai.com/v1)."
  }
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|getaddrinfo|ETIMEDOUT/i.test(detail)) {
    return 'Could not reach the endpoint. Check the base URL and your network: prjct embeddings status'
  }
  return undefined
}

interface EmbeddingsOptions {
  md?: boolean
  /** Flags parsed by the CLI arg parser (not left in the positional string). */
  key?: string
  model?: string
  baseUrl?: string
  /** Auth knobs for non-Bearer providers (Azure OpenAI, custom gateways). */
  authHeader?: string
  authScheme?: string
  /** Extra static headers as "k=v,k2=v2". */
  headers?: string
  /** Raw query string appended to the URL, e.g. "api-version=2023-05-15". */
  query?: string
}

/** Parse a "k=v,k2=v2" header string into an object (skips malformed pairs). */
function parseHeaderPairs(raw: string | undefined): Record<string, string> | undefined {
  if (!raw?.trim()) return undefined
  const out: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const k = pair.slice(0, eq).trim()
    const v = pair.slice(eq + 1).trim()
    if (k) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

export class EmbeddingsCommands extends PrjctCommandsBase {
  async embeddings(
    input: string | null = null,
    _projectPath: string = process.cwd(),
    options: EmbeddingsOptions = {}
  ): Promise<CommandResult> {
    const parts = (input ?? '').trim().split(/\s+/).filter(Boolean)
    const sub = parts[0] ?? 'status'
    switch (sub) {
      case 'set':
        return this.set(parts.slice(1), options)
      case 'status':
        return this.status(options)
      case 'test':
        return this.test(options)
      case 'clear':
        return this.clear(options)
      default:
        return failHard(
          `Unknown subcommand '${sub}'. Use: set --key <K> [--model <M>] [--base-url <U>] | status | test | clear`,
          options
        )
    }
  }

  private async set(parts: string[], options: EmbeddingsOptions): Promise<CommandResult> {
    // CLI flags arrive in `options`; fall back to parsing the raw string so a
    // direct programmatic call (or a test) works the same way.
    const key = options.key ?? flag(parts, 'key')
    const model = options.model ?? flag(parts, 'model')
    const configuredBaseUrl = options.baseUrl ?? flag(parts, 'base-url') ?? flag(parts, 'baseUrl')
    // Zero-config: infer the base URL from the key prefix (sk-or-… → OpenRouter,
    // sk-… → OpenAI, …) so pasting just `--key` is enough. An explicit
    // `--base-url` always wins; detection also fires when switching providers.
    const detected = !configuredBaseUrl && key ? detectBaseUrlFromKey(key) : null
    const baseUrl = configuredBaseUrl ?? detected?.baseUrl
    const detectedProvider = detected?.provider
    const authHeader = options.authHeader ?? flag(parts, 'auth-header')
    // `none` (case-insensitive) → raw key, no scheme prefix (Azure's api-key).
    const authSchemeRaw = options.authScheme ?? flag(parts, 'auth-scheme')
    const authScheme =
      authSchemeRaw === undefined ? undefined : /^none$/i.test(authSchemeRaw) ? '' : authSchemeRaw
    const extraHeaders = parseHeaderPairs(options.headers ?? flag(parts, 'headers'))
    const query = options.query ?? flag(parts, 'query')
    if (
      !key &&
      !model &&
      !baseUrl &&
      authHeader === undefined &&
      authScheme === undefined &&
      !extraHeaders &&
      query === undefined
    ) {
      return failHard(
        'Nothing to set. Usage: prjct embeddings set --key <api-key> [--model <id>] [--base-url <url>] [--auth-header <h>] [--auth-scheme <s|none>] [--headers "k=v,..."] [--query <qs>]'
      )
    }

    const keyStorage: { location?: 'keychain' | 'file'; error?: string } = key
      ? await setEmbeddingsKey(key)
          .then((location) => ({ location }))
          .catch((error) => ({ error: getErrorMessage(error) }))
      : {}
    if (keyStorage.error) {
      return failHard(`Could not store the key securely: ${keyStorage.error}`)
    }
    const location = keyStorage.location
    const settings = setGlobalEmbeddings({
      model,
      baseUrl,
      authHeader,
      authScheme,
      extraHeaders,
      query,
    })

    if (options.md) {
      console.log(
        mdOutput(
          mdSection('Embeddings configured', 'Global embeddings now apply to all projects.'),
          mdStats({
            provider: settings.provider,
            model: settings.model,
            'base URL': settings.baseUrl,
            detected: detectedProvider,
            'auth header': settings.authHeader,
            auth:
              settings.authScheme === undefined
                ? undefined
                : settings.authScheme || '(raw key, no scheme)',
            query: settings.query,
            headers: settings.extraHeaders
              ? Object.keys(settings.extraHeaders).join(', ')
              : undefined,
            'api key': location
              ? `stored in ${location === 'keychain' ? 'macOS Keychain' : '~/.prjct-cli/config/embeddings.key (0600)'}`
              : undefined,
          }),
          mdSection('Next', 'Run `prjct embeddings test --md` to validate now.')
        )
      )
      return { success: true }
    }
    out.done('Global embeddings configured (applies to all projects)')
    if (detectedProvider) out.info(`detected: ${detectedProvider} (from key prefix)`)
    out.info(`provider: ${settings.provider}`)
    out.info(`model:    ${settings.model}`)
    out.info(`base URL: ${settings.baseUrl}`)
    if (settings.authHeader) out.info(`auth hdr: ${settings.authHeader}`)
    if (settings.authScheme !== undefined)
      out.info(`auth:     ${settings.authScheme ? settings.authScheme : '(raw key, no scheme)'}`)
    if (settings.query) out.info(`query:    ${settings.query}`)
    if (settings.extraHeaders)
      out.info(`headers:  ${Object.keys(settings.extraHeaders).join(', ')}`)
    if (location)
      out.info(
        `api key:  stored in ${location === 'keychain' ? 'macOS Keychain' : '~/.prjct-cli/config/embeddings.key (0600)'}`
      )
    out.info(
      'Each project re-vectorizes on its next session (Stop hook). Run `prjct embeddings test` to validate now.'
    )
    return { success: true }
  }

  private async status(options: EmbeddingsOptions): Promise<CommandResult> {
    const g = resolveGlobalEmbeddings()
    const loc = await getKeyLocation()
    if (!g) {
      if (options.md) {
        console.log(
          mdOutput(
            mdSection(
              'Embeddings',
              'Global embeddings are not configured. Recall uses the built-in local subword embedder.'
            ),
            mdStats({ 'api key': loc === 'none' ? 'none' : `present (${loc})` }),
            mdSection('Next', 'Set one with `prjct embeddings set --key <api-key> --md`.')
          )
        )
        return { success: true, configured: false }
      }
      out.info('Global embeddings: not configured — using the built-in local subword embedder.')
      out.info(`api key: ${loc === 'none' ? 'none' : `present (${loc})`}`)
      out.info('Set one with: prjct embeddings set --key <api-key>')
      return { success: true, configured: false }
    }
    if (options.md) {
      console.log(
        mdOutput(
          mdSection('Embeddings', 'Global embeddings are configured.'),
          mdStats({
            provider: g.provider,
            model: g.model,
            'base URL': g.baseUrl,
            'auth header': g.authHeader,
            auth: g.authScheme === undefined ? undefined : g.authScheme || '(raw key, no scheme)',
            query: g.query,
            headers: g.extraHeaders ? Object.keys(g.extraHeaders).join(', ') : undefined,
            'api key':
              loc === 'none'
                ? 'MISSING - set with `prjct embeddings set --key <api-key>`'
                : `present (${loc})`,
          })
        )
      )
      return { success: true, configured: true }
    }
    out.done('Global embeddings: configured')
    out.info(`provider: ${g.provider}`)
    out.info(`model:    ${g.model}`)
    out.info(`base URL: ${g.baseUrl}`)
    if (g.authHeader) out.info(`auth hdr: ${g.authHeader}`)
    if (g.authScheme !== undefined)
      out.info(`auth:     ${g.authScheme ? g.authScheme : '(raw key, no scheme)'}`)
    if (g.query) out.info(`query:    ${g.query}`)
    if (g.extraHeaders) out.info(`headers:  ${Object.keys(g.extraHeaders).join(', ')}`)
    out.info(
      `api key:  ${loc === 'none' ? 'MISSING — set with `prjct embeddings set --key <api-key>`' : `present (${loc})`}`
    )
    return { success: true, configured: true }
  }

  private async test(options: EmbeddingsOptions): Promise<CommandResult> {
    const provider = resolveActiveProvider(null)
    try {
      const [vector] = await provider.embed(['prjct embeddings connectivity probe'])
      if (!vector || vector.length === 0) {
        return failHard(`Provider '${provider.model}' returned an empty vector.`, options)
      }
      if (options.md) {
        console.log(
          mdOutput(
            mdSection(
              'Embeddings test',
              `Provider '${provider.model}' returned a ${vector.length}-dim vector.`
            ),
            provider.isLocal
              ? mdSection(
                  'Next',
                  'This is the local embedder. Set a key to upgrade: `prjct embeddings set --key <api-key> --md`.'
                )
              : null
          )
        )
        return { success: true, model: provider.model, dims: vector.length }
      }
      out.done(`OK — '${provider.model}' returned a ${vector.length}-dim vector.`)
      if (provider.isLocal) {
        out.info(
          'This is the local embedder. Set a key to upgrade: prjct embeddings set --key <api-key>'
        )
      }
      return { success: true, model: provider.model, dims: vector.length }
    } catch (error) {
      // Headline only — out.fail truncates to ~65 chars. The full endpoint
      // response and a targeted hint go through notifyInfo (no truncation), so
      // the one command meant to diagnose connectivity doesn't hide the reason.
      const detail = getErrorMessage(error)
      notifyFail(`Embedding test failed for '${provider.model}'.`, options)
      notifyInfo(detail, options)
      const hint = embeddingsFailureHint(detail)
      if (hint) notifyInfo(hint, options)
      return { success: false, error: detail }
    }
  }

  private async clear(options: EmbeddingsOptions): Promise<CommandResult> {
    await clearEmbeddingsKey()
    clearGlobalEmbeddings()
    if (options.md) {
      console.log(
        mdOutput(
          mdSection('Embeddings cleared', 'Semantic recall now falls back to the local embedder.'),
          mdStats({ 'default model': DEFAULT_EMBEDDINGS_MODEL })
        )
      )
      return { success: true }
    }
    out.done('Cleared global embeddings — semantic recall falls back to the local embedder.')
    out.info(`(Default model when you reconfigure: ${DEFAULT_EMBEDDINGS_MODEL}.)`)
    return { success: true }
  }
}
