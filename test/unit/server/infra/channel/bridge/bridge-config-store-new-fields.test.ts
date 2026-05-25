
import {expect} from 'chai'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {BridgeConfigStore, resolveBridgeRuntimeConfig} from '../../../../../../src/server/infra/channel/bridge/bridge-config-store.js'

// Phase 9.5.9 §2.7 — new optional fields persisted to bridge-config.json.
// Verify each new field round-trips and env-override precedence is preserved.

describe('BridgeConfigStore — new §2.7 fields (Phase 9.5.9)', () => {
  let stateDir: string
  const logs: string[] = []
  const log = (msg: string): number => logs.push(msg)

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'brv-bridge-config-new-'))
    logs.length = 0
  })

  afterEach(() => {
    rmSync(stateDir, {force: true, recursive: true})
  })

  it('save() + load() round-trips claudeUnsafe=true', () => {
    const store = new BridgeConfigStore({stateDir})
    store.save({claudeUnsafe: true})
    expect(store.load().claudeUnsafe).to.equal(true)
  })

  it('save() + load() round-trips parleyDialTimeoutMs', () => {
    const store = new BridgeConfigStore({stateDir})
    store.save({parleyDialTimeoutMs: 30_000})
    expect(store.load().parleyDialTimeoutMs).to.equal(30_000)
  })

  it('save() + load() round-trips parleyTurnIdleTimeoutMs', () => {
    const store = new BridgeConfigStore({stateDir})
    store.save({parleyTurnIdleTimeoutMs: 120_000})
    expect(store.load().parleyTurnIdleTimeoutMs).to.equal(120_000)
  })

  it('save() + load() round-trips autoCreateQuota', () => {
    const store = new BridgeConfigStore({stateDir})
    store.save({autoCreateQuota: 10})
    expect(store.load().autoCreateQuota).to.equal(10)
  })

  // ─── resolveBridgeRuntimeConfig picks up new env vars ─────────────────

  it('BRV_BRIDGE_CLAUDE_UNSAFE=1 persists claudeUnsafe=true to file', () => {
    const store = new BridgeConfigStore({stateDir})
    const resolved = resolveBridgeRuntimeConfig({
      env: {BRV_BRIDGE_CLAUDE_UNSAFE: '1'},
      log,
      store,
    })
    expect(resolved.claudeUnsafe).to.equal(true)
    expect(store.load().claudeUnsafe).to.equal(true)
  })

  it('BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS persists and is returned', () => {
    const store = new BridgeConfigStore({stateDir})
    const resolved = resolveBridgeRuntimeConfig({
      env: {BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS: '45000'},
      log,
      store,
    })
    expect(resolved.parleyDialTimeoutMs).to.equal(45_000)
    expect(store.load().parleyDialTimeoutMs).to.equal(45_000)
  })

  it('BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS persists and is returned', () => {
    const store = new BridgeConfigStore({stateDir})
    const resolved = resolveBridgeRuntimeConfig({
      env: {BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS: '90000'},
      log,
      store,
    })
    expect(resolved.parleyTurnIdleTimeoutMs).to.equal(90_000)
    expect(store.load().parleyTurnIdleTimeoutMs).to.equal(90_000)
  })

  it('BRV_BRIDGE_AUTO_CREATE_QUOTA persists and is returned', () => {
    const store = new BridgeConfigStore({stateDir})
    const resolved = resolveBridgeRuntimeConfig({
      env: {BRV_BRIDGE_AUTO_CREATE_QUOTA: '3'},
      log,
      store,
    })
    expect(resolved.autoCreateQuota).to.equal(3)
    expect(store.load().autoCreateQuota).to.equal(3)
  })

  it('env override wins over previously persisted file value', () => {
    const store = new BridgeConfigStore({stateDir})
    store.save({parleyDialTimeoutMs: 10_000})
    resolveBridgeRuntimeConfig({
      env: {BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS: '20000'},
      log,
      store,
    })
    expect(store.load().parleyDialTimeoutMs).to.equal(20_000)
  })

  it('file value survives a no-env resolve (respawn-recovery path)', () => {
    const store = new BridgeConfigStore({stateDir})
    store.save({claudeUnsafe: true, parleyDialTimeoutMs: 30_000})
    const resolved = resolveBridgeRuntimeConfig({
      env: {},
      log,
      store,
    })
    expect(resolved.claudeUnsafe).to.equal(true)
    expect(resolved.parleyDialTimeoutMs).to.equal(30_000)
  })
})
