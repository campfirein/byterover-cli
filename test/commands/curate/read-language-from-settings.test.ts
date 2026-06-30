import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'

import {DaemonSpawnError} from '@campfirein/brv-transport-client'
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import {readLanguageFromSettings} from '../../../src/oclif/commands/curate/index.js'

describe('readLanguageFromSettings', () => {
  let mockClient: sinon.SinonStubbedInstance<ITransportClient>
  let mockConnector: sinon.SinonStub<[], Promise<ConnectionResult>>

  beforeEach(() => {
    mockClient = {
      connect: stub().resolves(),
      disconnect: stub().resolves(),
      getClientId: stub().returns('test-client-id'),
      getDaemonVersion: stub(),
      getState: stub().returns('connected'),
      isConnected: stub().resolves(true),
      joinRoom: stub().resolves(),
      leaveRoom: stub().resolves(),
      on: stub().returns(() => {}),
      once: stub(),
      onStateChange: stub().returns(() => {}),
      request: stub() as unknown as ITransportClient['request'],
      requestWithAck: stub() as unknown as ITransportClient['requestWithAck'],
    } as unknown as sinon.SinonStubbedInstance<ITransportClient>

    mockConnector = stub<[], Promise<ConnectionResult>>().resolves({
      client: mockClient as unknown as ITransportClient,
      projectRoot: '/test/project',
    })
  })

  afterEach(() => {
    restore()
  })

  it('returns {mode: "fixed", code} when daemon settings have mode=fixed and a string code', async () => {
    ;(mockClient.requestWithAck as sinon.SinonStub).resolves({
      items: [
        {
          category: 'language',
          current: 'fixed',
          default: 'auto',
          description: '',
          key: 'language.mode',
          options: ['auto', 'fixed'],
          restartRequired: false,
          type: 'enum',
        },
        {
          category: 'language',
          current: 'ja',
          default: 'en',
          description: '',
          key: 'language.code',
          options: ['en', 'ja'],
          restartRequired: false,
          type: 'enum',
        },
      ],
    })

    const result = await readLanguageFromSettings({
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: mockConnector,
    })

    expect(result).to.eql({code: 'ja', mode: 'fixed'})
  })

  it('returns undefined when daemon settings have mode=auto (regardless of code)', async () => {
    ;(mockClient.requestWithAck as sinon.SinonStub).resolves({
      items: [
        {
          category: 'language',
          current: 'auto',
          default: 'auto',
          description: '',
          key: 'language.mode',
          options: ['auto', 'fixed'],
          restartRequired: false,
          type: 'enum',
        },
        {
          category: 'language',
          current: 'ja',
          default: 'en',
          description: '',
          key: 'language.code',
          options: ['en', 'ja'],
          restartRequired: false,
          type: 'enum',
        },
      ],
    })

    const result = await readLanguageFromSettings({
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: mockConnector,
    })

    expect(result).to.equal(undefined)
  })

  it('returns undefined when the daemon connection throws', async () => {
    mockConnector.rejects(new Error('connection failed'))

    const result = await readLanguageFromSettings({
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: mockConnector,
    })

    expect(result).to.equal(undefined)
  })

  it('uses a tight retry budget by default — no long kickoff delay when daemon is unreachable', async () => {
    // withDaemonRetry's default is MAX_RETRIES=10 × DEFAULT_RETRY_DELAY_MS=1000ms, which would
    // make every `brv curate` kickoff sit through ~9s of retries before the catch returns
    // undefined and the project-config fallback runs. readLanguageFromSettings should override
    // the defaults to {maxRetries: 1, retryDelayMs: 0} so a missing daemon trips the fallback
    // immediately.
    mockConnector.rejects(new DaemonSpawnError('daemon not running'))

    const result = await readLanguageFromSettings({
      transportConnector: mockConnector,
      // intentionally no maxRetries / retryDelayMs — verify the tight default
    })

    expect(result).to.equal(undefined)
    // `withDaemonRetry` treats `maxRetries` as total attempts (`for attempt <= maxRetries`), so
    // {maxRetries: 1} means a single attempt. With the prior MAX_RETRIES=10 default the connector
    // would have been called 10 times; the cap below catches any regression to the loose default.
    expect(mockConnector.callCount).to.be.at.most(2)
  })
})
