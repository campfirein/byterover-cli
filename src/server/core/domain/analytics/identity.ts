 

/**
 * Wire-format identity attached to every analytics event. `device_id` is
 * always present (M1.1 invariant); `user_id` / `email` / `name` are only
 * present when the user is authenticated.
 *
 * Snake_case on the wire per the analytics spec; this is the only
 * identity shape — no internal camelCase variant exists.
 */
export type Identity = Readonly<{
  device_id: string
  email?: string
  name?: string
  user_id?: string
}>
