/**
 * `prjct llm` — opt-in machine-local brain profiles (owned agent loop foundation).
 *
 * DEFAULT OFF. Guest mode is completely unchanged until the user enables this.
 * Enabling only unlocks profile config — no agent loop / tools yet.
 *
 * Multi-brain when enabled: subscription APIs + optional local (Ollama/LM Studio).
 * Embeddings remain on `prjct embeddings` (separate secrets).
 *
 * Subcommands:
 *   enable | disable
 *   set | use | status | test | clear   (require enable)
 */

import {
  clearAllLlmKeys,
  clearAllLlmProfiles,
  clearLlmKey,
  detectBrainFromBaseUrl,
  detectBrainFromKey,
  explainUnusableCompletion,
  getLlmKeyLocation,
  getLlmProfile,
  isLocalBaseUrl,
  isOwnedLlmEnabled,
  isUsableCompletion,
  LLM_PROBE_MAX_TOKENS,
  LLM_PROBE_MAX_TOKENS_LOCAL,
  LLM_PROBE_TIMEOUT_MS,
  type LlmProfile,
  type LlmProfilePatch,
  type LlmWireKind,
  LOCAL_DUMMY_KEY,
  listLlmProfiles,
  ownedLlmEnableHint,
  profileImpliesWeakMode,
  removeLlmProfile,
  resolveLlmProvider,
  setActiveLlmProfile,
  setLlmKey,
  setOwnedLlmEnabled,
  slugifyProfileName,
  upsertLlmProfile,
} from '../llm'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { flag } from '../utils/cli-flags'
import { failHard } from '../utils/md-aware'
import { mdOutput, mdSection, mdStats } from '../utils/md-formatter'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

interface LlmOptions {
  md?: boolean
  name?: string
  key?: string
  model?: string
  baseUrl?: string
  wire?: string
  provider?: string
  weak?: boolean
  all?: boolean
  authHeader?: string
  authScheme?: string
}

function hasFlag(parts: string[], name: string): boolean {
  return parts.includes(`--${name}`)
}

function parseWire(raw: string | undefined): LlmWireKind | undefined {
  if (!raw) return undefined
  if (raw === 'anthropic') return 'anthropic'
  if (raw === 'openai-compatible' || raw === 'openai' || raw === 'openai-compat') {
    return 'openai-compatible'
  }
  return undefined
}

function keyLocationLabel(loc: string): string {
  switch (loc) {
    case 'env':
      return 'env (PRJCT_LLM_API_KEY)'
    case 'env-profile':
      return 'env (per-profile)'
    case 'keychain':
      return 'macOS Keychain'
    case 'file':
      return 'llm-keys file (0600)'
    case 'dummy':
      return 'local placeholder'
    default:
      return 'none'
  }
}

export class LlmCommands extends PrjctCommandsBase {
  async llm(
    input: string | null = null,
    _projectPath: string = process.cwd(),
    options: LlmOptions = {}
  ): Promise<CommandResult> {
    const parts = (input ?? '').trim().split(/\s+/).filter(Boolean)
    const sub = parts[0] ?? 'status'

    // Always-safe verbs (no network, no secrets write except enable flag).
    if (sub === 'enable') return this.enable(options)
    if (sub === 'disable') return this.disable(options)

    // status when disabled: explain opt-in only — zero side effects.
    if ((sub === 'status' || sub === 'list') && !isOwnedLlmEnabled()) {
      return this.statusDisabled(options)
    }

    if (!isOwnedLlmEnabled()) {
      return failHard(ownedLlmEnableHint(), options)
    }

    switch (sub) {
      case 'set':
        return this.set(parts.slice(1), options)
      case 'use':
        return this.use(parts.slice(1), options)
      case 'status':
      case 'list':
        return this.status(options)
      case 'test':
        return this.test(parts.slice(1), options)
      case 'clear':
        return this.clear(parts.slice(1), options)
      default:
        return failHard(
          `Unknown subcommand '${sub}'. Use: enable | disable | set | use <name> | status | test | clear <name|--all>`,
          options
        )
    }
  }

