import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {DaemonTokenProvider} from '../../../../../src/server/infra/auth/daemon-token-provider.js'

// Slice 3.5a — Mutable token provider that wraps the disk-backed token store.
// Auth middleware reads via `getCurrent()` so rotation takes effect without
// re-registering handlers. `rotate()` regenerates + atomically writes the new
// token AND updates the in-memory cache before any awaited side-effect, so the
// very next request authenticated with the old token fails.

describe('DaemonTokenProvider', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'brv-token-provider-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, {force: true, recursive: true})
  })

  it('initializes with the on-disk token (generates one if missing)', async () => {
    const provider = await DaemonTokenProvider.boot({dataDir})
    const token = provider.getCurrent()
    expect(token).to.match(/^[\da-f]{64,}$/i)

    // On-disk file matches.
    const onDisk = await fs.readFile(join(dataDir, 'state', 'daemon-auth-token'), 'utf8')
    expect(onDisk.trim()).to.equal(token)
  })

  it('rotate() replaces the in-memory token AND the on-disk file', async () => {
    const provider = await DaemonTokenProvider.boot({dataDir})
    const before = provider.getCurrent()

    const {disconnectedClients, tokenFingerprint} = await provider.rotate()
    const after = provider.getCurrent()

    expect(after).to.not.equal(before)
    expect(after).to.match(/^[\da-f]{64,}$/i)
    expect(tokenFingerprint).to.be.a('string').and.have.lengthOf(12)
    expect(disconnectedClients).to.equal(0) // No disconnect hook injected yet.

    const onDisk = (await fs.readFile(join(dataDir, 'state', 'daemon-auth-token'), 'utf8')).trim()
    expect(onDisk).to.equal(after)
  })

  it('rotate() calls the optional disconnect hook and reports the count', async () => {
    let calls = 0
    const provider = await DaemonTokenProvider.boot({
      dataDir,
      async disconnectAllChannelClients() {
        calls += 1
        return 3
      },
    })
    const {disconnectedClients} = await provider.rotate()
    expect(calls).to.equal(1)
    expect(disconnectedClients).to.equal(3)
  })

  it('rotate() updates the cache BEFORE the disconnect hook runs', async () => {
    // The hook captures the value the provider reports DURING the rotation.
    let captured: string | undefined
    const provider = await DaemonTokenProvider.boot({
      dataDir,
      async disconnectAllChannelClients() {
        captured = provider.getCurrent()
        return 0
      },
    })
    const before = provider.getCurrent()
    await provider.rotate()
    const after = provider.getCurrent()
    expect(captured).to.equal(after)
    expect(captured).to.not.equal(before)
  })

  it('tokenFingerprint is sha256(token).slice(0, 12) hex', async () => {
    const provider = await DaemonTokenProvider.boot({dataDir})
    const {createHash} = await import('node:crypto')
    const expected = createHash('sha256').update(provider.getCurrent()).digest('hex').slice(0, 12)
    expect(provider.tokenFingerprint()).to.equal(expected)
  })
})
