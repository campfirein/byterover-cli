import {timingSafeEqual} from 'node:crypto'

import type {RequestContext, RequestHandler} from '../../core/interfaces/transport/i-transport-server.js'

import {ChannelUnauthorizedError} from '../../core/domain/channel/errors.js'

/**
 * Constant-time token comparison (review fix #5). Daemon-auth-token rides
 * over a localhost-only socket, so the practical timing-attack surface is
 * dwarfed by network jitter, but `===` is short-circuiting and worth
 * replacing as defense-in-depth.
 *
 * Pads both candidates to the longer length so `timingSafeEqual` can run
 * (it requires equal-length buffers); length mismatches always return false
 * AFTER the constant-time compare.
 */
const constantTimeEqual = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  const max = Math.max(aBuf.length, bBuf.length)
  const aPadded = Buffer.alloc(max)
  const bPadded = Buffer.alloc(max)
  aBuf.copy(aPadded)
  bBuf.copy(bPadded)
  const equalLength = aBuf.length === bBuf.length
  return timingSafeEqual(aPadded, bPadded) && equalLength
}

/**
 * Channel auth middleware (DESIGN §5.6 step 5; CHANNEL_PROTOCOL.md §2).
 *
 * Wraps every `channel:*` request handler with a token check. As of Slice
 * 3.5a the expected token is resolved via a provider callback per request
 * so {@link DaemonTokenProvider.rotate} takes effect without re-registering
 * handlers. The string-literal overload is preserved for back-compat with
 * existing tests that build a static token.
 *
 * Behaviour:
 *  - Missing `ctx.auth.token` → throws ChannelUnauthorizedError.
 *  - Token mismatch with the value returned by the provider → throws
 *    ChannelUnauthorizedError.
 *  - Valid token → handler runs with the original (data, clientId, ctx).
 *
 * Origin-check tightening (Layer 2 per DESIGN §5.6 step 4) lands in Slice
 * 3.5b.
 */

export type ChannelAuthMiddleware = <TReq, TRes>(
  inner: RequestHandler<TReq, TRes>,
) => RequestHandler<TReq, TRes>

export const makeChannelAuthMiddleware = (
  expectedTokenOrProvider: (() => string) | string,
): ChannelAuthMiddleware => {
  const provider = typeof expectedTokenOrProvider === 'function'
    ? expectedTokenOrProvider
    : (): string => expectedTokenOrProvider

  return <TReq, TRes>(inner: RequestHandler<TReq, TRes>): RequestHandler<TReq, TRes> =>
    async (data: TReq, clientId: string, ctx?: RequestContext): Promise<TRes> => {
      const token = ctx?.auth?.token
      if (token === undefined || token.length === 0) {
        throw new ChannelUnauthorizedError('missing daemon auth token')
      }

      if (!constantTimeEqual(token, provider())) {
        throw new ChannelUnauthorizedError('invalid daemon auth token')
      }

      return inner(data, clientId, ctx)
    }
}
