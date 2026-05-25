import {expect} from 'chai'
import {existsSync, promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {
  AcpDriverPromptArgs,
  AcpDriverStatus,
  AcpInitializeSnapshot,
  IAcpDriver,
  TurnEventPayload,
} from '../../../../../src/server/core/interfaces/channel/i-acp-driver.js'

import {AcpAuthRequiredError} from '../../../../../src/server/core/domain/channel/errors.js'
import {FileDriverProfileStore} from '../../../../../src/server/infra/channel/driver-profile-store.js'
import {ChannelOnboardService} from '../../../../../src/server/infra/channel/onboard-service.js'
import {FileProfileMetadataStore} from '../../../../../src/server/infra/channel/profile-metadata-store.js'

// Slice 4.2 — onboard surfaces ONBOARD_AUTH_REQUIRED when the driver
// throws AcpAuthRequiredError from start() / probeSession(). First-time
// onboards leave no trace (no profile, no metadata). Re-probes against
// an existing profile write only the metadata record; the profile itself
// is preserved.

const AUTH_METHODS = [
  {
    fieldMeta: {
      terminalAuth: {args: ['login'] as const, command: 'kimi', env: {}},
    },
    id: 'login',
    name: 'Login with Kimi account',
  },
] as const

class StubAuthDriver implements IAcpDriver {
  public acpInitialize: AcpInitializeSnapshot | undefined
  public readonly capabilities: string[] = ['embeddedContext', 'image']
  public readonly handle: string
  public protocolVersion: number | undefined = 1
  public status: AcpDriverStatus = 'idle'
  private started = false
  private stopped = false
  private readonly throwFrom: 'probeSession' | 'start'

  public constructor(handle: string, throwFrom: 'probeSession' | 'start') {
    this.handle = handle
    this.throwFrom = throwFrom
  }


  get wasStarted(): boolean { return this.started }

  get wasStopped(): boolean { return this.stopped }


  async cancel(): Promise<void> {}


  async probeSession(): Promise<boolean> {
    if (this.throwFrom === 'probeSession') {
      throw new AcpAuthRequiredError(this.handle, [...AUTH_METHODS])
    }

    return true
  }

  prompt(_args: AcpDriverPromptArgs): AsyncIterableIterator<TurnEventPayload> {
    throw new Error('not used in onboard-auth tests')
  }

  async respondToPermission(): Promise<void> {}

  async start(): Promise<void> {
    if (this.throwFrom === 'start') {
      throw new AcpAuthRequiredError(this.handle, [...AUTH_METHODS])
    }

    this.started = true
  }

  async stop(): Promise<void> {
    this.stopped = true
  }
}

describe('ChannelOnboardService — AUTH_REQUIRED (Slice 4.2)', () => {
  let dataDir: string
  let store: FileDriverProfileStore
  let metadata: FileProfileMetadataStore

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'brv-onboard-auth-'))
    store = new FileDriverProfileStore({dataDir})
    metadata = new FileProfileMetadataStore({dataDir})
  })

  afterEach(async () => {
    await fs.rm(dataDir, {force: true, recursive: true})
  })

  const makeService = (driver: IAcpDriver): ChannelOnboardService =>
    new ChannelOnboardService({
      clock: () => new Date('2026-05-12T08:00:00.000Z'),
      driverFactory: () => driver,
      metadataStore: metadata,
      store,
    })

  it('first-time onboard: throws, emits ONBOARD_AUTH_REQUIRED, persists nothing', async () => {
    const driver = new StubAuthDriver('@kimi', 'start')
    const svc = makeService(driver)

    let caught: unknown
    try {
      await svc.onboard({
        displayName: 'Kimi',
        invocation: {args: ['acp'], command: 'kimi', cwd: '/tmp'},
        profileName: 'kimi',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(AcpAuthRequiredError)
    expect(await store.get('kimi')).to.equal(undefined)
    expect(existsSync(join(dataDir, 'state', 'agent-driver-profile-metadata.json'))).to.equal(false)
  })

  it('first-time onboard surfaces ONBOARD_AUTH_REQUIRED diagnostic in the thrown error.details', async () => {
    const driver = new StubAuthDriver('@kimi', 'start')
    const svc = makeService(driver)

    try {
      await svc.onboard({
        displayName: 'Kimi',
        invocation: {args: ['acp'], command: 'kimi', cwd: '/tmp'},
        profileName: 'kimi',
      })
      expect.fail('expected AcpAuthRequiredError')
    } catch (error) {
      expect(error).to.be.instanceOf(AcpAuthRequiredError)
      const authErr = error as AcpAuthRequiredError
      expect(authErr.authMethods[0].id).to.equal('login')
    }
  })

  it('session/new auth failure: same routing', async () => {
    const driver = new StubAuthDriver('@kimi', 'probeSession')
    const svc = makeService(driver)

    let caught: unknown
    try {
      await svc.onboard({
        displayName: 'Kimi',
        invocation: {args: ['acp'], command: 'kimi', cwd: '/tmp'},
        profileName: 'kimi',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(AcpAuthRequiredError)
    expect(await store.get('kimi')).to.equal(undefined)
  })

  it('re-probe against existing profile: writes metadata, preserves existing profile', async () => {
    // Pre-seed an existing successful onboard.
    await store.upsert({
      capabilities: ['embeddedContext', 'image'],
      detectedAcpVersion: '1',
      displayName: 'Kimi',
      driverClass: 'A',
      invocation: {args: ['acp'], command: 'kimi', cwd: '/tmp'},
      name: 'kimi',
      probedAt: '2026-05-01T00:00:00.000Z',
    })

    const driver = new StubAuthDriver('@kimi', 'start')
    const svc = makeService(driver)

    try {
      await svc.onboard({
        displayName: 'Kimi',
        invocation: {args: ['acp'], command: 'kimi', cwd: '/tmp'},
        profileName: 'kimi',
      })
      expect.fail('expected AcpAuthRequiredError')
    } catch (error) {
      expect(error).to.be.instanceOf(AcpAuthRequiredError)
    }

    // Profile preserved (not overwritten, not deleted).
    const profile = await store.get('kimi')
    expect(profile?.probedAt).to.equal('2026-05-01T00:00:00.000Z')
    expect(profile?.driverClass).to.equal('A')

    // Metadata recorded.
    const record = await metadata.get('kimi')
    expect(record?.lastProbeError).to.equal('AUTH_REQUIRED')
    expect(record?.lastProbeAt).to.equal('2026-05-12T08:00:00.000Z')
  })

  it('successful onboard after a prior AUTH_REQUIRED clears the metadata record', async () => {
    // Pre-seed the AUTH_REQUIRED metadata as if a previous probe failed.
    await metadata.setLastProbeError({
      at: '2026-04-01T00:00:00.000Z',
      error: 'AUTH_REQUIRED',
      name: 'kimi',
    })

    // Build a happy-path driver.
    class HappyDriver implements IAcpDriver {
      public acpInitialize: AcpInitializeSnapshot | undefined = {
        agentCapabilities: {promptCapabilities: {embeddedContext: true, image: true}},
      }
      public readonly capabilities: string[] = ['embeddedContext', 'image']
      public readonly handle = '@kimi'
      public protocolVersion: number | undefined = 1
      public status: AcpDriverStatus = 'idle'

      async cancel(): Promise<void> {}

      async probeSession(): Promise<boolean> { return true }

      prompt(_args: AcpDriverPromptArgs): AsyncIterableIterator<TurnEventPayload> {
        throw new Error('unused')
      }

      async respondToPermission(): Promise<void> {}

      async start(): Promise<void> { this.status = 'idle' }

      async stop(): Promise<void> { this.status = 'stopped' }
    }

    const svc = makeService(new HappyDriver())
    await svc.onboard({
      displayName: 'Kimi',
      invocation: {args: ['acp'], command: 'kimi', cwd: '/tmp'},
      profileName: 'kimi',
    })

    expect(await metadata.get('kimi')).to.equal(undefined)
  })
})
