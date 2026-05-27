import type {Config} from '@oclif/core'

import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import {restore, stub} from 'sinon'

import type {MigrateRunReport} from '../../src/shared/transport/events/migrate-events.js'

import Migrate from '../../src/oclif/commands/migrate.js'

// Tests the gate logic in displayForwardResult that controls when the
// VC-sync hint fires. Daemon transport is bypassed by calling the
// `protected` display method directly with a synthetic report — the
// gate decisions are pure functions of (format, dryRun, summary) and
// don't need a live daemon round-trip.

class TestableMigrate extends Migrate {
  public exerciseDisplay(report: MigrateRunReport, format: string, dryRun: boolean): void {
    return this.displayForwardResult(report, format, dryRun)
  }
}

function makeReport(overrides: {failed?: number; migrated?: number;} = {}): MigrateRunReport {
  return {
    archiveRoot: '/tmp/archive',
    completedAt: '2026-05-26T00:00:00.000Z',
    dryRun: false,
    files: [],
    projectRoot: '/tmp/proj',
    startedAt: '2026-05-26T00:00:00.000Z',
    summary: {
      archived: 0,
      failed: overrides.failed ?? 0,
      migrated: overrides.migrated ?? 0,
      skipped: 0,
    },
  }
}

describe('brv migrate — VC-sync hint gate', () => {
  let config: Config
  let stdout: string[]
  let stderr: string[]
  let warnings: string[]

  before(async () => {
    config = await OclifConfig.load(import.meta.url)
  })

  beforeEach(() => {
    stdout = []
    stderr = []
    warnings = []
  })

  afterEach(() => {
    restore()
  })

  function buildCommand(): TestableMigrate {
    const cmd = new TestableMigrate([], config)
    stub(cmd, 'log').callsFake((msg?: string) => {
      if (msg !== undefined) stdout.push(msg)
    })
    stub(cmd, 'logToStderr').callsFake((msg?: string) => {
      if (msg !== undefined) stderr.push(msg)
    })
    stub(cmd, 'warn').callsFake((msg: Error | string) => {
      warnings.push(typeof msg === 'string' ? msg : msg.message)
      return msg
    })
    return cmd
  }

  it('text + real + migrated>0 + failed=0: prints the hint on stderr', () => {
    const cmd = buildCommand()
    cmd.exerciseDisplay(makeReport({failed: 0, migrated: 5}), 'text', false)

    const stderrJoined = stderr.join('\n')
    expect(stderrJoined).to.include('Tip: the context tree was successfully migrated')
    expect(stderrJoined).to.include('brv vc status')
    expect(stderrJoined).to.include('brv vc add')
    expect(stderrJoined).to.include('brv vc push')
    expect(stderrJoined).to.include('brv vc remote add origin')
  })

  it('text + dry-run + migrated>0: does NOT print the hint', () => {
    const cmd = buildCommand()
    cmd.exerciseDisplay(makeReport({failed: 0, migrated: 5}), 'text', true)

    expect(stderr.join('\n')).to.not.include('Tip:')
  })

  it('text + real + migrated=0: does NOT print the hint', () => {
    const cmd = buildCommand()
    cmd.exerciseDisplay(makeReport({failed: 0, migrated: 0}), 'text', false)

    expect(stderr.join('\n')).to.not.include('Tip:')
  })

  it('text + real + migrated>0 + failed>0: does NOT print the hint (exit-code contradiction guard)', () => {
    const cmd = buildCommand()
    cmd.exerciseDisplay(makeReport({failed: 2, migrated: 5}), 'text', false)

    // Warnings about failures still fire — only the success hint is suppressed.
    expect(warnings.join('\n')).to.include('2 file(s) failed')
    expect(stderr.join('\n')).to.not.include('Tip:')
  })

  it('json + real + migrated>0: emits the JSON envelope on stdout, nothing on stderr', () => {
    const cmd = buildCommand()
    cmd.exerciseDisplay(makeReport({failed: 0, migrated: 5}), 'json', false)

    expect(stdout).to.have.lengthOf(1)
    expect(() => JSON.parse(stdout[0])).to.not.throw()
    expect(stderr).to.have.lengthOf(0)
  })
})