  private async enable(options: LlmOptions): Promise<CommandResult> {
    setOwnedLlmEnabled(true)
    if (options.md) {
      console.log(
        mdOutput(
          mdSection(
            'Owned LLM enabled',
            'Brain profile config is ON for this machine. Guest harnesses (Claude/Grok/Codex/…) are unchanged. There is no agent loop yet — only `prjct llm set|use|test|…`.'
          ),
          mdSection('Next', '`prjct llm set --name … --key …` then `prjct llm test --md`')
        )
      )
      return { success: true, enabled: true }
    }
    out.done('Owned LLM enabled (opt-in). Guest mode unchanged.')
    out.info('Configure a brain: prjct llm set --name <n> --key <K>')
    out.info('Disable anytime:   prjct llm disable')
    return { success: true, enabled: true }
  }

  private async disable(options: LlmOptions): Promise<CommandResult> {
    setOwnedLlmEnabled(false)
    if (options.md) {
      console.log(
        mdOutput(
          mdSection(
            'Owned LLM disabled',
            'Profile config verbs are locked. Existing profiles/keys on disk are left intact (run `prjct llm clear --all` after enable if you want them removed).'
          )
        )
      )
      return { success: true, enabled: false }
    }
    out.done('Owned LLM disabled. Guest mode unchanged.')
    return { success: true, enabled: false }
  }

  private async statusDisabled(options: LlmOptions): Promise<CommandResult> {
    if (options.md) {
      console.log(
        mdOutput(
          mdSection(
            'Owned LLM',
            '**OFF** (default). No guest behavior changed. Enable only if you want machine-local brain profiles for the future owned agent loop.'
          ),
          mdSection('Enable', '`prjct llm enable` · or `PRJCT_OWNED_LLM=1`')
        )
      )
      return { success: true, enabled: false, configured: false }
    }
    out.info('Owned LLM: OFF (opt-in). Guest harnesses unchanged.')
    out.info('Enable: prjct llm enable')
    return { success: true, enabled: false, configured: false }
  }

