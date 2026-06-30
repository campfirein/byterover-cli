/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `hub_registry_removed`.
 */
export const HubRegistryRemovedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    registry_kind: z.string().min(1),
  })
  .strict()

export type HubRegistryRemovedProps = z.infer<typeof HubRegistryRemovedSchema>
