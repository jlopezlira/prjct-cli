/**
 * Trust boundary — ONE place for agent trust decisions.
 *
 * Doctrine (mem_5430 / Claude ZT pattern): enforce trust AT the boundary,
 * not scattered across every caller. Hooks, CLI remember/capture, MCP memory
 * tools, workflow-engine, and projectMemory.remember all compose these pure
 * decisions. Scanners stay pure (no I/O); this module only aggregates them.
 *
 * Surfaces covered:
 *   - secrets in tool args / memory content
 *   - prompt-injection in memory content (poisoned RAG)
 *   - package install legitimacy (new deps)
 *   - workflow rule trust_source (imported = inert until local approve)
 */

import { scanForPromptInjection } from '../utils/prompt-injection'
import { scanForSecrets, scanHookToolInput } from '../utils/secret-scanner'
import { decidePackageInstall, type PackageInstallDecision } from './package-legitimacy'

export type TrustKind =
  | 'secrets'
  | 'prompt_injection'
  | 'package_install'
  | 'workflow_rule'
  | 'memory_content'

export type TrustAllow = { allow: true }

export type TrustDeny = {
  allow: false
  kind: TrustKind
  /** Short machine reason (logging / tests). */
  reason: string
  /** Pattern names hit (secrets / injection). */
  hits: string[]
  /** User/agent-facing deny text (hook decide / CLI fail). */
  denyMessage: string
}

export type TrustVerdict = TrustAllow | TrustDeny

const ALLOW: TrustAllow = { allow: true }

// ── Memory content (remember / capture / MCP) ───────────────────────────────

/**
 * Gate content that will later be inlined into LLM context.
 * Secrets and prompt-injection block unless `force` is true.
 */
export function evaluateMemoryContent(
  content: string,
  options: { force?: boolean } = {}
): TrustVerdict {
  const text = content ?? ''
  if (!text.trim()) {
    return {
      allow: false,
      kind: 'memory_content',
      reason: 'empty content',
      hits: [],
      denyMessage: 'refusing empty memory content',
    }
  }

  if (options.force) return ALLOW

  const secretHits = scanForSecrets(text)
  if (secretHits.length > 0) {
    const list = secretHits.join(', ')
    return {
      allow: false,
      kind: 'secrets',
      reason: 'secret-like content',
      hits: secretHits,
      denyMessage:
        `refusing to store memory that looks like a secret (${list}). ` +
        `Re-run with --force if intentional.`,
    }
  }

  const injectionHits = scanForPromptInjection(text)
  if (injectionHits.length > 0) {
    const list = injectionHits.join(', ')
    return {
      allow: false,
      kind: 'prompt_injection',
      reason: 'prompt-injection-like content',
      hits: injectionHits,
      denyMessage:
        `refusing to store memory that looks like prompt injection (${list}). ` +
        `Entries are inlined into LLM context — re-run with --force if intentional.`,
    }
  }

  return ALLOW
}

// ── Tool input secrets (PreToolUse) ─────────────────────────────────────────

/**
 * PreToolUse credential guard decision. Host-agnostic (Claude + Gemini shapes).
 * Fail-open is the caller's job (try/catch around this).
 */
export function evaluateToolInputSecrets(input: unknown): TrustVerdict {
  const hits = scanHookToolInput(input)
  if (hits.length === 0) return ALLOW
  const list = hits.join(', ')
  return {
    allow: false,
    kind: 'secrets',
    reason: 'secret pattern in tool input',
    hits,
    denyMessage:
      `⛔ prjct credential guard: tool input matches secret pattern(s): ${list}. ` +
      `Refusing to run this tool so credentials are not exposed. ` +
      `Remove the secret from the command/content and retry. ` +
      `(This MUST runs on every host — no PPID / host-env dependency.)`,
  }
}

// ── Package install ─────────────────────────────────────────────────────────

/**
 * Wrap package-legitimacy into the trust boundary shape.
 * Caller decides strict vs advisory from pack config.
 */
export type PackageTrustVerdict = TrustVerdict & { decision: PackageInstallDecision }

export function evaluatePackageInstallTrust(
  packages: string[],
  knownDeps: ReadonlySet<string>
): PackageTrustVerdict {
  const decision = decidePackageInstall(packages, knownDeps)
  if (!decision.risky || !decision.message) {
    return { allow: true, decision }
  }
  return {
    allow: false,
    kind: 'package_install',
    reason: 'unknown new packages',
    hits: decision.newPackages,
    denyMessage:
      `⛔ ${decision.message}\n` +
      `Install denied (strict pack). Verify packages before adding them.`,
    decision,
  }
}

// ── Workflow rules ──────────────────────────────────────────────────────────

/**
 * Only a rule whose trust_source is positively `local` may run shell /
 * verify / script. Imported (cloud/shared-template) rules never do, and
 * neither does a rule with no trust source at all: an absent value is what
 * a rule that skipped the storage default looks like, and treating unknown
 * as trusted was the hole (SEC-07).
 */
export function evaluateWorkflowRuleExecutable(
  trustSource: string | undefined | null,
  ruleLabel?: string
): TrustVerdict {
  if (trustSource === 'local') return ALLOW
  const label = ruleLabel?.trim() || 'workflow rule'
  const imported = trustSource === 'imported'
  return {
    allow: false,
    kind: 'workflow_rule',
    reason: imported ? 'imported trust_source' : `unknown trust_source (${String(trustSource)})`,
    hits: [imported ? 'imported' : 'untrusted'],
    denyMessage: imported
      ? `Refusing to run imported rule without approval: ${label}. ` +
        `Re-create the rule locally if you trust it.`
      : `Refusing to run rule with no local trust source: ${label}. ` +
        `Re-create it with \`prjct workflow\` so it is recorded as local.`,
  }
}

/** True when a pulled workflow rule must stay inert (enabled=0, trust=imported). */
export function isImportedWorkflowTrust(trustSource: string | undefined | null): boolean {
  return trustSource === 'imported'
}
