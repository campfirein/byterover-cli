import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {ConnectionFailedError, InstanceCrashedError, NoInstanceRunningError} from '@campfirein/brv-transport-client'
import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import type {ProjectLocationDTO} from '../../src/shared/transport/types/dto.js'

import Locations from '../../src/oclif/commands/locations.js'
import {buildCliMetadata} from '../../src/oclif/lib/build-cli-metadata.js'

// ==================== TestableLocationsCommand ====================

class TestableLocationsCommand extends Locations {
  private readonly mockConnector: () => Promise<ConnectionResult>

  constructor(mockConnector: () => Promise<ConnectionResult>, config: Config, argv: string[] = []) {
    super(argv, config)
    this.mockConnector = mockConnector
  }

  protected override async fetchLocations(
    cliMetadata: ReturnType<typeof buildCliMetadata>,
  ): Promise<ProjectLocationDTO[]> {
    return super.fetchLocations(cliMetadata, {
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    })
  }
}

// ==================== Tests ====================

describe('Locations Command', () => {
  let config: Config
  let loggedMessages: string[]
  let mockClient: sinon.SinonStubbedInstance<ITransportClient>
  let mockConnector: sinon.SinonStub<[], Promise<ConnectionResult>>

  before(async () => {
    config = await OclifConfig.load(import.meta.url)
  })

  beforeEach(() => {
    loggedMessages = []

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
      requestWithAck: stub().resolves({}),
    } as unknown as sinon.SinonStubbedInstance<ITransportClient>

    mockConnector = stub<[], Promise<ConnectionResult>>().resolves({
      client: mockClient as unknown as ITransportClient,
      projectRoot: '/test/project',
    })
  })

  afterEach(() => {
    restore()
  })

  function createCommand(): TestableLocationsCommand {
    const command = new TestableLocationsCommand(mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })
    return command
  }

  function mockLocationsResponse(locations: ProjectLocationDTO[]): void {
    ;(mockClient.requestWithAck as sinon.SinonStub).resolves({locations})
  }

  // ==================== Text Output ====================

  describe('text output', () => {
    it('should display header with count when locations exist', async () => {
      mockLocationsResponse([
        {
          contextTreePath: '/p/a/.brv/context-tree',
          isActive: false,
          isCurrent: true,
          isInitialized: false,
          projectPath: '/p/a',
        },
      ])

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Registered Projects — 1 found'))).to.be.true
    })

    it('should display "none found" when no locations', async () => {
      mockLocationsResponse([])

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Registered Projects — none found'))).to.be.true
    })

    it('should display [current] label for current project', async () => {
      mockLocationsResponse([
        {
          contextTreePath: '/p/cur/.brv/context-tree',
          isActive: false,
          isCurrent: true,
          isInitialized: true,
          projectPath: '/p/cur',
        },
      ])

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('[current]') && m.includes('/p/cur'))).to.be.true
    })

    it('should display [active] label for active project', async () => {
      mockLocationsResponse([
        {
          contextTreePath: '/p/act/.brv/context-tree',
          isActive: true,
          isCurrent: false,
          isInitialized: false,
          projectPath: '/p/act',
        },
      ])

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('[active]') && m.includes('/p/act'))).to.be.true
    })

    it('should display context-tree path when initialized', async () => {
      mockLocationsResponse([
        {
          contextTreePath: '/p/init/.brv/context-tree',
          isActive: false,
          isCurrent: false,
          isInitialized: true,
          projectPath: '/p/init',
        },
      ])

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('.brv/context-tree/'))).to.be.true
    })

    it('should display "(not initialized)" when not initialized', async () => {
      mockLocationsResponse([
        {
          contextTreePath: '/p/x/.brv/context-tree',
          isActive: false,
          isCurrent: false,
          isInitialized: false,
          projectPath: '/p/x',
        },
      ])

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('(not initialized)'))).to.be.true
    })
  })

  // ==================== JSON Output ====================

  describe('JSON output', () => {
    it('should output locations array with success: true', async () => {
      mockLocationsResponse([
        {
          contextTreePath: '/p/a/.brv/context-tree',
          isActive: false,
          isCurrent: true,
          isInitialized: true,
          projectPath: '/p/a',
        },
      ])

      let captured = ''
      const writeStub = stub(process.stdout, 'write').callsFake((chunk) => {
        captured += chunk
        return true
      })

      try {
        await new TestableLocationsCommand(mockConnector, config, ['--format', 'json']).run()
      } finally {
        writeStub.restore()
      }

      const parsed = JSON.parse(captured) as {data: {locations: unknown[]}; success: boolean}
      expect(parsed.success).to.be.true
      expect(parsed.data.locations).to.be.an('array').with.lengthOf(1)
    })

    it('should output success: false on connection error', async () => {
      mockConnector.rejects(new NoInstanceRunningError())

      let captured = ''
      const writeStub = stub(process.stdout, 'write').callsFake((chunk) => {
        captured += chunk
        return true
      })

      try {
        await new TestableLocationsCommand(mockConnector, config, ['--format', 'json']).run()
      } finally {
        writeStub.restore()
      }

      const parsed = JSON.parse(captured) as {success: boolean}
      expect(parsed.success).to.be.false
    })
  })

  // ==================== Connection Errors ====================

  describe('connection errors', () => {
    it('should handle NoInstanceRunningError', async () => {
      mockConnector.rejects(new NoInstanceRunningError())

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Daemon failed to start automatically'))).to.be.true
    })

    it('should handle InstanceCrashedError', async () => {
      mockConnector.rejects(new InstanceCrashedError())

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Daemon crashed unexpectedly'))).to.be.true
    })

    it('should handle ConnectionFailedError', async () => {
      mockConnector.rejects(new ConnectionFailedError(37_847, new Error('Connection refused')))

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Failed to connect'))).to.be.true
    })

    it('should handle unexpected errors', async () => {
      mockConnector.rejects(new Error('Something went wrong'))

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Something went wrong'))).to.be.true
    })
  })
})
