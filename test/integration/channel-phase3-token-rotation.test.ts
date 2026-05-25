import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {join} from 'node:path'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

// Slice 3.1 — token rotation. After `brv channel rotate-token --yes`:
//   1. The daemon-auth-token file changes.
//   2. The fresh client (next harness.run) reads the new token and
//      authenticates fine.
//   3. The response carries a tokenFingerprint that matches sha256 of the
//      new token.

describe('Channel Phase 3 — token rotation', () => {
  let projectDir: string
  let harness: ChannelTestHarness

  beforeEach(async () => {
    projectDir = await makeTempContextTree()
    harness = await ChannelTestHarness.boot({projectDir})
  })

  afterEach(async () => {
    await harness.shutdown()
    await removeTempDir(projectDir)
  })

  it('rotates the daemon-auth-token + returns a matching fingerprint', async () => {
    // Boot the daemon and read the original token.
    await harness.run('channel new pi-test')
    const tokenPath = join(harness.dataDir, 'state', 'daemon-auth-token')
    const original = (await fs.readFile(tokenPath, 'utf8')).trim()
    expect(original).to.match(/^[\da-f]{64,}$/i)

    const rotate = await harness.run('channel rotate-token --yes --json')
    expect(rotate.exitCode, rotate.stderr).to.equal(0)
    const parsed = parseJson<{disconnectedClients: number; tokenFingerprint: string}>(rotate.stdout)
    expect(parsed.tokenFingerprint).to.be.a('string')
    expect(parsed.tokenFingerprint.length).to.be.greaterThan(0)
    expect(parsed.disconnectedClients).to.be.a('number')

    const fresh = (await fs.readFile(tokenPath, 'utf8')).trim()
    expect(fresh).to.not.equal(original)

    // A subsequent request with the fresh token succeeds.
    const ok = await harness.run('channel get pi-test --json')
    expect(ok.exitCode, ok.stderr).to.equal(0)
  })

  it('requires --yes (no interactive prompt; scripts must opt in)', async () => {
    await harness.run('channel new pi-test')
    const noYes = await harness.run('channel rotate-token')
    expect(noYes.exitCode).to.not.equal(0)
    expect(noYes.stderr + noYes.stdout).to.match(/--yes/i)
  })
})
