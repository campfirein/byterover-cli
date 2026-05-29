import type {SinonStubbedInstance} from 'sinon'

import {expect} from 'chai'
import {restore, stub} from 'sinon'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {IAuthService} from '../../../../../src/server/core/interfaces/auth/i-auth-service.js'
import type {ICallbackHandler} from '../../../../../src/server/core/interfaces/auth/i-callback-handler.js'
import type {ITokenStore} from '../../../../../src/server/core/interfaces/auth/i-token-store.js'
import type {IProviderConfigStore} from '../../../../../src/server/core/interfaces/i-provider-config-store.js'
import type {IBrowserLauncher} from '../../../../../src/server/core/interfaces/services/i-browser-launcher.js'
import type {IUserService} from '../../../../../src/server/core/interfaces/services/i-user-service.js'
import type {IAuthStateStore} from '../../../../../src/server/core/interfaces/state/i-auth-state-store.js'
import type {IGlobalConfigRotator} from '../../../../../src/server/core/interfaces/state/i-global-config-rotator.js'
import type {IProjectConfigStore} from '../../../../../src/server/core/interfaces/storage/i-project-config-store.js'
import type {ITransportServer} from '../../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {AuthToken} from '../../../../../src/server/core/domain/entities/auth-token.js'
import {BrvConfig} from '../../../../../src/server/core/domain/entities/brv-config.js'
import {User} from '../../../../../src/server/core/domain/entities/user.js'
import {TransportDaemonEventNames} from '../../../../../src/server/core/domain/transport/schemas.js'
import {AuthHandler, type AuthHandlerDeps} from '../../../../../src/server/infra/transport/handlers/auth-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {AuthEvents} from '../../../../../src/shared/transport/events/auth-events.js'

// ==================== Test Helpers ====================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (data: any, clientId: string) => any
type AuthChangedCallback = (token: AuthToken | undefined) => void
type AuthExpiredCallback = (token: AuthToken) => void

function createMockTransport(): SinonStubbedInstance<ITransportServer> & {_handlers: Map<string, AnyHandler>} {
  const handlers = new Map<string, AnyHandler>()
  return {
    _handlers: handlers,
    addToRoom: stub(),
    broadcast: stub(),
    broadcastTo: stub(),
    getPort: stub(),
    isRunning: stub(),
    onConnection: stub(),
    onDisconnection: stub(),
    onRequest: stub().callsFake((event: string, handler: AnyHandler) => {
      handlers.set(event, handler)
    }),
    removeFromRoom: stub(),
    sendTo: stub(),
    start: stub(),
    stop: stub(),
  } as unknown as SinonStubbedInstance<ITransportServer> & {_handlers: Map<string, AnyHandler>}
}

function createValidToken(): AuthToken {
  return new AuthToken({
    accessToken: 'test-access-token',
    expiresAt: new Date(Date.now() + 3_600_000), // 1 hour from now
    refreshToken: 'test-refresh-token',
    sessionKey: 'test-session-key',
    tokenType: 'Bearer',
    userEmail: 'test@example.com',
    userId: 'user-123',
  })
}

function createTestUser(): User {
  return new User({
    email: 'test@example.com',
    hasOnboardedCli: true,
    id: 'user-123',
    name: 'Test User',
  })
}

function createTestBrvConfig(): BrvConfig {
  return new BrvConfig({
    createdAt: '2026-01-01T00:00:00.000Z',
    spaceId: 'space-1',
    spaceName: 'Test Space',
    teamId: 'team-1',
    teamName: 'Test Team',
    version: '2',
  })
}

// ==================== Tests ====================

