import type {Config} from '@oclif/core'

import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import {restore, stub} from 'sinon'

import Dream from '../../src/oclif/commands/dream.js'
import DreamCancel from '../../src/oclif/commands/dream/cancel.js'
import DreamSessions from '../../src/oclif/commands/dream/sessions.js'

// `brv dream` (no subcommand) is now a topic root — see ENG-2884.
// The LLM-driven consolidate/synthesize/prune dispatch was removed;
// users run `brv dream {scan,finalize,undo,sessions,cancel}` instead.
// This file keeps a minimal smoke around the topic root so the command
// continues to load and prints the migration hint.

describe('Dream Command (topic root)', () => {
  let config: Config
  let loggedMessages: string[]

  before(async () => {
    config = await OclifConfig.load(import.meta.url)
  })

  beforeEach(() => {
    loggedMessages = []
  })

  afterEach(() => {
    restore()
  })

  it('prints the subcommand migration hint and exits 0', async () => {
    const command = new Dream([], config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })

    await command.run()

    expect(loggedMessages).to.have.lengthOf.at.least(1)
    expect(loggedMessages.join('\n')).to.include('brv dream')
    expect(loggedMessages.join('\n')).to.include('scan')
    expect(loggedMessages.join('\n')).to.include('finalize')
    expect(loggedMessages.join('\n')).to.include('undo')
  })

  it('rejects --timeout with a migration message before printing the hint', async () => {
    // Pins the findRemovedFlagMessage(this.argv, DREAM_REMOVED_FLAGS)
    // wire-up in dream.ts's run() body. The argv-scanner check fires
    // BEFORE the topic-root listing line, so a future refactor that
    // accidentally drops the call would silently regress to the
    // pre-removal state — no test would catch it without this.
    //
    // text mode: this.error(..., {exit: 1}) throws synchronously; the
    // log stub must never run.
    const command = new Dream(['--timeout', '30'], config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })

    let caught: unknown
    try {
      await command.run()
    } catch (error) {
      caught = error
    }

    expect(caught, 'this.error must throw on a removed-flag match').to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('--timeout')
    expect(
      loggedMessages,
      'log must not run after this.error throws (early-exit ordering)',
    ).to.have.lengthOf(0)
  })

  it('emits a JSON envelope migration error for --timeout when --format json is set', async () => {
    // JSON-format path takes the writeJsonResponse branch (does NOT throw),
    // so the run() body returns and the topic-root listing is suppressed.
    // We assert the envelope hits stdout AND the log stub stays empty.
    const command = new Dream(['--timeout', '30', '--format', 'json'], config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })
    let writtenJson = ''
    stub(process.stdout, 'write').callsFake((chunk: string | Uint8Array): boolean => {
      writtenJson += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    })

    await command.run()

    const parsed = JSON.parse(writtenJson.trim())
    expect(parsed.success).to.equal(false)
    expect(parsed.data.status).to.equal('error')
    expect(parsed.data.error).to.include('--timeout')
    expect(
      loggedMessages,
      'log must not run after writeJsonResponse on removed-flag match',
    ).to.have.lengthOf(0)
  })

  // Sessions and cancel are v1 stubs — the daemon has no session
  // state to list or clean up. Their surface MUST disclose that
  // honestly so machine-readable consumers don't act on success-looking
  // JSON envelopes thinking real state was queried/mutated.
  describe('v1-stub disclosure', () => {
    it('exposes [v1 stub] in the static description of dream sessions', () => {
      expect(DreamSessions.description.toLowerCase()).to.include('v1 stub')
    })

    it('exposes [v1 stub] in the static description of dream cancel', () => {
      expect(DreamCancel.description.toLowerCase()).to.include('v1 stub')
    })

    it('emits a `note` field disclosing stub status on dream sessions --format json', async () => {
      const command = new DreamSessions(['--format', 'json'], config)
      let writtenJson = ''
      stub(process.stdout, 'write').callsFake((chunk: string | Uint8Array): boolean => {
        writtenJson += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        return true
      })

      await command.run()

      const parsed = JSON.parse(writtenJson.trim())
      expect(parsed.data).to.have.property('note')
      expect(parsed.data.note.toLowerCase()).to.match(/v1|stateless|no-op/)
    })

    it('emits a `note` field disclosing no-op status on dream cancel --format json', async () => {
      const command = new DreamCancel(['--session', 'drm-test', '--format', 'json'], config)
      let writtenJson = ''
      stub(process.stdout, 'write').callsFake((chunk: string | Uint8Array): boolean => {
        writtenJson += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        return true
      })

      await command.run()

      const parsed = JSON.parse(writtenJson.trim())
      expect(parsed.data).to.have.property('note')
      expect(parsed.data.note.toLowerCase()).to.match(/v1|stateless|no-op/)
    })
  })
})
