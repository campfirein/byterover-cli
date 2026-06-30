/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `auth_logout`.
 *
 * Carries the lifecycle outcome (`success` | `failure`). On success the
 * emit fires BEFORE `tokenStore.clear()` so the per-event identity is the
 * logged-in user that just opted out. On failure (e.g. `tokenStore.clear()`
 * threw, `disconnectByteRoverProvider()` threw, or `loadToken()` threw)
 * the identity is whatever the in-memory store still holds — which is the
 * logged-in user because identity rebinding hasn't happened yet.
 *
 * `failure_kind` should be a coarse enum-like tag (e.g. `'token_clear'`,
 * `'provider_disconnect'`, `'state_reload'`, `'unknown'`) — see
 * `auth-login.ts` for the rationale. Never put raw error messages here.
 */
export const AuthLogoutSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
  })
  .strict()

export type AuthLogoutProps = z.infer<typeof AuthLogoutSchema>