function makeFakeAnalyticsClient(): IAnalyticsClient & {trackSpy: ReturnType<typeof stub>} {
  const trackSpy = stub()
  return {
    abort: stub(),
    flush: stub().resolves({events: []}),
    getRuntimeState: stub().resolves({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition: stub().resolves(),
    track: trackSpy,
    trackSpy,
  } as unknown as IAnalyticsClient & {trackSpy: ReturnType<typeof stub>}
}

/**
 * `failure_kind` discipline: the emitted tag MUST be a coarse enum-like
 * value — non-empty, ≤64 chars, snake_case (lowercase letters +
 * underscores). Forbids whitespace, newlines, capital letters, symbols —
 * catches a developer accidentally passing `getErrorMessage(error)` or
 * `error.message` as the tag.
 */
function assertFailureKindDiscipline(value: unknown, label: string): void {
  expect(value, `${label}: failure_kind must be a string`).to.be.a('string')
  const tag = value as string
  expect(tag.length, `${label}: failure_kind must be non-empty`).to.be.greaterThan(0)
  expect(tag.length, `${label}: failure_kind must be ≤64 chars (got ${tag.length})`).to.be.lessThanOrEqual(64)
  expect(tag, `${label}: failure_kind must be snake_case (a-z + _), got "${tag}"`).to.match(/^[a-z][a-z_]*$/)
}

function makeRotatorStub(rotated = true): IGlobalConfigRotator & {rotateSpy: ReturnType<typeof stub>} {
  const rotateSpy = stub().resolves(rotated)
  return {
    rotateDeviceId: rotateSpy,
    rotateSpy,
  } as unknown as IGlobalConfigRotator & {rotateSpy: ReturnType<typeof stub>}
}

function makeTokenForUser(userId: string): AuthToken {
  return new AuthToken({
    accessToken: 'access',
    expiresAt: new Date(Date.now() + 3_600_000),
    refreshToken: 'refresh',
    sessionKey: 'session',
    tokenType: 'Bearer',
    userEmail: `${userId}@example.com`,
    userId,
  })
}

function tokenStoreWithPrevious(previous?: AuthToken): ITokenStore {
  return {
    clear: stub().resolves(),
    load: stub().resolves(previous),
    save: stub().resolves(),
  } as unknown as ITokenStore
}

function makeValidTokenStoreFixture(): ITokenStore {
  return {
    clear: stub().resolves(),
    load: stub().resolves(createValidToken()),
    save: stub().resolves(),
  } as unknown as ITokenStore
}

function makeMissingTokenStoreFixture(): ITokenStore {
  return {
    clear: stub().resolves(),
    load: stub().resolves(),
    save: stub().resolves(),
  } as unknown as ITokenStore
}

function makeExpiredTokenStoreFixture(): ITokenStore {
  const expired = new AuthToken({
    accessToken: 'expired-access',
    expiresAt: new Date(Date.now() - 60_000),
    refreshToken: 'expired-refresh',
    sessionKey: 'expired-session',
    tokenType: 'Bearer',
    userEmail: 'test@example.com',
    userId: 'user-123',
  })
  return {
    clear: stub().resolves(),
    load: stub().resolves(expired),
    save: stub().resolves(),
  } as unknown as ITokenStore
}

function createMockProviderConfigStore(
  options: {isConnected?: boolean} = {},
): SinonStubbedInstance<IProviderConfigStore> {
  return {
    connectProvider: stub().resolves(),
    disconnectProvider: stub().resolves(),
    getActiveModel: stub().resolves(),
    getActiveProvider: stub().resolves(''),
    getFavoriteModels: stub().resolves([]),
    getRecentModels: stub().resolves([]),
    isProviderConnected: stub().resolves(options.isConnected ?? false),
    read: stub().resolves(),
    setActiveModel: stub().resolves(),
    setActiveProvider: stub().resolves(),
    toggleFavorite: stub().resolves(),
    write: stub().resolves(),
  } as unknown as SinonStubbedInstance<IProviderConfigStore>
}

describe('AuthHandler — setupExternalAuthSync', () => {
  let transport: ReturnType<typeof createMockTransport>
  let authStateStore: SinonStubbedInstance<IAuthStateStore>
  let userService: SinonStubbedInstance<IUserService>
  let projectConfigStore: SinonStubbedInstance<IProjectConfigStore>
  let providerConfigStore: SinonStubbedInstance<IProviderConfigStore>
  let capturedAuthChanged: AuthChangedCallback | undefined
  let capturedAuthExpired: AuthExpiredCallback | undefined

  beforeEach(() => {
    transport = createMockTransport()

    authStateStore = {
      getToken: stub(),
      loadToken: stub().resolves(),
      onAuthChanged: stub().callsFake((cb: AuthChangedCallback) => {
        capturedAuthChanged = cb
      }),
      onAuthExpired: stub().callsFake((cb: AuthExpiredCallback) => {
        capturedAuthExpired = cb
      }),
      startPolling: stub(),
      stopPolling: stub(),
    } as unknown as SinonStubbedInstance<IAuthStateStore>

    userService = {
      getCurrentUser: stub().resolves(createTestUser()),
      updateUser: stub().resolves(),
    } as unknown as SinonStubbedInstance<IUserService>

    projectConfigStore = {
      exists: stub().resolves(true),
      getModifiedTime: stub().resolves(Date.now()),
      read: stub().resolves(createTestBrvConfig()),
      write: stub().resolves(),
    } as unknown as SinonStubbedInstance<IProjectConfigStore>

    providerConfigStore = createMockProviderConfigStore()

    capturedAuthChanged = capturedAuthExpired = undefined // eslint-disable-line no-multi-assign
  })

  afterEach(() => {
    restore()
  })

  function createHandler(overrides: Partial<AuthHandlerDeps> = {}): void {
    const deps: AuthHandlerDeps = {
      authService: {
        exchangeCodeForToken: stub(),
        initiateAuthorization: stub(),
        refreshToken: stub(),
      } as unknown as IAuthService,
      authStateStore,
      browserLauncher: {open: stub()} as unknown as IBrowserLauncher,
      callbackHandler: {
        getPort: stub().returns(3000),
        start: stub().resolves(),
        stop: stub().resolves(),
        waitForCallback: stub().resolves({code: 'test'}),
      } as unknown as ICallbackHandler,
      projectConfigStore,
      providerConfigStore,
      resolveProjectPath: stub().returns('/test/project'),
      tokenStore: {
        clear: stub().resolves(),
        load: stub().resolves(),
        save: stub().resolves(),
      } as unknown as ITokenStore,
      transport,
      userService,
      ...overrides,
    }
    new AuthHandler(deps).setup()
  }

  describe('callback registration', () => {
    it('should register onAuthChanged callback during setup', () => {
      createHandler()
      expect(authStateStore.onAuthChanged.calledOnce).to.be.true
      expect(capturedAuthChanged).to.be.a('function')
    })

    it('should register onAuthExpired callback during setup', () => {
      createHandler()
      expect(authStateStore.onAuthExpired.calledOnce).to.be.true
      expect(capturedAuthExpired).to.be.a('function')
    })
  })

  describe('onAuthChanged — valid token', () => {
    it('should broadcast auth:updated for agents', () => {
      createHandler()
      const token = createValidToken()

      capturedAuthChanged!(token)

      expect(transport.broadcast.calledWith(AuthEvents.UPDATED)).to.be.true
      const [, payload] = transport.broadcast.getCalls().find((c) => c.args[0] === AuthEvents.UPDATED)!.args
      expect(payload).to.deep.equal({
        hasToken: true,
        isValid: true,
        sessionKey: 'test-session-key',
      })
    })

    it('should broadcast auth:stateChanged with user info (no brvConfig) for TUI', async () => {
      createHandler()
      const token = createValidToken()

      capturedAuthChanged!(token)

      // Wait for async broadcastAuthStateChanged to complete
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      const stateChangedCall = transport.broadcast.getCalls().find((c) => c.args[0] === AuthEvents.STATE_CHANGED)
      expect(stateChangedCall, 'auth:stateChanged should be broadcast').to.exist
      expect(stateChangedCall!.args[1]).to.deep.equal({
        isAuthorized: true,
        user: {email: 'test@example.com', hasOnboardedCli: true, id: 'user-123', name: 'Test User'},
      })
    })

    it('should not include brvConfig in auth:stateChanged broadcast', async () => {
      createHandler()
      const token = createValidToken()

      capturedAuthChanged!(token)

      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      const stateChangedCall = transport.broadcast.getCalls().find((c) => c.args[0] === AuthEvents.STATE_CHANGED)
      expect(stateChangedCall).to.exist
      expect(stateChangedCall!.args[1]).to.not.have.property('brvConfig')
    })
  })

  describe('onAuthChanged — undefined token (logout)', () => {
    it('should broadcast auth:updated with hasToken=false', () => {
      createHandler()

      // eslint-disable-next-line unicorn/no-useless-undefined -- undefined simulates logout
      capturedAuthChanged!(undefined)

      const updatedCall = transport.broadcast.getCalls().find((c) => c.args[0] === AuthEvents.UPDATED)
      expect(updatedCall).to.exist
      expect(updatedCall!.args[1]).to.deep.equal({
        hasToken: false,
        isValid: false,
        sessionKey: undefined,
      })
    })

    it('should broadcast auth:stateChanged with isAuthorized=false', async () => {
      createHandler()

      // eslint-disable-next-line unicorn/no-useless-undefined -- undefined simulates logout
      capturedAuthChanged!(undefined)

      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      const stateChangedCall = transport.broadcast.getCalls().find((c) => c.args[0] === AuthEvents.STATE_CHANGED)
      expect(stateChangedCall).to.exist
      expect(stateChangedCall!.args[1]).to.deep.equal({isAuthorized: false})
    })
  })

  describe('logout disconnects byterover', () => {
    it('disconnects byterover and broadcasts provider:updated when logout fires and byterover was connected', async () => {
      providerConfigStore = createMockProviderConfigStore({isConnected: true})
      createHandler({providerConfigStore})

      const handler = transport._handlers.get(AuthEvents.LOGOUT)!
      const result = await handler(undefined, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(providerConfigStore.disconnectProvider.calledOnceWith('byterover')).to.be.true
      expect(transport.broadcast.getCalls().some((c) => c.args[0] === TransportDaemonEventNames.PROVIDER_UPDATED)).to.be
        .true
    })

    it('does not call disconnectProvider when byterover was not connected', async () => {
      providerConfigStore = createMockProviderConfigStore({isConnected: false})
      createHandler({providerConfigStore})

      const handler = transport._handlers.get(AuthEvents.LOGOUT)!
      const result = await handler(undefined, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(providerConfigStore.disconnectProvider.called).to.be.false
      expect(transport.broadcast.getCalls().some((c) => c.args[0] === TransportDaemonEventNames.PROVIDER_UPDATED)).to.be
        .false
    })

    it('still succeeds and clears the token when disconnectProvider throws', async () => {
      providerConfigStore = createMockProviderConfigStore({isConnected: true})
      providerConfigStore.disconnectProvider.rejects(new Error('disk full'))
      createHandler({providerConfigStore})

      const handler = transport._handlers.get(AuthEvents.LOGOUT)!
      const result = await handler(undefined, 'client-1')

      expect(result).to.deep.equal({success: true})
    })

    it('disconnects byterover when the token expires (onAuthExpired)', async () => {
      providerConfigStore = createMockProviderConfigStore({isConnected: true})
      createHandler({providerConfigStore})

      capturedAuthExpired!(createValidToken())

      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      expect(providerConfigStore.disconnectProvider.calledOnceWith('byterover')).to.be.true
      expect(transport.broadcast.getCalls().some((c) => c.args[0] === TransportDaemonEventNames.PROVIDER_UPDATED)).to.be
        .true
    })
  })

  describe('onAuthChanged — userService failure', () => {
    it('should broadcast auth:stateChanged with isAuthorized=true but no user on network error', async () => {
      userService.getCurrentUser.rejects(new Error('Network error'))
      createHandler()
      const token = createValidToken()

      capturedAuthChanged!(token)

      // auth:updated should be broadcast immediately (sync)
      const updatedCall = transport.broadcast.getCalls().find((c) => c.args[0] === AuthEvents.UPDATED)
      expect(updatedCall).to.exist

      // Wait for async broadcastAuthStateChanged to complete (fallback path)
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      // auth:stateChanged should still broadcast with isAuthorized=true (fallback without user)
      const stateChangedCall = transport.broadcast.getCalls().find((c) => c.args[0] === AuthEvents.STATE_CHANGED)
      expect(stateChangedCall, 'auth:stateChanged should be broadcast even on error').to.exist
      expect(stateChangedCall!.args[1]).to.deep.equal({isAuthorized: true})
    })
  })

  describe('setupStartLogin — browser launch behavior', () => {
    let browserOpenStub: ReturnType<typeof stub>

    function createHandlerWithBrowserStub(): void {
      browserOpenStub = stub().resolves()
      const deps: AuthHandlerDeps = {
        authService: {
          exchangeCodeForToken: stub(),
          initiateAuthorization: stub().returns({authUrl: 'https://byterover.dev/oauth/authorize?x=1', state: 'st'}),
          refreshToken: stub(),
        } as unknown as IAuthService,
        authStateStore,
        browserLauncher: {open: browserOpenStub} as unknown as IBrowserLauncher,
        callbackHandler: {
          getPort: stub().returns(3000),
          start: stub().resolves(),
          stop: stub().resolves(),
          waitForCallback: stub().resolves({code: 'test'}),
        } as unknown as ICallbackHandler,
        projectConfigStore,
        providerConfigStore,
        resolveProjectPath: stub().returns('/test/project'),
        tokenStore: {
          clear: stub().resolves(),
          load: stub().resolves(),
          save: stub().resolves(),
        } as unknown as ITokenStore,
        transport,
        userService,
      }
      new AuthHandler(deps).setup()
    }

    it('opens the system browser by default (request omitted)', async () => {
      createHandlerWithBrowserStub()
      const handler = transport._handlers.get(AuthEvents.START_LOGIN)!
      await handler(undefined, 'client-1')
      expect(browserOpenStub.calledOnce).to.be.true
    })

    it('opens the system browser when skipBrowserLaunch is false', async () => {
      createHandlerWithBrowserStub()
      const handler = transport._handlers.get(AuthEvents.START_LOGIN)!
      await handler({skipBrowserLaunch: false}, 'client-1')
      expect(browserOpenStub.calledOnce).to.be.true
    })

    it('does NOT open the system browser when skipBrowserLaunch is true', async () => {
      createHandlerWithBrowserStub()
      const handler = transport._handlers.get(AuthEvents.START_LOGIN)!
      const response = await handler({skipBrowserLaunch: true}, 'client-1')
      expect(browserOpenStub.called).to.be.false
      expect(response).to.have.property('authUrl', 'https://byterover.dev/oauth/authorize?x=1')
    })
  })

  describe('onAuthExpired', () => {
    it('should broadcast auth:expired for agents', () => {
      createHandler()
      const token = createValidToken()

      capturedAuthExpired!(token)

      const expiredCall = transport.broadcast.getCalls().find((c) => c.args[0] === AuthEvents.EXPIRED)
      expect(expiredCall).to.exist
      expect(expiredCall!.args[1]).to.deep.equal({})
    })

    it('should broadcast auth:stateChanged with isAuthorized=false for TUI', () => {
      createHandler()
      const token = createValidToken()

      capturedAuthExpired!(token)

      const stateChangedCall = transport.broadcast.getCalls().find((c) => c.args[0] === AuthEvents.STATE_CHANGED)
      expect(stateChangedCall).to.exist
      expect(stateChangedCall!.args[1]).to.deep.equal({isAuthorized: false})
    })
  })

  describe('processLoginCallback — auth cache refresh', () => {
    it('should refresh authStateStore cache immediately after saving token', async () => {
      // Need fresh mocks with full login flow support
      const loginTransport = createMockTransport()
      const loginAuthStateStore = {
        getToken: stub(),
        loadToken: stub().resolves(createValidToken()),
        onAuthChanged: stub(),
        onAuthExpired: stub(),
        startPolling: stub(),
        stopPolling: stub(),
      } as unknown as SinonStubbedInstance<IAuthStateStore>

      new AuthHandler({
        authService: {
          exchangeCodeForToken: stub().resolves({
            accessToken: 'a', expiresAt: new Date(Date.now() + 3_600_000),
            refreshToken: 'r', sessionKey: 's', tokenType: 'Bearer',
          }),
          initiateAuthorization: stub().returns({authUrl: 'https://auth.test', state: 'st'}),
          refreshToken: stub(),
        } as unknown as IAuthService,
        authStateStore: loginAuthStateStore,
        browserLauncher: {open: stub().resolves()} as unknown as IBrowserLauncher,
        callbackHandler: {
          getPort: stub().returns(3000), start: stub().resolves(),
          stop: stub().resolves(), waitForCallback: stub().resolves({code: 'c'}),
        } as unknown as ICallbackHandler,
        projectConfigStore,
        providerConfigStore: createMockProviderConfigStore(),
        resolveProjectPath: stub().returns('/test'),
        tokenStore: {clear: stub().resolves(), load: stub().resolves(), save: stub().resolves()} as unknown as ITokenStore,
        transport: loginTransport,
        userService,
      }).setup()

      const handler = loginTransport._handlers.get(AuthEvents.START_LOGIN)
      await handler!({}, 'client-1')
      await new Promise((resolve) => { setTimeout(resolve, 50) })

      expect(loginAuthStateStore.loadToken.called, 'loadToken should be called after login to refresh daemon cache').to.be.true
    })

    it('should refresh authStateStore cache before broadcasting LOGIN_COMPLETED', async () => {
      const callOrder: string[] = []
      const loginTransport = createMockTransport()
      const loginAuthStateStore = {
        getToken: stub(),
        loadToken: stub().callsFake(async () => { callOrder.push('loadToken'); return createValidToken() }),
        onAuthChanged: stub(),
        onAuthExpired: stub(),
        startPolling: stub(),
        stopPolling: stub(),
      } as unknown as SinonStubbedInstance<IAuthStateStore>

      new AuthHandler({
        authService: {
          exchangeCodeForToken: stub().resolves({
            accessToken: 'a', expiresAt: new Date(Date.now() + 3_600_000),
            refreshToken: 'r', sessionKey: 's', tokenType: 'Bearer',
          }),
          initiateAuthorization: stub().returns({authUrl: 'https://auth.test', state: 'st'}),
          refreshToken: stub(),
        } as unknown as IAuthService,
        authStateStore: loginAuthStateStore,
        browserLauncher: {open: stub().resolves()} as unknown as IBrowserLauncher,
        callbackHandler: {
          getPort: stub().returns(3000), start: stub().resolves(),
          stop: stub().resolves(), waitForCallback: stub().resolves({code: 'c'}),
        } as unknown as ICallbackHandler,
        projectConfigStore,
        providerConfigStore: createMockProviderConfigStore(),
        resolveProjectPath: stub().returns('/test'),
        tokenStore: {clear: stub().resolves(), load: stub().resolves(), save: stub().resolves()} as unknown as ITokenStore,
        transport: loginTransport,
        userService,
      }).setup()

      loginTransport.broadcast = stub().callsFake((event: string) => {
        if (event === AuthEvents.LOGIN_COMPLETED) callOrder.push('LOGIN_COMPLETED')
      }) as unknown as typeof loginTransport.broadcast

      const handler = loginTransport._handlers.get(AuthEvents.START_LOGIN)
      await handler!({}, 'client-1')
      await new Promise((resolve) => { setTimeout(resolve, 50) })

      expect(callOrder).to.include('loadToken')
      expect(callOrder).to.include('LOGIN_COMPLETED')
      expect(callOrder.indexOf('loadToken'), 'loadToken should be called before LOGIN_COMPLETED broadcast')
        .to.be.lessThan(callOrder.indexOf('LOGIN_COMPLETED'))
    })
  })

  describe('analytics emits', () => {
    it('emits auth_logout with outcome=success on the happy logout path', async () => {
      const analyticsClient = makeFakeAnalyticsClient()
      createHandler({analyticsClient})

      const handler = transport._handlers.get(AuthEvents.LOGOUT)!
      const result = await handler(undefined, 'client-1')

      expect(result).to.deep.equal({success: true})
      const trackCalls = analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.AUTH_LOGOUT)
      expect(trackCalls.length, 'auth_logout fires exactly once on success').to.equal(1)
      expect(trackCalls[0].args[1]).to.deep.equal({outcome: 'success'})
    })

    it('emits auth_logout with outcome=failure when the logout flow throws', async () => {
      const analyticsClient = makeFakeAnalyticsClient()
      const tokenStore = {
        clear: stub().rejects(new Error('disk full')),
        load: stub().resolves(),
        save: stub().resolves(),
      } as unknown as ITokenStore

      createHandler({analyticsClient, tokenStore})

      const handler = transport._handlers.get(AuthEvents.LOGOUT)!
      const result = await handler(undefined, 'client-1')

      expect(result).to.deep.equal({success: false})
      const trackCalls = analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.AUTH_LOGOUT)
      expect(trackCalls.length, 'auth_logout fires exactly once on failure').to.equal(1)
      const props = trackCalls[0].args[1] as {failure_kind?: string; outcome: string}
      expect(props.outcome).to.equal('failure')
      assertFailureKindDiscipline(props.failure_kind, 'auth_logout failure emit')
    })

    it('does not throw when analyticsClient.track throws on logout (analytics failures are swallowed)', async () => {
      const analyticsClient = makeFakeAnalyticsClient()
      analyticsClient.trackSpy.throws(new Error('boom'))

      createHandler({analyticsClient})

      const handler = transport._handlers.get(AuthEvents.LOGOUT)!
      const result = await handler(undefined, 'client-1')

      expect(result).to.deep.equal({success: true})
    })

    it('is a no-op when no analyticsClient is injected (optional dep, backward compat)', async () => {
      createHandler() // no analyticsClient override

      const handler = transport._handlers.get(AuthEvents.LOGOUT)!
      const result = await handler(undefined, 'client-1')

      expect(result).to.deep.equal({success: true})
    })

    it('emits auth_login with outcome=success on API-key login after token save + loadToken', async () => {
      const callOrder: string[] = []
      const analyticsClient = makeFakeAnalyticsClient()
      analyticsClient.trackSpy.callsFake((event: string) => {
        callOrder.push(`track:${event}`)
      })
      const tokenStore = {
        clear: stub().resolves(),
        load: stub().resolves(),
        save: stub().callsFake(async () => {
          callOrder.push('tokenStore.save')
        }),
      } as unknown as ITokenStore
      authStateStore.loadToken = stub().callsFake(async () => {
        callOrder.push('authStateStore.loadToken')
      }) as unknown as typeof authStateStore.loadToken

      createHandler({analyticsClient, tokenStore})

      const handler = transport._handlers.get(AuthEvents.LOGIN_WITH_API_KEY)!
      await handler({apiKey: 'test-key'}, 'client-1')

      const trackCalls = analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.AUTH_LOGIN)
      expect(trackCalls.length, 'auth_login fires exactly once on API-key success').to.equal(1)
      expect(trackCalls[0].args[1]).to.deep.equal({outcome: 'success'})
      expect(callOrder.indexOf('tokenStore.save'), 'save should precede track').to.be.lessThan(
        callOrder.indexOf(`track:${AnalyticsEventNames.AUTH_LOGIN}`),
      )
      expect(callOrder.indexOf('authStateStore.loadToken'), 'loadToken should precede track').to.be.lessThan(
        callOrder.indexOf(`track:${AnalyticsEventNames.AUTH_LOGIN}`),
      )
    })

    it('emits auth_login with outcome=failure when API-key login throws', async () => {
      const analyticsClient = makeFakeAnalyticsClient()
      userService.getCurrentUser = stub().rejects(new Error('invalid key')) as unknown as typeof userService.getCurrentUser

      createHandler({analyticsClient})

      const handler = transport._handlers.get(AuthEvents.LOGIN_WITH_API_KEY)!
      const result = await handler({apiKey: 'bad-key'}, 'client-1')

      expect(result.success).to.equal(false)
      const trackCalls = analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.AUTH_LOGIN)
      expect(trackCalls.length, 'auth_login fires exactly once on API-key failure').to.equal(1)
      const props = trackCalls[0].args[1] as {failure_kind?: string; outcome: string}
      expect(props.outcome).to.equal('failure')
      assertFailureKindDiscipline(props.failure_kind, 'auth_login API-key failure emit')
    })
  })

  describe('setupRefresh — failure path treats as full sign-out', () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping
    function makeRefreshHarness(opts: {
      previousToken: AuthToken | undefined
      refreshThrows: boolean
      rotator: IGlobalConfigRotator
    }): {
      analyticsClient: ReturnType<typeof makeFakeAnalyticsClient>
      callOrder: string[]
      callRefresh: () => Promise<unknown>
      tokenStore: ITokenStore & {clearSpy: ReturnType<typeof stub>}
    } {
      const callOrder: string[] = []
      const analyticsClient = makeFakeAnalyticsClient()
      analyticsClient.trackSpy.callsFake((event: string) => {
        callOrder.push(`track:${event}`)
      })
      const clearSpy = stub().callsFake(async () => {
        callOrder.push('tokenStore.clear')
      })
      const tokenStore = {
        clear: clearSpy,
        clearSpy,
        load: stub().resolves(opts.previousToken),
        save: stub().resolves(),
      } as unknown as ITokenStore & {clearSpy: ReturnType<typeof stub>}

      const refreshStub = opts.refreshThrows
        ? stub().rejects(new Error('refresh denied'))
        : stub().resolves({
            accessToken: 'new-a',
            expiresAt: new Date(Date.now() + 3_600_000),
            refreshToken: 'new-r',
            sessionKey: 'new-s',
            tokenType: 'Bearer',
          })

      const localTransport = createMockTransport()
      const localBroadcast = stub().callsFake((event: string) => {
        if (event === AuthEvents.STATE_CHANGED) callOrder.push('broadcast:STATE_CHANGED')
      })
      ;(localTransport as unknown as {broadcast: typeof localBroadcast}).broadcast = localBroadcast

      new AuthHandler({
        analyticsClient,
        authService: {
          exchangeCodeForToken: stub(),
          initiateAuthorization: stub(),
          refreshToken: refreshStub,
        } as unknown as IAuthService,
        authStateStore,
        browserLauncher: {open: stub()} as unknown as IBrowserLauncher,
        callbackHandler: {
          getPort: stub().returns(3000),
          start: stub().resolves(),
          stop: stub().resolves(),
          waitForCallback: stub().resolves({code: 'test'}),
        } as unknown as ICallbackHandler,
        globalConfigRotator: opts.rotator,
        projectConfigStore,
        providerConfigStore,
        resolveProjectPath: stub().returns('/test/project'),
        tokenStore,
        transport: localTransport,
        userService,
      }).setup()

      return {
        analyticsClient,
        callOrder,
        async callRefresh() {
          const handler = localTransport._handlers.get(AuthEvents.REFRESH)!
          return handler(undefined, 'client-1')
        },
        tokenStore,
      }
    }

    it('clears the token, emits auth_logout {failure_kind:"refresh_failed"}, rotates, and broadcasts STATE_CHANGED', async () => {
      const rotator = makeRotatorStub()
      const harness = makeRefreshHarness({
        previousToken: createValidToken(),
        refreshThrows: true,
        rotator,
      })

      const result = await harness.callRefresh()

      expect(result).to.deep.equal({success: false})
      expect(harness.tokenStore.clearSpy.calledOnce, 'token cleared on refresh failure').to.be.true
      expect(rotator.rotateSpy.calledOnce, 'device_id rotated on refresh failure').to.be.true

      const trackCalls = harness.analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.AUTH_LOGOUT)
      expect(trackCalls.length, 'auth_logout fires once on refresh-fail sign-out').to.equal(1)
      const props = trackCalls[0].args[1] as {failure_kind?: string; outcome: string}
      expect(props.outcome).to.equal('failure')
      expect(props.failure_kind).to.equal('refresh_failed')
      assertFailureKindDiscipline(props.failure_kind, 'refresh-fail sign-out emit')

      expect(harness.callOrder, 'STATE_CHANGED broadcast fired on refresh-fail').to.include('broadcast:STATE_CHANGED')
    })

    it('does NOT rotate when the previous token is expired (no live identity)', async () => {
      const expired = new AuthToken({
        accessToken: 'a',
        expiresAt: new Date(Date.now() - 60_000),
        refreshToken: 'r',
        sessionKey: 's',
        tokenType: 'Bearer',
        userEmail: 'old@example.com',
        userId: 'user-OLD',
      })
      const rotator = makeRotatorStub()
      const harness = makeRefreshHarness({previousToken: expired, refreshThrows: true, rotator})

      await harness.callRefresh()

      expect(rotator.rotateSpy.called, 'expired token before refresh means no live identity to retire').to.be.false
    })

    it('early-returns success=false without emitting or rotating when no token is loaded', async () => {
      const rotator = makeRotatorStub()
      const harness = makeRefreshHarness({previousToken: undefined, refreshThrows: false, rotator})

      const result = await harness.callRefresh()

      expect(result).to.deep.equal({success: false})
      expect(rotator.rotateSpy.called, 'no rotation when there was nothing to refresh').to.be.false
      const trackCalls = harness.analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.AUTH_LOGOUT)
      expect(trackCalls.length, 'no auth_logout emit on the early-return branch').to.equal(0)
    })

    it('does NOT rotate or emit on successful refresh (same user, token replaced)', async () => {
      const rotator = makeRotatorStub()
      const harness = makeRefreshHarness({
        previousToken: createValidToken(),
        refreshThrows: false,
        rotator,
      })

      const result = await harness.callRefresh()

      expect(result).to.deep.equal({success: true})
      expect(rotator.rotateSpy.called, 'successful refresh keeps the same identity').to.be.false
      const trackCalls = harness.analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.AUTH_LOGOUT)
      expect(trackCalls.length, 'no auth_logout on successful refresh').to.equal(0)
    })

    it('disconnects the byterover provider (symmetric with logout success + onAuthExpired)', async () => {
      providerConfigStore = createMockProviderConfigStore({isConnected: true})
      const rotator = makeRotatorStub()
      const harness = makeRefreshHarness({
        previousToken: createValidToken(),
        refreshThrows: true,
        rotator,
      })

      await harness.callRefresh()

      expect(providerConfigStore.disconnectProvider.calledOnceWith('byterover'), 'byterover must be disconnected on refresh-fail sign-out').to.be.true
    })

    it('does NOT throw when rotation fails on the refresh sign-out path', async () => {
      const rotator = makeRotatorStub()
      rotator.rotateSpy.rejects(new Error('disk full'))
      const harness = makeRefreshHarness({
        previousToken: createValidToken(),
        refreshThrows: true,
        rotator,
      })

      const result = await harness.callRefresh()

      expect(result).to.deep.equal({success: false})
    })
  })

  describe('device_id rotation on login — account switch', () => {
    describe('API-key path', () => {
      it('does NOT rotate on fresh login (no previous token)', async () => {
        const rotator = makeRotatorStub()

        createHandler({
          globalConfigRotator: rotator,
          tokenStore: tokenStoreWithPrevious(),
        })

        const handler = transport._handlers.get(AuthEvents.LOGIN_WITH_API_KEY)!
        await handler({apiKey: 'k'}, 'client-1')

        expect(rotator.rotateSpy.called, 'fresh login does not retire a non-existent identity').to.be.false
      })

      it('does NOT rotate when re-asserting the same user', async () => {
        const rotator = makeRotatorStub()

        createHandler({
          globalConfigRotator: rotator,
          tokenStore: tokenStoreWithPrevious(makeTokenForUser('user-123')),
        })

        const handler = transport._handlers.get(AuthEvents.LOGIN_WITH_API_KEY)!
        await handler({apiKey: 'k'}, 'client-1')

        expect(rotator.rotateSpy.called, 'same userId means no switch').to.be.false
      })

      it('rotates AFTER the auth_login emit when previous user differs from new user', async () => {
        const callOrder: string[] = []
        const analyticsClient = makeFakeAnalyticsClient()
        analyticsClient.trackSpy.callsFake((event: string) => {
          callOrder.push(`track:${event}`)
        })
        const rotator = makeRotatorStub()
        rotator.rotateSpy.callsFake(async () => {
          callOrder.push('rotate')
          return true
        })

        createHandler({
          analyticsClient,
          globalConfigRotator: rotator,
          tokenStore: tokenStoreWithPrevious(makeTokenForUser('user-OLD')),
        })

        const handler = transport._handlers.get(AuthEvents.LOGIN_WITH_API_KEY)!
        await handler({apiKey: 'k'}, 'client-1')

        expect(rotator.rotateSpy.calledOnce, 'rotation runs exactly once on switch').to.be.true
        expect(callOrder.indexOf(`track:${AnalyticsEventNames.AUTH_LOGIN}`), 'emit happens before rotation').to.be.lessThan(
          callOrder.indexOf('rotate'),
        )
      })

      it('does NOT rotate when the previous token is expired (not a live identity)', async () => {
        const expired = new AuthToken({
          accessToken: 'a',
          expiresAt: new Date(Date.now() - 60_000),
          refreshToken: 'r',
          sessionKey: 's',
          tokenType: 'Bearer',
          userEmail: 'old@example.com',
          userId: 'user-OLD',
        })
        const rotator = makeRotatorStub()

        createHandler({
          globalConfigRotator: rotator,
          tokenStore: tokenStoreWithPrevious(expired),
        })

        const handler = transport._handlers.get(AuthEvents.LOGIN_WITH_API_KEY)!
        await handler({apiKey: 'k'}, 'client-1')

        expect(rotator.rotateSpy.called, 'expired token does not count as a live previous identity').to.be.false
      })

      it('does NOT fail the login RPC when rotation throws', async () => {
        const rotator = makeRotatorStub()
        rotator.rotateSpy.rejects(new Error('disk full'))

        createHandler({
          globalConfigRotator: rotator,
          tokenStore: tokenStoreWithPrevious(makeTokenForUser('user-OLD')),
        })

        const handler = transport._handlers.get(AuthEvents.LOGIN_WITH_API_KEY)!
        const result = await handler({apiKey: 'k'}, 'client-1')

        expect(result.success).to.equal(true)
      })

      it('does NOT rotate on the login failure branch (no token committed)', async () => {
        const rotator = makeRotatorStub()
        userService.getCurrentUser = stub().rejects(
          new Error('invalid key'),
        ) as unknown as typeof userService.getCurrentUser

        createHandler({
          globalConfigRotator: rotator,
          tokenStore: tokenStoreWithPrevious(makeTokenForUser('user-OLD')),
        })

        const handler = transport._handlers.get(AuthEvents.LOGIN_WITH_API_KEY)!
        const result = await handler({apiKey: 'bad'}, 'client-1')

        expect(result.success).to.equal(false)
        expect(rotator.rotateSpy.called, 'failed login never claims the device for the new user').to.be.false
      })
    })

    describe('OAuth (processLoginCallback) path', () => {
      // eslint-disable-next-line unicorn/consistent-function-scoping
      function setupOAuthHandler(opts: {previousToken: AuthToken | undefined; rotator: IGlobalConfigRotator}): {
        callOrder: string[]
        run: () => Promise<void>
      } {
        const callOrder: string[] = []
        const oauthTransport = createMockTransport()
        const oauthAuthStateStore = {
          getToken: stub(),
          loadToken: stub().callsFake(async () => {
            callOrder.push('loadToken')
          }),
          onAuthChanged: stub(),
          onAuthExpired: stub(),
          startPolling: stub(),
          stopPolling: stub(),
        } as unknown as SinonStubbedInstance<IAuthStateStore>

        const analyticsClient = makeFakeAnalyticsClient()
        analyticsClient.trackSpy.callsFake((event: string) => {
          callOrder.push(`track:${event}`)
        })

        new AuthHandler({
          analyticsClient,
          authService: {
            exchangeCodeForToken: stub().resolves({
              accessToken: 'a',
              expiresAt: new Date(Date.now() + 3_600_000),
              refreshToken: 'r',
              sessionKey: 's',
              tokenType: 'Bearer',
            }),
            initiateAuthorization: stub().returns({authUrl: 'https://auth.test', state: 'st'}),
            refreshToken: stub(),
          } as unknown as IAuthService,
          authStateStore: oauthAuthStateStore,
          browserLauncher: {open: stub().resolves()} as unknown as IBrowserLauncher,
          callbackHandler: {
            getPort: stub().returns(3000),
            start: stub().resolves(),
            stop: stub().resolves(),
            waitForCallback: stub().resolves({code: 'c'}),
          } as unknown as ICallbackHandler,
          globalConfigRotator: opts.rotator,
          projectConfigStore,
          providerConfigStore: createMockProviderConfigStore(),
          resolveProjectPath: stub().returns('/test'),
          tokenStore: {
            clear: stub().resolves(),
            load: stub().resolves(opts.previousToken),
            save: stub().callsFake(async () => {
              callOrder.push('tokenStore.save')
            }),
          } as unknown as ITokenStore,
          transport: oauthTransport,
          userService,
        }).setup()

        return {
          callOrder,
          async run() {
            const handler = oauthTransport._handlers.get(AuthEvents.START_LOGIN)!
            await handler({}, 'client-1')
            // Wait for fire-and-forget processLoginCallback to finish.
            await new Promise((resolve) => {
              setTimeout(resolve, 50)
            })
          },
        }
      }

      it('does NOT rotate on fresh OAuth login (no previous token)', async () => {
        const rotator = makeRotatorStub()
        const harness = setupOAuthHandler({previousToken: undefined, rotator})

        await harness.run()

        expect(rotator.rotateSpy.called).to.be.false
      })

      it('does NOT rotate when OAuth re-issues for the same user', async () => {
        const rotator = makeRotatorStub()
        const sameUserToken = new AuthToken({
          accessToken: 'a',
          expiresAt: new Date(Date.now() + 3_600_000),
          refreshToken: 'r',
          sessionKey: 's',
          tokenType: 'Bearer',
          userEmail: 'test@example.com',
          userId: 'user-123',
        })
        const harness = setupOAuthHandler({previousToken: sameUserToken, rotator})

        await harness.run()

        expect(rotator.rotateSpy.called).to.be.false
      })

      it('rotates AFTER the auth_login emit when OAuth switches users', async () => {
        const rotator = makeRotatorStub()
        const otherUserToken = new AuthToken({
          accessToken: 'a',
          expiresAt: new Date(Date.now() + 3_600_000),
          refreshToken: 'r',
          sessionKey: 's',
          tokenType: 'Bearer',
          userEmail: 'old@example.com',
          userId: 'user-OLD',
        })
        const harness = setupOAuthHandler({previousToken: otherUserToken, rotator})
        rotator.rotateSpy.callsFake(async () => {
          harness.callOrder.push('rotate')
          return true
        })

        await harness.run()

        expect(rotator.rotateSpy.calledOnce).to.be.true
        expect(harness.callOrder.indexOf(`track:${AnalyticsEventNames.AUTH_LOGIN}`)).to.be.lessThan(
          harness.callOrder.indexOf('rotate'),
        )
      })
    })
  })

  describe('device_id rotation on logout', () => {
    it('rotates device_id AFTER the auth_logout emit when previously authenticated', async () => {
      const callOrder: string[] = []
      const analyticsClient = makeFakeAnalyticsClient()
      analyticsClient.trackSpy.callsFake((event: string) => {
        callOrder.push(`track:${event}`)
      })
      const rotator = makeRotatorStub()
      rotator.rotateSpy.callsFake(async () => {
        callOrder.push('rotate')
        return true
      })

      createHandler({
        analyticsClient,
        globalConfigRotator: rotator,
        tokenStore: makeValidTokenStoreFixture(),
      })

      const handler = transport._handlers.get(AuthEvents.LOGOUT)!
      const result = await handler(undefined, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(rotator.rotateSpy.calledOnce, 'rotateDeviceId called once on authenticated logout').to.be.true
      expect(callOrder.indexOf(`track:${AnalyticsEventNames.AUTH_LOGOUT}`), 'emit happens before rotation').to.be.lessThan(
        callOrder.indexOf('rotate'),
      )
    })

    it('does NOT rotate when token store returns undefined (already-anonymous logout)', async () => {
      const rotator = makeRotatorStub()

      createHandler({
        globalConfigRotator: rotator,
        tokenStore: makeMissingTokenStoreFixture(),
      })

      const handler = transport._handlers.get(AuthEvents.LOGOUT)!
      const result = await handler(undefined, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(rotator.rotateSpy.called, 'no rotation on already-anonymous logout').to.be.false
    })

    it('does NOT rotate when the stored token is expired (treated as already-anonymous)', async () => {
      const rotator = makeRotatorStub()

      createHandler({
        globalConfigRotator: rotator,
        tokenStore: makeExpiredTokenStoreFixture(),
      })

      const handler = transport._handlers.get(AuthEvents.LOGOUT)!
      const result = await handler(undefined, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(rotator.rotateSpy.called, 'expired token means no live identity to retire').to.be.false
    })

    it('does NOT fail the logout RPC when rotation throws', async () => {
      const rotator = makeRotatorStub()
      rotator.rotateSpy.rejects(new Error('disk full'))

      createHandler({
        globalConfigRotator: rotator,
        tokenStore: makeValidTokenStoreFixture(),
      })

      const handler = transport._handlers.get(AuthEvents.LOGOUT)!
      const result = await handler(undefined, 'client-1')

      expect(result).to.deep.equal({success: true})
    })

    it('does NOT rotate on the logout failure branch (indeterminate identity)', async () => {
      const rotator = makeRotatorStub()
      const tokenStore = {
        clear: stub().rejects(new Error('disk full')),
        load: stub().resolves(createValidToken()),
        save: stub().resolves(),
      } as unknown as ITokenStore

      createHandler({globalConfigRotator: rotator, tokenStore})

      const handler = transport._handlers.get(AuthEvents.LOGOUT)!
      const result = await handler(undefined, 'client-1')

      expect(result).to.deep.equal({success: false})
      expect(rotator.rotateSpy.called, 'rotation skipped when logout flow failed mid-way').to.be.false
    })

    it('is a no-op when no globalConfigRotator is injected (optional dep)', async () => {
      // Mirrors the existing optional-analyticsClient backward-compat pattern.
      createHandler({tokenStore: makeValidTokenStoreFixture()})

      const handler = transport._handlers.get(AuthEvents.LOGOUT)!
      const result = await handler(undefined, 'client-1')

      expect(result).to.deep.equal({success: true})
    })
  })

  describe('opportunistic token expiry — onAuthExpired callback', () => {
    it('does NOT rotate device_id (passive expiry is not a sign-out trigger)', () => {
      const rotator = makeRotatorStub()
      createHandler({globalConfigRotator: rotator})

      capturedAuthExpired!(createValidToken())

      expect(rotator.rotateSpy.called, 'polling-observed expiry is out of scope for rotation').to.be.false
    })
  })

  describe('setupGetState', () => {
    it('returns isAuthorized=true and skips brvConfig when body is undefined (TUI sends no body)', async () => {
      createHandler({tokenStore: makeValidTokenStoreFixture()})
      const handler = transport._handlers.get(AuthEvents.GET_STATE)!

       
      const result = await handler(undefined, 'client-1')

      expect(result.isAuthorized).to.equal(true)
      expect(result.user).to.deep.include({email: 'test@example.com', id: 'user-123'})
      expect(result.brvConfig).to.equal(undefined)
      expect(result.authToken).to.have.property('accessToken', 'test-access-token')
      expect(projectConfigStore.read.called, 'projectConfigStore.read should not be called without projectPath').to.be
        .false
    })

    it('returns full state including brvConfig when body has projectPath (WebUI happy path)', async () => {
      createHandler({tokenStore: makeValidTokenStoreFixture()})
      const handler = transport._handlers.get(AuthEvents.GET_STATE)!

      const result = await handler({projectPath: '/foo'}, 'client-1')

      expect(result.isAuthorized).to.equal(true)
      expect(result.brvConfig).to.deep.include({spaceId: 'space-1', teamId: 'team-1'})
      expect(projectConfigStore.read.calledOnceWith('/foo')).to.be.true
    })

    it('returns isAuthorized=true and skips brvConfig when body is empty object', async () => {
      createHandler({tokenStore: makeValidTokenStoreFixture()})
      const handler = transport._handlers.get(AuthEvents.GET_STATE)!

      const result = await handler({}, 'client-1')

      expect(result.isAuthorized).to.equal(true)
      expect(result.brvConfig).to.equal(undefined)
      expect(projectConfigStore.read.called).to.be.false
    })

    it('returns isAuthorized=false when token is missing, regardless of body', async () => {
      createHandler({tokenStore: makeMissingTokenStoreFixture()})
      const handler = transport._handlers.get(AuthEvents.GET_STATE)!

       
      const result = await handler(undefined, 'client-1')

      expect(result).to.deep.equal({isAuthorized: false})
    })

    it('returns isAuthorized=false when token is expired, regardless of body', async () => {
      createHandler({tokenStore: makeExpiredTokenStoreFixture()})
      const handler = transport._handlers.get(AuthEvents.GET_STATE)!

      const result = await handler({projectPath: '/foo'}, 'client-1')

      expect(result).to.deep.equal({isAuthorized: false})
    })
  })
})
