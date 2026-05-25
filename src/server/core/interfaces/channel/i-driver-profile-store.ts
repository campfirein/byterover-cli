import type {AgentDriverProfile} from '../../../../shared/types/channel.js'

/**
 * Driver-profile registry contract (Slice 3.0).
 *
 * Persists {@link AgentDriverProfile} entries under
 * `$BRV_DATA_DIR/state/agent-driver-profiles.json`. Profiles are runtime
 * invocation recipes that {@link channel:onboard} writes after probing a
 * candidate agent; {@link channel:invite} can then reference them by name
 * instead of re-passing the inline invocation.
 *
 *  - `list()` returns every persisted profile, sorted by name. `[]` when the
 *    backing file is missing.
 *  - `get(name)` returns one profile or `undefined`.
 *  - `upsert(profile)` writes the registry atomically (mode 0600). Replacing
 *    an existing profile by name is a last-write-wins update.
 *  - `remove(name)` deletes a profile by name and returns whether anything
 *    was removed (idempotent).
 *
 * Implementations MUST use atomic rename for every write so a crash mid-
 * write cannot leave a partial JSON file behind. Implementations MUST also
 * tolerate a corrupt registry by treating it as empty (the next `upsert`
 * overwrites the corruption with a valid document).
 */
export interface IDriverProfileStore {
  get(name: string): Promise<AgentDriverProfile | undefined>
  list(): Promise<AgentDriverProfile[]>
  remove(name: string): Promise<boolean>
  upsert(profile: AgentDriverProfile): Promise<void>
}
