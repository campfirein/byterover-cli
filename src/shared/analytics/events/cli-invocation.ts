/**
 * Per-event schema for `cli_invocation`.
 *
 * Source of truth lives in `src/shared/analytics/cli-metadata-schema.ts`
 * — the same shape doubles as the `cli_metadata` block embedded in every
 * client-originated request schema (M13). Re-exported here under
 * `CliInvocationSchema` / `CliInvocationProps` so the analytics catalog
 * at `events/index.ts` keeps its existing import path.
 */
export {CliMetadataSchema as CliInvocationSchema} from '../cli-metadata-schema.js'
export type {CliMetadata as CliInvocationProps} from '../cli-metadata-schema.js'
