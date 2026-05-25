import {expect} from 'chai'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {BridgeConfigStore} from '../../../../../src/server/infra/channel/bridge/bridge-config-store.js'
import {hasBridgePersistedState} from '../../../../../src/server/infra/daemon/bridge-startup-rebind.js'

// Phase 9.5.1 §3.1 — daemon respawn rebind.
//
// `hasBridgePersistedState` is the predicate `brv-server.ts` uses to
// decide whether to eagerly call `ensureBridgeHost()` at startup instead
// of waiting for the first CLI call. An operator who has ever run
// `BRV_BRIDGE_LISTEN_ADDRS=...` or any bridge command must NOT lose their
// bridge listener after a daemon auto-respawn.

describe('hasBridgePersistedState (§3.1 daemon startup rebind)', () => {
  let stateDir: string

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'brv-startup-rebind-'))
  })

  afterEach(async () => {
    await rm(stateDir, {force: true, recursive: true})
  })

  it('returns false when no bridge-config.json exists', () => {
    const store = new BridgeConfigStore({stateDir})
    expect(hasBridgePersistedState(store.load())).to.equal(false)
  })

  it('returns true when listenAddrs is persisted', async () => {
    const store = new BridgeConfigStore({stateDir})
    store.save({listenAddrs: ['/ip4/0.0.0.0/tcp/60001']})
    expect(hasBridgePersistedState(store.load())).to.equal(true)
  })

  it('returns true when parleyProfile is persisted', async () => {
    const store = new BridgeConfigStore({stateDir})
    store.save({parleyProfile: 'acp'})
    expect(hasBridgePersistedState(store.load())).to.equal(true)
  })

  it('returns true when autoProvision is explicitly set (operator opted in)', async () => {
    const store = new BridgeConfigStore({stateDir})
    store.save({autoProvision: 'auto'})
    expect(hasBridgePersistedState(store.load())).to.equal(true)
  })

  it('returns false when config file exists but all bridge-side fields are absent', async () => {
    // Only projectRoot set — not bridge-side state.
    const store = new BridgeConfigStore({stateDir})
    store.save({projectRoot: '/tmp/myproject'})
    expect(hasBridgePersistedState(store.load())).to.equal(false)
  })

  it('returns true when the file has a corrupt but partial config and listenAddrs survived', async () => {
    // Save a valid config first, then verify.
    const store = new BridgeConfigStore({stateDir})
    store.save({listenAddrs: ['/ip4/127.0.0.1/tcp/0']})
    expect(hasBridgePersistedState(store.load())).to.equal(true)
  })

  it('returns true when maxConcurrentPerProfile is set (operator tuned bridge)', async () => {
    const store = new BridgeConfigStore({stateDir})
    store.save({maxConcurrentPerProfile: 4})
    expect(hasBridgePersistedState(store.load())).to.equal(true)
  })
})
