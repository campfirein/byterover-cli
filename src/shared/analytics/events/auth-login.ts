/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `auth_login`.
 *
 * Carries the lifecycle outcome (`success` | `failure`) so a single event
 * name covers both the OAuth success terminal and the failure terminal.
 * `failure_kind` is a coarse enum-like tag (free string today but emitters
 * should pick from a small discrete vocabulary like `'callback_timeout'`,
 * `'token_exchange'`, `'user_fetch'`, `'token_save'`, `'state_reload'`,
 * `'unknown'`) so downstream consumers can aggregate failure modes without
 * raw error-message PII risk. Never put `error_message`-style free text in
 * `failure_kind`.
 *
 * Identity (the new authenticated `user_id` on success, anonymous on
 * failure) is stamped on the per-event identity by the resolver;
 * `client_kind` is stamped on the envelope by the super-property layer.
 *
 * M6's Mixpanel forwarding pipeline keys its server-side
 * `alias(deviceId -> User.id)` off `{name: auth_login, outcome: success}`.
 */
export const AuthLoginSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
  })
  .strict()

export type AuthLoginProps = z.infer<typeof AuthLoginSchema>
