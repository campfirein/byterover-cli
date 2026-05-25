import type {BridgePersistedConfig} from '../channel/bridge/bridge-config-store.js'

/**
 * Phase 9.5 §3.1 — daemon respawn rebind.
 *
 * Returns `true` when the persisted bridge config contains any field that
 * indicates the operator has set up a bridge on this install. In that case,
 * `brv-server.ts` calls `ensureBridgeHost()` eagerly at daemon startup so
 * the libp2p listener is bound before the first CLI call, rather than
 * silently losing the bridge listener on auto-respawn.
 *
 * "Bridge-side state" means: any field that either changes how the listener
 * is bound (`listenAddrs`) or configures active bridge behaviour
 * (`parleyProfile`, `autoProvision`, `maxConcurrentPerProfile`). The
 * `projectRoot`-only case is not counted because that field is also written
 * by `brv bridge whoami` on fresh installs that haven't yet run a bridge
 * command.
 *
 * Unconditionally calling `ensureBridgeHost()` at startup costs a couple of
 * seconds for libp2p node initialisation, paid once per daemon lifetime.
 * Correctness: any subsequent CLI call hits a hot, bound bridge.
 */
export function hasBridgePersistedState(config: BridgePersistedConfig): boolean {
  return (
    config.listenAddrs !== undefined ||
    config.parleyProfile !== undefined ||
    config.autoProvision !== undefined ||
    config.maxConcurrentPerProfile !== undefined
  )
}
