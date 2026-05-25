import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_FLAKY = resolve(HERE, '..', 'fixtures', 'mock-acp-flaky-handshake.js')

// Slice 3.1 — onboarding a candidate whose `session/new` errors out MUST
// NOT persist the profile. The onboard response surfaces a
// DoctorDiagnostic[] with at least one entry of severity 'error', and the
// CLI exits non-zero.

describe('Channel Phase 3 — onboard failure', () => {
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

  it('refuses to persist a profile when session/new fails', async () => {
    const onboard = await harness.run(
      `channel onboard flaky -- node ${FIXTURE_FLAKY} --json`,
    )
    expect(onboard.exitCode).to.not.equal(0)
    expect(onboard.stderr + onboard.stdout).to.match(/session\/new|ACP_SESSION_FAILED|driver class/i)

    // Registry MUST be untouched.
    const list = parseJson<{profiles: unknown[]}>((await harness.run('channel profile list --json')).stdout)
    expect(list.profiles).to.deep.equal([])

    const registryPath = join(harness.dataDir, 'state', 'agent-driver-profiles.json')
    const exists = await fs
      .stat(registryPath)
      .then(() => true)
      .catch(() => false)
    if (exists) {
      const registry = JSON.parse(await fs.readFile(registryPath, 'utf8')) as {
        profiles: unknown[]
      }
      expect(registry.profiles).to.deep.equal([])
    }
  })
})
