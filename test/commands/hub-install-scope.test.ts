import type {Config} from '@oclif/core'

import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import {restore, stub} from 'sinon'

import HubInstall from '../../src/oclif/commands/hub/install.js'
import {type HubInstallResponse} from '../../src/shared/transport/events/hub-events.js'

type InstallParams = {agent?: string; entryId: string; registry?: string; scope?: 'global' | 'project'}

class TestableHubInstall extends HubInstall {
  public captured?: InstallParams

  protected override async executeInstall(params: InstallParams): Promise<HubInstallResponse> {
    this.captured = params
    return {installedFiles: [], installedPath: '', message: 'ok', success: true}
  }
}

async function runInstall(config: Config, argv: string[]): Promise<InstallParams | undefined> {
  const cmd = new TestableHubInstall(argv, config)
  stub(cmd, 'log')
  await cmd.run()
  return cmd.captured
}

describe('HubInstall scope forwarding', () => {
  let config: Config

  before(async () => {
    config = await OclifConfig.load(import.meta.url)
  })

  afterEach(() => {
    restore()
  })

  it('omits scope when --scope is not provided (server infers per-agent default)', async () => {
    const captured = await runInstall(config, ['some-entry', '--agent', 'Hermes'])

    expect(captured?.scope).to.equal(undefined)
  })

  it('forwards an explicit --scope value', async () => {
    const captured = await runInstall(config, ['some-entry', '--agent', 'Hermes', '--scope', 'global'])

    expect(captured?.scope).to.equal('global')
  })
})
