import { describe, expect, it } from 'bun:test'
import { analyzeCommentDiscipline } from '../../services/comment-discipline-detector'

describe('comment-discipline-detector', () => {
  it('flags a broad explanatory block without retaining its source text', () => {
    const secret = 'customer-secret-should-never-persist'
    const changedText = [
      '/*',
      ` * ${secret} This function starts by reading the account from storage.`,
      ' * It then checks whether the account has an active subscription.',
      ' * Next it calculates the amount that should be charged to the customer.',
      ' * After that it creates the payment request for the external provider.',
      ' * Finally it returns the response that came back from the provider.',
      ' * This explanation narrates the implementation instead of preserving intent.',
      ' */',
      'export function chargeAccount() {}',
    ].join('\n')

    const signal = analyzeCommentDiscipline({ filePath: 'src/billing.ts', changedText })

    expect(signal?.reason).toBe('long-comment-block')
    expect(JSON.stringify(signal)).not.toContain(secret)
    expect(signal?.expectedBehavior).toContain('intent, invariants')
  })

  it('keeps short intent and invariant comments quiet', () => {
    const changedText = [
      '// Keep the idempotency key stable across retries.',
      'const key = request.id',
      '// Stripe may deliver the same event more than once.',
      'dedupe(event.id)',
    ].join('\n')

    expect(analyzeCommentDiscipline({ filePath: 'src/payments.ts', changedText })).toBeNull()
  })

  it('ignores public API documentation and tool directives', () => {
    const publicDocs = [
      '/**',
      ' * Resolve an account from its stable identifier and return the current state.',
      ' * The caller can use the result to render an account summary or retry later.',
      ' * The operation preserves the current tenant scope throughout the lookup.',
      ' * It rejects identifiers that belong to a different tenant or organization.',
      ' * The returned record is immutable and safe to share with downstream readers.',
      ' * @param accountId stable public identifier for the account',
      ' * @returns the current account state',
      ' */',
      'export function resolveAccount(accountId: string): Account {}',
      '// biome-ignore lint/suspicious/noExplicitAny: generated interop surface',
    ].join('\n')

    expect(
      analyzeCommentDiscipline({ filePath: 'src/public-api.ts', changedText: publicDocs })
    ).toBeNull()
  })

  it('still reviews verbose internal JSDoc without public API tags', () => {
    const internalDocs = [
      '/**',
      ' * First load the internal state from the cache using the supplied key.',
      ' * Then inspect whether the state has expired according to the current clock.',
      ' * Next load the same state from storage when the cached copy is unavailable.',
      ' * After loading it transform every field into the internal representation.',
      ' * Finally return the transformed state to the private helper that requested it.',
      ' * This block narrates each implementation step without preserving a constraint.',
      ' */',
      'function loadInternalState() {}',
    ].join('\n')
    expect(
      analyzeCommentDiscipline({ filePath: 'src/internal-state.ts', changedText: internalDocs })
        ?.reason
    ).toBe('long-comment-block')
  })

  it('does not treat C preprocessor directives as comments', () => {
    const includes = Array.from({ length: 15 }, (_, index) => `#include <header${index}.h>`).join(
      '\n'
    )
    expect(analyzeCommentDiscipline({ filePath: 'src/native.c', changedText: includes })).toBeNull()
  })

  it('ignores prose and generated outputs', () => {
    const verbose = `// ${'explanation '.repeat(120)}`
    expect(analyzeCommentDiscipline({ filePath: 'README.md', changedText: verbose })).toBeNull()
    expect(
      analyzeCommentDiscipline({ filePath: 'dist/generated/client.ts', changedText: verbose })
    ).toBeNull()
  })
})
