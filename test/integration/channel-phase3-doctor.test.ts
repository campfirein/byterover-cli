import {expect} from 'chai'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_CLASS_A = resolve(HERE, '..', 'fixtures', 'mock-acp-class-a.js')

// Slice 3.1 — `brv channel doctor pi-test` returns structured diagnostics
// covering pool/broker/profile state. At least the system-level diagnostics
// (member idle, no recent turn, etc.) are present.

describe('Channel Phase 3 — doctor', () => {
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

  it('returns diagnostics for a channel with one onboarded member', async () => {
    await harness.run(`channel onboard mock -- node ${FIXTURE_CLASS_A}`)
    await harness.run('channel new pi-test')
    await harness.run('channel invite pi-test @mock --profile mock')

    const doctor = await harness.run('channel doctor pi-test --json')
    expect(doctor.exitCode, doctor.stderr).to.equal(0)
    const parsed = parseJson<{diagnostics: Array<{code: string; severity: string}>}>(doctor.stdout)
    expect(parsed.diagnostics).to.be.an('array')
    expect(parsed.diagnostics.length).to.be.greaterThan(0)

    const codes = new Set(parsed.diagnostics.map((d) => d.code))
    // At minimum the doctor MUST surface the member-idle info diagnostic.
    expect(codes.has('DOCTOR_MEMBER_IDLE')).to.equal(true)
  })
})
