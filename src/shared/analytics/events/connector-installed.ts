/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `connector_installed`.
 *
 * `connector_id` identifies which connector (e.g. `claude-code`, `cursor`,
 * `amp`); `agent_target` is the external coding-agent surface it installs
 * into. `outcome` covers both terminals; `failure_kind` is a coarse tag.
 */
export const ConnectorInstalledSchema = z
  .object({
    agent_target: z.string().min(1),
    connector_id: z.string().min(1),
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
  })
  .strict()

export type ConnectorInstalledProps = z.infer<typeof ConnectorInstalledSchema>
