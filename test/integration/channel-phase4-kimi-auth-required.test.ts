import {expect} from 'chai'
import {existsSync} from 'node:fs'
import {join} from 'node:path'

import {ChannelTestHarness} from '../helpers/channel-test-harness.js'
import {requireKimiAcp} from '../helpers/kimi-acp-e2e.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

// Slice 4.1 — Phase-4 E2E auth-required path.
//
// Empty KIMI_SHARE_DIR (no copied credentials) → kimi raises AUTH_REQUIRED
// on the first session/new probe. Currently expected to fail because the
// driver lets the JSON-RPC error escape as a generic AcpHandshakeFailedError
// (no exit-65 path, no remediation text). Goalpost for Slice 4.2.

describe('Channel Phase 4 — real kimi-acp AUTH_REQUIRED', function () {
  this.timeout(60_000)

  let harness: ChannelTestHarness | undefined
  let projectDir: string | undefined
  let kimi: ReturnType<typeof requireKimiAcp>

  beforeEach(async function () {
    kimi = requireKimiAcp(this, {requireLoggedIn: false})
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

  it('exits 65 with AUTH_REQUIRED guidance and persists no profile', async () => {
    if (kimi === undefined || harness === undefined) return

    const onboard = await harness.run(`channel onboard kimi -- ${kimi.binaryPath} acp`, {
      env: {KIMI_SHARE_DIR: kimi.shareDir},
    })
    expect(onboard.exitCode, `expected exit 65, got ${onboard.exitCode}: ${onboard.stderr}`).to.equal(65)
    expect(onboard.stderr).to.match(/AUTH_REQUIRED/i)
    expect(onboard.stderr).to.match(/kimi login/i)

    const registryPath = join(harness.dataDir, 'state', 'agent-driver-profiles.json')
    expect(existsSync(registryPath), 'profile registry must not be created on AUTH_REQUIRED').to.equal(false)

    const metadataPath = join(harness.dataDir, 'state', 'agent-driver-profile-metadata.json')
    expect(existsSync(metadataPath), 'no metadata record for a first-time auth failure').to.equal(false)
  })
})