  private async set(parts: string[], options: LlmOptions): Promise<CommandResult> {
    const nameRaw = options.name ?? flag(parts, 'name')
    const key = options.key ?? flag(parts, 'key')
    const model = options.model ?? flag(parts, 'model')
    const explicitBaseUrl = options.baseUrl ?? flag(parts, 'base-url') ?? flag(parts, 'baseUrl')
    const explicitWire = parseWire(options.wire ?? flag(parts, 'wire'))
    const explicitProviderLabel = options.provider ?? flag(parts, 'provider')
    const weakExplicit =
      options.weak === true || hasFlag(parts, 'weak')
        ? true
        : hasFlag(parts, 'no-weak')
          ? false
          : undefined
    const authHeader = options.authHeader ?? flag(parts, 'auth-header')
    const authSchemeRaw = options.authScheme ?? flag(parts, 'auth-scheme')
    const authScheme =
      authSchemeRaw === undefined ? undefined : /^none$/i.test(authSchemeRaw) ? '' : authSchemeRaw

    // Detection from key / base URL (does not override explicit flags)
    const detected =
      (key ? detectBrainFromKey(key) : undefined) ??
      (explicitBaseUrl ? detectBrainFromBaseUrl(explicitBaseUrl) : undefined)
    const baseUrl = explicitBaseUrl ?? detected?.baseUrl
    const wire = explicitWire ?? detected?.wire
    const providerLabel = explicitProviderLabel ?? detected?.providerLabel

    // Resolve name: explicit → existing inference → detected label → default
    const provisionalName = slugifyProfileName(
      nameRaw ?? providerLabel ?? detected?.providerLabel ?? 'default'
    )
    const existing = getLlmProfile(provisionalName)

    const resolvedModel = model ?? detected?.defaultModel ?? undefined

    const patch: LlmProfilePatch = {
      name: provisionalName,
    }
    if (wire) patch.wire = wire
    if (providerLabel) patch.providerLabel = providerLabel
    if (baseUrl) patch.baseUrl = baseUrl.replace(/\/+$/, '')
    if (resolvedModel) patch.model = resolvedModel
    if (authHeader !== undefined) patch.authHeader = authHeader
    if (authScheme !== undefined) patch.authScheme = authScheme
    if (weakExplicit === true) patch.weak = true
    else if (weakExplicit === false) patch.weak = false
    else if (!existing && detected?.weakHint) patch.weak = true

    // Nothing to do?
    if (
      !key &&
      !nameRaw &&
      !model &&
      !baseUrl &&
      !wire &&
      !providerLabel &&
      weakExplicit === undefined &&
      authHeader === undefined &&
      authScheme === undefined
    ) {
      return failHard(
        'Nothing to set. Examples:\n' +
          '  prjct llm set --name anthropic --key sk-ant-…\n' +
          '  prjct llm set --name openai --key sk-…\n' +
          '  prjct llm set --name ollama --base-url http://localhost:11434/v1 --model qwen3.5:4b\n' +
          '  prjct llm set --name ollama --model other:7b   # partial update\n' +
          '  prjct llm set --name openrouter --key sk-or-…',
        options
      )
    }

    const profile: LlmProfile | null = (() => {
      try {
        return upsertLlmProfile(patch, { activate: true })
      } catch {
        return null
      }
    })()
    if (!profile) return failHard('Could not save the LLM profile.', options)

    const keyResult: { location?: 'keychain' | 'file'; error?: string } = key
      ? await setLlmKey(profile.name, key)
          .then((location) => ({ location }))
          .catch((error) => ({ error: getErrorMessage(error) }))
      : profile.wire === 'openai-compatible' &&
          isLocalBaseUrl(profile.baseUrl) &&
          (await getLlmKeyLocation(profile.name, { isActive: true })) === 'none'
        ? await setLlmKey(profile.name, LOCAL_DUMMY_KEY)
            .then((location) => ({ location }))
            .catch(() => ({}))
        : {}
    if (keyResult.error) {
      return failHard(`Could not store the key securely: ${keyResult.error}`, options)
    }
    const keyLocation = keyResult.location

    const loc =
      keyLocation ??
      (await getLlmKeyLocation(profile.name, {
        isActive: listLlmProfiles().active === profile.name,
      }))

    if (options.md) {
      console.log(
        mdOutput(
          mdSection('LLM profile configured', 'Machine-local brain for the owned agent loop.'),
          mdStats({
            name: profile.name,
            wire: profile.wire,
            provider: profile.providerLabel,
            model: profile.model,
            'base URL': profile.baseUrl,
            weak: profileImpliesWeakMode(profile) ? 'yes' : 'no',
            active: 'yes',
            'api key': keyLocationLabel(loc),
          }),
          mdSection(
            'Next',
            'Validate: `prjct llm test --md` · Switch: `prjct llm use <name>` · Guest hosts: `prjct install`'
          )
        )
      )
      return { success: true, profile: profile.name }
    }

    out.done(`LLM profile '${profile.name}' configured and active`)
    out.info(`wire:     ${profile.wire}`)
    out.info(`provider: ${profile.providerLabel}`)
    out.info(`model:    ${profile.model}`)
    out.info(`base URL: ${profile.baseUrl}`)
    out.info(`weak:     ${profileImpliesWeakMode(profile) ? 'yes' : 'no'}`)
    out.info(`api key:  ${keyLocationLabel(loc)}`)
    out.info('Run `prjct llm test` to validate connectivity.')
    return { success: true, profile: profile.name }
  }

