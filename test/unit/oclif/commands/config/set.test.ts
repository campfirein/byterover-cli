/**
 * Tests for the pure-function dispatcher inside `brv config set`. The oclif
 * wrapper handles arg parsing + filesystem I/O; this suite asserts the
 * validation + transformation contract that backs every call.
 *
 * The dispatcher currently has no live setters — the language keys that used
 * to live here were intercepted upstream after ENG-2974 moved language to
 * global daemon settings. These tests guard the dispatcher's "unknown key"
 * skeleton so a future project-config key wires in cleanly.
 */

import {expect} from 'chai'

import {applyConfigSet} from '../../../../../src/oclif/commands/config/set.js'
import {BrvConfig} from '../../../../../src/server/core/domain/entities/brv-config.js'

const validParams = {
  createdAt: '2026-05-26T00:00:00.000Z',
  cwd: '/tmp/project',
  version: '0.0.1',
}

describe('config set — applyConfigSet', () => {
  it("returns 'unknown-key' for any input — no project-config keys are settable today", () => {
    const config = new BrvConfig(validParams)
    const result = applyConfigSet(config, 'anything.at.all', 'whatever')
    expect(result.kind).to.equal('error')
    if (result.kind === 'error') {
      expect(result.code).to.equal('unknown-key')
      expect(result.message).to.include('brv settings set')
    }
  })

  it('mentions the legacy language.* keys are gone via brv settings now', () => {
    const config = new BrvConfig(validParams)
    const result = applyConfigSet(config, 'language.mode', 'auto')
    expect(result.kind).to.equal('error')
    // The oclif command intercepts language.* upstream with a more specific
    // deprecation message. This dispatcher is what catches everything else.
    if (result.kind === 'error') {
      expect(result.code).to.equal('unknown-key')
    }
  })
})
