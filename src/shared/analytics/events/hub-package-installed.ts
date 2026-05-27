/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `hub_package_installed`.
 *
 * Context Hub install (npm-style). `package_identifier` is the
 * `<team>/<space>` identifier known at request time; `version_pin` is the
 * resolved version pin (only known on success — optional). `outcome`
 * covers both terminals; `failure_kind` is a coarse tag.
 */
export const HubPackageInstalledSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    package_identifier: z.string().min(1),
    version_pin: z.string().min(1).optional(),
  })
  .strict()

export type HubPackageInstalledProps = z.infer<typeof HubPackageInstalledSchema>
