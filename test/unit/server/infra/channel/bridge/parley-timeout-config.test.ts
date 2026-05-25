// Phase 9.5.7 §3.3 Layer A — split timeout configuration tests.
//
// The plan adds two new env vars:
//   BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS — short timeout for the dial/protocol
//     phase. Defaults to 30_000ms (30s).
//   BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS — long idle/no-progress timeout
//     that RESETS on every frame received. Defaults to 3_600_000ms (60min).
//
// These are parsed via the bridge-config-store.ts pattern (readPositiveIntEnv).
// The exported parser helpers are tested here.

import {expect} from 'chai'

import {parseParleyTimeoutEnv} from '../../../../../../src/server/infra/channel/bridge/parley-timeout-config.js'

describe('parseParleyTimeoutEnv (phase 9.5.7 §3.3 Layer A — split timeouts)', () => {
  it('returns defaults when env vars are absent', () => {
    const result = parseParleyTimeoutEnv({})
    expect(result.dialTimeoutMs).to.equal(30_000)
    expect(result.idleTimeoutMs).to.equal(3_600_000)
  })

  it('parses BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS correctly', () => {
    const result = parseParleyTimeoutEnv({BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS: '10000'})
    expect(result.dialTimeoutMs).to.equal(10_000)
    expect(result.idleTimeoutMs).to.equal(3_600_000)  // default unchanged
  })

  it('parses BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS correctly', () => {
    const result = parseParleyTimeoutEnv({BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS: '120000'})
    expect(result.dialTimeoutMs).to.equal(30_000)  // default unchanged
    expect(result.idleTimeoutMs).to.equal(120_000)
  })

  it('falls back to default when BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS is non-numeric', () => {
    const result = parseParleyTimeoutEnv({BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS: 'not-a-number'})
    expect(result.dialTimeoutMs).to.equal(30_000)
  })

  it('falls back to default when BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS is zero', () => {
    const result = parseParleyTimeoutEnv({BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS: '0'})
    expect(result.dialTimeoutMs).to.equal(30_000)
  })

  it('falls back to default when BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS is negative', () => {
    const result = parseParleyTimeoutEnv({BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS: '-1000'})
    expect(result.dialTimeoutMs).to.equal(30_000)
  })

  it('parses both env vars when both are set', () => {
    const result = parseParleyTimeoutEnv({
      BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS: '5000',
      BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS: '7200000',
    })
    expect(result.dialTimeoutMs).to.equal(5000)
    expect(result.idleTimeoutMs).to.equal(7_200_000)
  })
})