  private async use(parts: string[], options: LlmOptions): Promise<CommandResult> {
    const name = options.name ?? parts[0]
    if (!name || name.startsWith('--')) {
      return failHard('Usage: prjct llm use <profile-name>', options)
    }
    try {
      const profile = setActiveLlmProfile(name)
      if (options.md) {
        console.log(
          mdOutput(
            mdSection('Active brain', `Switched to profile \`${profile.name}\`.`),
            mdStats({
              name: profile.name,
              provider: profile.providerLabel,
              model: profile.model,
              'base URL': profile.baseUrl,
              weak: profileImpliesWeakMode(profile) ? 'yes' : 'no',
            })
          )
        )
        return { success: true, profile: profile.name }
      }
      out.done(`Active LLM profile: ${profile.name}`)
      out.info(`${profile.providerLabel} · ${profile.model} · ${profile.baseUrl}`)
      return { success: true, profile: profile.name }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  private async status(options: LlmOptions): Promise<CommandResult> {
    const state = listLlmProfiles()
    if (state.profiles.length === 0) {
      if (options.md) {
        console.log(
          mdOutput(
            mdSection(
              'LLM brains',
              'No profiles configured. Owned agent loop needs a brain (subscription API and/or local).'
            ),
            mdSection(
              'Examples',
              [
                '`prjct llm set --name anthropic --key sk-ant-…`  — subscription API',
                '`prjct llm set --name openai --key sk-…`',
                '`prjct llm set --name ollama --base-url http://localhost:11434/v1 --model qwen3.5:4b`',
                'Guest (vendor TUI + your plan): `prjct install` then open Claude Code / Grok / Codex.',
              ].join('\n')
            )
          )
        )
        return { success: true, configured: false }
      }
      out.info('LLM: no profiles — configure a subscription or local brain:')
      out.info('  prjct llm set --name anthropic --key sk-ant-…')
      out.info(
        '  prjct llm set --name ollama --base-url http://localhost:11434/v1 --model qwen3.5:4b'
      )
      out.info('Guest hosts still work via prjct install.')
      return { success: true, configured: false }
    }

    const rows: Array<Record<string, string>> = []
    for (const p of state.profiles) {
      const loc = await getLlmKeyLocation(p.name, {
        isActive: state.active === p.name,
      })
      rows.push({
        name: p.name + (state.active === p.name ? ' *' : ''),
        provider: p.providerLabel,
        wire: p.wire,
        model: p.model,
        base: p.baseUrl,
        weak: profileImpliesWeakMode(p) ? 'yes' : 'no',
        key: loc === 'none' ? 'missing' : loc,
      })
    }

    if (options.md) {
      const lines = [
        '| name | provider | wire | model | key | weak |',
        '|---|---|---|---|---|---|',
        ...rows.map(
          (r) => `| ${r.name} | ${r.provider} | ${r.wire} | ${r.model} | ${r.key} | ${r.weak} |`
        ),
      ]
      console.log(
        mdOutput(
          mdSection('LLM brains', `Active: \`${state.active ?? 'none'}\` · * = active`),
          lines.join('\n'),
          mdSection(
            'Switch',
            '`prjct llm use <name>` · env override: `PRJCT_LLM_PROFILE` · test: `prjct llm test --md`'
          )
        )
      )
      return { success: true, configured: true, active: state.active, count: state.profiles.length }
    }

    out.done(`LLM profiles (${state.profiles.length}) · active: ${state.active ?? 'none'}`)
    for (const r of rows) {
      out.info(
        `  ${r.name.padEnd(14)} ${r.provider.padEnd(12)} ${r.model}  key=${r.key} weak=${r.weak}`
      )
    }
    return { success: true, configured: true, active: state.active, count: state.profiles.length }
  }

  private async test(parts: string[], options: LlmOptions): Promise<CommandResult> {
    const profileName = options.name ?? flag(parts, 'name')
    const provider = await resolveLlmProvider({ profile: profileName })
    if (!provider) {
      return failHard(
        'No LLM profile configured. Run: prjct llm set --name <n> --key <K>  (or --base-url for Ollama)',
        options
      )
    }
    const profile = provider.profile
    const loc = await getLlmKeyLocation(profile.name, {
      isActive: listLlmProfiles().active === profile.name,
    })
    const local = isLocalBaseUrl(profile.baseUrl)
    try {
      const result = await provider.generate({
        messages: [
          {
            role: 'user',
            content:
              'Reply with exactly one word: pong. No punctuation, no explanation, no thinking aloud.',
          },
        ],
        max_tokens: local ? LLM_PROBE_MAX_TOKENS_LOCAL : LLM_PROBE_MAX_TOKENS,
        temperature: 0,
        timeoutMs: LLM_PROBE_TIMEOUT_MS,
      })
      const snippet = (result.content ?? '').trim().slice(0, 120)

      if (!isUsableCompletion(result)) {
        const why = explainUnusableCompletion(result, profile)
        return failHard(
          `LLM probe failed for profile '${profile.name}' (${profile.model}).\n${why}`,
          options
        )
      }

      if (options.md) {
        console.log(
          mdOutput(
            mdSection('LLM test OK', `Profile \`${profile.name}\` returned usable content.`),
            mdStats({
              profile: profile.name,
              provider: profile.providerLabel,
              model: result.model || profile.model,
              key: loc,
              reply: snippet,
              tokens: result.usage?.total_tokens,
            })
          )
        )
        return { success: true, profile: profile.name, reply: snippet }
      }
      out.done(`LLM test OK · ${profile.name} · ${result.model || profile.model}`)
      out.info(`reply: ${snippet}`)
      return { success: true, profile: profile.name, reply: snippet }
    } catch (error) {
      const detail = getErrorMessage(error)
      const hint = llmFailureHint(detail, profile)
      return failHard(hint ? `${detail}\n\nHint: ${hint}` : detail, options)
    }
  }

  private async clear(parts: string[], options: LlmOptions): Promise<CommandResult> {
    const all = options.all === true || hasFlag(parts, 'all')
    const name = options.name ?? parts.find((p) => !p.startsWith('--'))

    if (all) {
      const names = clearAllLlmProfiles()
      const clearedKeys = await clearAllLlmKeys(names)
      if (options.md) {
        console.log(
          mdOutput(
            mdSection(
              'LLM cleared',
              `Removed ${names.length} profile(s) and ${clearedKeys.length} key(s) from this machine.`
            )
          )
        )
        return { success: true, cleared: names }
      }
      out.done(
        `All LLM profiles cleared (${names.length} profile(s), ${clearedKeys.length} key(s))`
      )
      return { success: true, cleared: names }
    }

    if (!name) {
      return failHard(
        'Usage: prjct llm clear <name>  OR  prjct llm clear --all\n' +
          '(Bare clear is refused so multi-brain setups are not wiped by accident.)',
        options
      )
    }

    const slug = slugifyProfileName(name)
    const removed = removeLlmProfile(slug)
    await clearLlmKey(slug)
    if (!removed) {
      // Still cleared key if orphan; report honestly
      return failHard(`No profile named '${slug}'`, options)
    }
    if (options.md) {
      console.log(
        mdOutput(mdSection('LLM profile removed', `Cleared profile and key for \`${slug}\`.`))
      )
      return { success: true }
    }
    out.done(`LLM profile '${slug}' removed (key cleared)`)
    return { success: true }
  }
}

function llmFailureHint(detail: string, profile: LlmProfile): string | undefined {
  if (/\b401\b|invalid_api_key|unauthor|authentication/i.test(detail)) {
    return `Key rejected. Re-set: prjct llm set --name ${profile.name} --key <api-key>`
  }
  if (/timed out|abort/i.test(detail)) {
    return 'Request timed out. Local model loading? Try again, or switch: prjct llm use <cloud-profile>'
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|ETIMEDOUT|request failed/i.test(detail)) {
    if (isLocalBaseUrl(profile.baseUrl)) {
      return 'Local endpoint not reachable — is Ollama/LM Studio running? Or switch: prjct llm use <cloud-profile>'
    }
    return 'Could not reach the endpoint. Check network / base URL: prjct llm status'
  }
  if (/\b404\b|not found/i.test(detail)) {
    return 'Model or route not found. Check --model and --base-url for this provider.'
  }
  return undefined
}
