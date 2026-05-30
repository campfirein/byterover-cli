import type {z} from 'zod'

import {ChannelInvalidRequestError} from '../../../../core/domain/channel/errors.js'

/**
 * Validates `data` against `schema`, throwing {@link ChannelInvalidRequestError}
 * (CHANNEL_INVALID_REQUEST) with the flattened zod error as `details` when the
 * payload does not conform. Shared by the per-event channel handlers.
 */
export const parseOrThrow = <T>(schema: z.ZodType<T>, data: unknown): T => {
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    throw new ChannelInvalidRequestError(
      'channel request payload failed schema validation',
      parsed.error.flatten(),
    )
  }

  return parsed.data
}
