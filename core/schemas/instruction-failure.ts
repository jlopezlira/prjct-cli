import { z } from 'zod'

const TrimmedIdentifierSchema = z.string().trim().min(1).max(200)
const BehaviorSchema = z.string().trim().min(1).max(2_000)

export const InstructionFailureDispositionSchema = z.enum(['open', 'resolved', 'false_positive'])
export type InstructionFailureDisposition = z.infer<typeof InstructionFailureDispositionSchema>

/** Strict boundary: transcript-shaped or otherwise unknown fields are rejected. */
export const InstructionFailureInputSchema = z
  .object({
    source: TrimmedIdentifierSchema,
    runtime: TrimmedIdentifierSchema,
    model: TrimmedIdentifierSchema,
    sessionId: TrimmedIdentifierSchema.nullish(),
    taskId: TrimmedIdentifierSchema.nullish(),
    category: TrimmedIdentifierSchema,
    expectedBehavior: BehaviorSchema,
    observedBehavior: BehaviorSchema,
    relatedRuleId: TrimmedIdentifierSchema.nullish(),
    occurredAt: z.string().datetime().optional(),
  })
  .strict()
export type InstructionFailureInput = z.infer<typeof InstructionFailureInputSchema>

export const InstructionFailureSchema = InstructionFailureInputSchema.omit({ occurredAt: true })
  .extend({
    id: z.string().min(1),
    projectId: z.string().min(1),
    dedupKey: z.string().length(64),
    disposition: InstructionFailureDispositionSchema,
    occurredAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict()
export type InstructionFailure = z.infer<typeof InstructionFailureSchema>
