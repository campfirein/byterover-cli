import type {AgentDriverProfile} from '../../../../shared/types/index.js'

/**
 * Driver-profile registry contract.
 *
 * Persists {@link AgentDriverProfile} entries (runtime invocation recipes that
 * `channel:onboard` writes after probing a candidate agent). `channel:invite`
 * references them by name instead of re-passing the inline invocation.
 *
 *  - `list()` returns every persisted profile, sorted by name (`[]` when the
 *    backing file is missing).
 *  - `get(name)` returns one profile or `undefined`.
 *  - `upsert(profile)` writes the registry; replacing a profile by name is a
 *    last-write-wins update.
 *  - `remove(name)` deletes a profile by name and returns whether anything was
 *    removed (idempotent).
 *
 * Implementations MUST write atomically so a crash mid-write cannot leave a
 * partial file, and MUST treat a corrupt registry as empty (the next `upsert`
 * overwrites the corruption with a valid document).
 */
export interface IDriverProfileStore {
  get(name: string): Promise<AgentDriverProfile | undefined>
  list(): Promise<AgentDriverProfile[]>
  remove(name: string): Promise<boolean>
  upsert(profile: AgentDriverProfile): Promise<void>
}
