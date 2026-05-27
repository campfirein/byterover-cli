/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `onboarding_auto_setup_started`.
 *
 * The onboarding flow began an auto-setup pass. `mode` discriminates entry
 * modes (e.g. `auto`, `manual`). `outcome` covers the start-attempt
 * terminal — `success` if the auto-setup actually kicked off, `failure` if
 * the start path errored.
 */
export const OnboardingAutoSetupStartedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    mode: z.string().min(1),
    outcome: z.enum(['success', 'failure']),
  })
  .strict()

export type OnboardingAutoSetupStartedProps = z.infer<typeof OnboardingAutoSetupStartedSchema>
