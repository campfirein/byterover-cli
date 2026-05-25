// §9.5.8 Blocker 2 — brv bridge ping non-JSON output includes integrity warning.
//
// `formatPingResult` is extracted from BridgePing.run() so we can test the
// text-output formatting without spinning up libp2p. Tests verify that when
// the result has integrityDegraded=true or terminalMissing=true, the returned
// lines contain the operator-visible warning text.

import {expect} from 'chai'

import type {SendParleyQueryResult} from '../../../../../src/server/infra/channel/bridge/parley-client.js'

import {formatPingResult} from '../../../../../src/oclif/commands/bridge/ping.js'

describe('BridgePing formatPingResult — §9.5.8 Blocker 2: integrity-degraded warning', () => {
  it('includes integrity-degraded warning when integrityDegraded=true', () => {
    const result: SendParleyQueryResult = {
      content: 'hello',
      endedState: 'completed',
      frames: [],
      integrityDegraded: true,
      ok: true,
      sealOrigin: 'implicit-from-signed-terminal',
    }

    const lines = formatPingResult(result)
    const combined = lines.join('\n')

    // Must include a warning with the sealOrigin value
    expect(combined).to.include('integrity-degraded')
    expect(combined.toLowerCase()).to.include('implicit-from-signed-terminal')
    // Must include the content
    expect(combined).to.include('hello')
  })

  it('includes terminalMissing warning when terminalMissing=true', () => {
    const result: SendParleyQueryResult = {
      content: 'partial',
      endedState: 'completed',
      frames: [],
      integrityDegraded: true,
      ok: true,
      sealOrigin: 'implicit-from-stream-eof',
      terminalMissing: true,
    }

    const lines = formatPingResult(result)
    const combined = lines.join('\n')

    expect(combined).to.include('integrity-degraded')
    expect(combined.toLowerCase()).to.include('implicit-from-stream-eof')
    expect(combined).to.include('terminalMissing')
  })

  it('does NOT include integrity warning on explicit seal path', () => {
    const result: SendParleyQueryResult = {
      content: 'full answer',
      endedState: 'completed',
      frames: [],
      integrityDegraded: false,
      ok: true,
      sealOrigin: 'explicit',
    }

    const lines = formatPingResult(result)
    const combined = lines.join('\n')

    expect(combined).to.not.include('integrity-degraded')
    expect(combined).to.include('full answer')
  })

  it('returns endedState line before content', () => {
    const result: SendParleyQueryResult = {
      content: 'the answer',
      endedState: 'completed',
      frames: [],
      integrityDegraded: false,
      ok: true,
      sealOrigin: 'explicit',
    }

    const lines = formatPingResult(result)
    const endedStateLineIdx = lines.findIndex((l: string) => l.startsWith('endedState:'))
    const contentLineIdx = lines.indexOf('the answer')
    expect(endedStateLineIdx).to.be.greaterThanOrEqual(0)
    expect(contentLineIdx).to.be.greaterThan(endedStateLineIdx)
  })
})
