/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `hub_registry_added`.
 *
 * Adds a registry source to the Context Hub config. `registry_kind`
 * classifies the registry type; `is_default` flags whether it was added
 * as the default. `is_default` is optional because the current handler
 * request shape doesn't carry it — emitters that don't know the value
 * MAY omit. `outcome` covers both terminals.
 */
export const HubRegistryAddedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    is_default: z.boolean().optional(),
    outcome: z.enum(['success', 'failure']),
    registry_kind: z.string().min(1),
  })
  .strict()

export type HubRegistryAddedProps = z.infer<typeof HubRegistryAddedSchema>
