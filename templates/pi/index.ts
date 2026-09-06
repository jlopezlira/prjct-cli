// prjct-managed pi bridge v1
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { registerLifecycle, runAgent, runCli } from './bridge.mjs'
import hooks from './hooks.json'

export default function (pi: ExtensionAPI) {
  registerLifecycle(pi, hooks)
  pi.registerCommand('prjct', {
    description: 'Run any prjct workflow through the native prjct skill',
    handler: async (args) => {
      pi.sendUserMessage(`/skill:prjct ${args}`, {
        expandPromptTemplates: true,
        deliverAs: 'followUp',
      })
    },
  })
  pi.registerTool({
    name: 'prjct',
    label: 'prjct',
    description:
      'Execute any existing prjct CLI verb using exact argv, without a shell. Use --md for agent output. All CLI gates remain active; ship only after explicit user approval. Do not automatically retry failed mutations. Output is capped at 50KB/2000 lines, with larger output saved to a file.',
    parameters: Type.Object({ args: Type.Array(Type.String(), { minItems: 1 }) }),
    execute: async (_id, { args }, signal, _update, ctx) => runCli(args, ctx, signal),
  })
  if (process.env.PRJCT_PI_DELEGATE === '1') return
  pi.registerTool({
    name: 'prjct_agent',
    label: 'prjct delegate',
    description:
      'Execute one bounded task in an independent pi context, inheriting the current model and reasoning. Use when prjct requests an Agent, subagent, spec reviewer, judgment reviewer, challenger or re-judge. Return real findings to the parent, which records them with prjct CLI. No automatic approval. Read-only by default; provide all required evidence or explicit file paths. Set readOnly=false only for an authorized implementation task or a task requiring CLI access. Output capped at 50KB/2000 lines.',
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1 }),
      readOnly: Type.Optional(Type.Boolean({ default: true })),
    }),
    execute: async (_id, { prompt, readOnly }, signal, _update, ctx) =>
      runAgent(prompt, readOnly !== false, ctx, signal),
  })
}
