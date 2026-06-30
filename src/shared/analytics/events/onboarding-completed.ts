/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `onboarding_completed`.
 *
 * Activation funnel terminal. `steps_completed_count` is only meaningful
 * on success and so is optional. `outcome` covers both terminals.
 */
export const OnboardingCompletedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    steps_completed_count: z.number().int().nonnegative().optional(),
  })
  .strict()

export type OnboardingCompletedProps = z.infer<typeof OnboardingCompletedSchema>
