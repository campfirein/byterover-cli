import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {join} from 'node:path'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {requireKimiAcp} from '../helpers/kimi-acp-e2e.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

// Slice 4.1 — Phase-4 E2E onboard test against the real `kimi acp` binary.
//
// Goalpost for Slice 4.4 (handshake timeout): currently expected to fail
// because the implicit 5_000 ms handshake budget is too tight for kimi's
// cold start. After 4.4 (default → 15_000 ms), this goes green.
//
// Gated on `KIMI_ACP_E2E=1` AND the `kimi` binary being on PATH AND a
// previously-completed `kimi login`. Skips cleanly otherwise so contributors
// without kimi-cli installed see green CI.

describe('Channel Phase 4 — real kimi-acp onboard', function () {
  this.timeout(120_000)

  let harness: ChannelTestHarness | undefined
  let projectDir: string | undefined
  let kimi: ReturnType<typeof requireKimiAcp>

  beforeEach(async function () {
    kimi = requireKimiAcp(this, {requireLoggedIn: true})
    if (kimi === undefined) return
    projectDir = await makeTempContextTree()
    harness = await ChannelTestHarness.boot({projectDir})
  })

  afterEach(async () => {
    if (harness !== undefined) await harness.shutdown()
    if (projectDir !== undefined) await removeTempDir(projectDir)
    kimi?.cleanup()
    harness = undefined
    projectDir = undefined
  })

  it('classifies kimi as driver class A and persists the profile (0600)', async () => {
    if (kimi === undefined || harness === undefined) return

    const onboard = await harness.run(`channel onboard kimi -- ${kimi.binaryPath} acp`, {
      env: {KIMI_SHARE_DIR: kimi.shareDir},
    })
    expect(onboard.exitCode, onboard.stderr).to.equal(0)

    const list = await harness.run('channel profile list --json')
    expect(list.exitCode, list.stderr).to.equal(0)
    const parsed = parseJson<{
      profiles: Array<{capabilities?: string[]; driverClass: string; name: string; probedAt?: string}>
    }>(list.stdout)

    expect(parsed.profiles).to.have.lengthOf(1)
    expect(parsed.profiles[0].name).to.equal('kimi')
    expect(parsed.profiles[0].driverClass).to.equal('A')
    expect(parsed.profiles[0].capabilities ?? []).to.include('embeddedContext')
    expect(parsed.profiles[0].capabilities ?? []).to.include('image')
    expect(parsed.profiles[0].probedAt).to.be.a('string')

    const registryPath = join(harness.dataDir, 'state', 'agent-driver-profiles.json')
    const stat = await fs.stat(registryPath)
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).to.equal(0o600)
  })
})
