import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

// Slice 3.1 — Phase-3 onboarding happy path. After Slices 3.2 (probe +
// onboard service) and 3.6 (`brv channel onboard` command) land, this test
// goes green. Until then it fails with "command not found" or schema
// mismatch — the canonical Phase-3 outside-in red signal.

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_CLASS_A = resolve(HERE, '..', 'fixtures', 'mock-acp-class-a.js')
const FIXTURE_CLASS_B = resolve(HERE, '..', 'fixtures', 'mock-acp-class-b.js')

describe('Channel Phase 3 — onboard happy path', () => {
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

  it('classifies a class-A agent + persists the profile with probedAt', async () => {
    const onboard = await harness.run(
      `channel onboard kimi -- node ${FIXTURE_CLASS_A}`,
      {env: {}},
    )
    expect(onboard.exitCode, onboard.stderr).to.equal(0)

    const list = await harness.run('channel profile list --json')
    expect(list.exitCode, list.stderr).to.equal(0)
    const parsed = parseJson<{profiles: Array<{driverClass: string; name: string; probedAt?: string}>}>(list.stdout)
    expect(parsed.profiles).to.have.lengthOf(1)
    expect(parsed.profiles[0].name).to.equal('kimi')
    expect(parsed.profiles[0].driverClass).to.equal('A')
    expect(parsed.profiles[0].probedAt).to.be.a('string')

    // The registry is persisted on disk under the test harness data dir.
    const registry = JSON.parse(
      await fs.readFile(join(harness.dataDir, 'state', 'agent-driver-profiles.json'), 'utf8'),
    ) as {profiles: Array<{name: string}>}
    expect(registry.profiles.map((p) => p.name)).to.deep.equal(['kimi'])
  })

  it('classifies a class-B agent (no embeddedContext, no image) as B', async () => {
    const onboard = await harness.run(`channel onboard plain -- node ${FIXTURE_CLASS_B}`)
    expect(onboard.exitCode, onboard.stderr).to.equal(0)
    const show = parseJson<{profile: {driverClass: string; name: string}}>(
      (await harness.run('channel profile show plain --json')).stdout,
    )
    expect(show.profile.driverClass).to.equal('B')
  })
})

