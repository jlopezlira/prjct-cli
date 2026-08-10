/**
 * Provider-status rendering shared by the two `version` surfaces
 * (`core/index.ts` displayVersion and the bin/prjct.ts version branch).
 * Both used to hand-roll the same glyph/branch pattern per provider and had
 * already drifted — the line format lives here once; call sites supply data.
 */

import chalk from 'chalk'

export type ProviderState = 'ready' | 'installed' | 'detected' | 'missing'

const STATE_GLYPHS: Record<Exclude<ProviderState, 'missing'>, string> = {
  ready: chalk.green('✓ ready'),
  installed: chalk.yellow('● installed'),
  detected: chalk.yellow('● detected'),
}

/**
 * One aligned provider row. `suffix` is appended verbatim (caller applies
 * its own chalk), `missingText` customizes the dim placeholder.
 */
export function providerStatusLine(
  label: string,
  state: ProviderState,
  suffix = '',
  missingText = '○ not installed'
): string {
  const status = state === 'missing' ? chalk.dim(missingText) : STATE_GLYPHS[state]
  return `  ${label.padEnd(14)}${status}${suffix}`
}

/** The shared banner above the provider rows. */
export function providerStatusHeader(version: string): string {
  return `
${chalk.cyan('p/')} prjct v${version}
${chalk.dim('Context layer for AI coding agents')}

${chalk.dim('Providers:')}`
}
