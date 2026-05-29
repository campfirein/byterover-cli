import type {AnalyticsEventName} from '../../../../shared/analytics/event-names.js'
import type {PropsArg} from '../../../../shared/analytics/events/index.js'
import type {UserDTO} from '../../../../shared/transport/types/dto.js'
import type {User} from '../../../core/domain/entities/user.js'
import type {IAnalyticsClient} from '../../../core/interfaces/analytics/i-analytics-client.js'
import type {IAuthService} from '../../../core/interfaces/auth/i-auth-service.js'
import type {ICallbackHandler} from '../../../core/interfaces/auth/i-callback-handler.js'
import type {ITokenStore} from '../../../core/interfaces/auth/i-token-store.js'
import type {IProviderConfigStore} from '../../../core/interfaces/i-provider-config-store.js'
import type {IBrowserLauncher} from '../../../core/interfaces/services/i-browser-launcher.js'
import type {IUserService} from '../../../core/interfaces/services/i-user-service.js'
import type {IAuthStateStore} from '../../../core/interfaces/state/i-auth-state-store.js'
import type {IGlobalConfigRotator} from '../../../core/interfaces/state/i-global-config-rotator.js'
import type {IProjectConfigStore} from '../../../core/interfaces/storage/i-project-config-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'
import type {ProjectPathResolver} from './handler-types.js'

import {AnalyticsEventNames} from '../../../../shared/analytics/event-names.js'
import {
  AuthEvents,
  type AuthGetStateRequest,
  type AuthGetStateResponse,
  type AuthLoginWithApiKeyRequest,
  type AuthLoginWithApiKeyResponse,
  type AuthLogoutResponse,
  type AuthRefreshResponse,
  type AuthStartLoginRequest,
  type AuthStartLoginResponse,
} from '../../../../shared/transport/events/auth-events.js'
import {AuthToken} from '../../../core/domain/entities/auth-token.js'
import {TransportDaemonEventNames} from '../../../core/domain/transport/schemas.js'
import {getErrorMessage} from '../../../utils/error-helpers.js'
import {processLog} from '../../../utils/process-logger.js'

const BYTEROVER_PROVIDER_ID = 'byterover'

function toUserDTO(user: User): UserDTO {
  const dto: UserDTO = {
    email: user.email,
    hasOnboardedCli: user.hasOnboardedCli,
    id: user.id,
    name: user.name,
  }

  if (user.avatarUrl !== undefined) {
    dto.avatarUrl = user.avatarUrl
  }

  return dto
}

export interface AuthHandlerDeps {
  /**
   * Optional. When provided, the handler emits `auth_login` /
   * `auth_logout` analytics events on identity transitions. Optional so
   * legacy construction (and unit tests that don't care about analytics)
   * doesn't need to thread the dep through. Wired in `feature-handlers.ts`.
   */
  analyticsClient?: IAnalyticsClient
  authService: IAuthService
  authStateStore: IAuthStateStore
  browserLauncher: IBrowserLauncher
  callbackHandler: ICallbackHandler
  /**
   * Optional. When provided, the handler rotates the global `device_id`
   * on user-initiated identity transitions: explicit logout (if previously
   * authenticated), account-switch on login (userA → userB), and
   * refresh-failure sign-out. Optional so existing test harnesses don't
   * have to thread the dep through. Wired in `feature-handlers.ts`.
   */
  globalConfigRotator?: IGlobalConfigRotator
  projectConfigStore: IProjectConfigStore
  providerConfigStore: IProviderConfigStore
  resolveProjectPath: ProjectPathResolver
  tokenStore: ITokenStore
  transport: ITransportServer
  userService: IUserService
}

/**
 * Handles auth:* events.
 * Business logic for authentication — no terminal/UI calls.
 */
export class AuthHandler {
  private readonly analyticsClient: IAnalyticsClient | undefined
  private readonly authService: IAuthService
  private readonly authStateStore: IAuthStateStore
  private readonly browserLauncher: IBrowserLauncher
  private readonly callbackHandler: ICallbackHandler
  private readonly globalConfigRotator: IGlobalConfigRotator | undefined
  private readonly projectConfigStore: IProjectConfigStore
  private readonly providerConfigStore: IProviderConfigStore
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly tokenStore: ITokenStore
  private readonly transport: ITransportServer
  private readonly userService: IUserService

  constructor(deps: AuthHandlerDeps) {
    this.analyticsClient = deps.analyticsClient
    this.authService = deps.authService
    this.authStateStore = deps.authStateStore
    this.browserLauncher = deps.browserLauncher
    this.callbackHandler = deps.callbackHandler
    this.globalConfigRotator = deps.globalConfigRotator
    this.projectConfigStore = deps.projectConfigStore
    this.providerConfigStore = deps.providerConfigStore
    this.resolveProjectPath = deps.resolveProjectPath
    this.tokenStore = deps.tokenStore
    this.transport = deps.transport
    this.userService = deps.userService
  }

  setup(): void {
    this.setupGetState()
    this.setupLoginWithApiKey()
    this.setupStartLogin()
    this.setupLogout()
    this.setupRefresh()
    this.setupExternalAuthSync()
  }

  /**
   * Broadcasts auth:stateChanged payload for TUI when token changes externally.
   * Does NOT include brvConfig — that's project-scoped and can't be resolved in a global broadcast.
   * TUI preserves its existing brvConfig when the broadcast omits it.
   * On network error, skips broadcast silently (next poll cycle retries in 5s).
   */
  private async broadcastAuthStateChanged(token: AuthToken | undefined): Promise<void> {
    try {
      if (!token || !token.isValid()) {
        this.transport.broadcast(AuthEvents.STATE_CHANGED, {isAuthorized: false})
        return
      }

      const user = await this.userService.getCurrentUser(token.sessionKey)

      this.transport.broadcast(AuthEvents.STATE_CHANGED, {
        isAuthorized: true,
        user: toUserDTO(user),
      })
    } catch {
      // Network/API error fetching user info — broadcast authorized state without user details.
      // TUI auth-guard only checks isAuthorized, so the user proceeds immediately.
      // Next successful poll cycle (5s) fills in user details.
      this.transport.broadcast(AuthEvents.STATE_CHANGED, {isAuthorized: true})
    }
  }

  private async disconnectByteRoverProvider(): Promise<void> {
    try {
      const isConnected = await this.providerConfigStore.isProviderConnected(BYTEROVER_PROVIDER_ID)
      if (!isConnected) return

      await this.providerConfigStore.disconnectProvider(BYTEROVER_PROVIDER_ID)
      this.transport.broadcast(TransportDaemonEventNames.PROVIDER_UPDATED, {})
    } catch (error) {
      processLog(
        `[Auth] Failed to disconnect byterover on auth clear: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Analytics emit helper. Mirrors the try/processLog pattern from
   * `analytics-hook.ts` so analytics failures never affect command outcomes.
   */
  private emitAnalytics<E extends AnalyticsEventName>(event: E, ...rest: PropsArg<E>): void {
    const client = this.analyticsClient
    if (!client) return
    try {
      client.track(event, ...rest)
    } catch (error) {
      processLog(`[Auth] analytics track ${event} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async processLoginCallback(
    authContext: {authUrl: string; state: string},
    redirectUri: string,
  ): Promise<void> {
    try {
      const {code} = await this.callbackHandler.waitForCallback(authContext.state, 5 * 60 * 1000)
      const tokenData = await this.authService.exchangeCodeForToken(code, authContext, redirectUri)
      const user = await this.userService.getCurrentUser(tokenData.sessionKey)

      // Snapshot the previous live identity BEFORE save — drives the
      // account-switch rotation rule below. Expired previous tokens do not
      // count (the device was not actively claimed at switch time).
      // safeLoadToken treats a read failure as "no previous identity": a
      // transient token-store error must NOT discard a freshly-exchanged
      // OAuth token.
      const previousToken = await this.safeLoadToken()
      const previousUserId = previousToken?.isValid() ? previousToken.userId : undefined

      const authToken = new AuthToken({
        accessToken: tokenData.accessToken,
        expiresAt: tokenData.expiresAt,
        refreshToken: tokenData.refreshToken,
        sessionKey: tokenData.sessionKey,
        tokenType: tokenData.tokenType,
        userEmail: user.email,
        userId: user.id,
        userName: user.name,
      })

      await this.tokenStore.save(authToken)

      // Refresh the daemon's cached auth state immediately so that
      // subsequent provider:connect / provider:setActive calls see the
      // new token without waiting for the next 5-second poll cycle.
      await this.authStateStore.loadToken()

      // Emit AFTER loadToken so the per-event identity resolver stamps
      // the row with the new authenticated user_id (the Mixpanel
      // forwarder's alias path keys off `{name: auth_login, outcome:
      // success}`).
      this.emitAnalytics(AnalyticsEventNames.AUTH_LOGIN, {outcome: 'success'})

      // Rotate AFTER emit so this auth_login row carries the OLD device_id
      // — the switch is attributed to the departing user's history. Only
      // rotates on true account switch (live previous identity ≠ new).
      if (previousUserId !== undefined && previousUserId !== user.id) {
        await this.safeRotateDeviceId()
      }

      this.transport.broadcast(AuthEvents.LOGIN_COMPLETED, {
        success: true,
        user: toUserDTO(user),
      })

      this.transport.broadcast(AuthEvents.STATE_CHANGED, {
        isAuthorized: true,
        user: toUserDTO(user),
      })
    } catch (error) {
      // Emit the failure terminal so the funnel sees both halves.
      // Identity is still anonymous (token never committed). `failure_kind`
      // is a coarse tag — never leak `error.message` here (would risk PII).
      // eslint-disable-next-line camelcase
      this.emitAnalytics(AnalyticsEventNames.AUTH_LOGIN, {failure_kind: 'oauth_flow', outcome: 'failure'})

      this.transport.broadcast(AuthEvents.LOGIN_COMPLETED, {
        error: getErrorMessage(error),
        success: false,
      })
    } finally {
      await this.callbackHandler.stop()
    }
  }

  /**
   * Reads the stored token, swallowing any error to `undefined`. Used by
   * the auth RPC handlers to snapshot the pre-transition identity for
   * rotation decisions; a transient read failure here must NOT abort the
   * RPC (e.g. discard a freshly-exchanged OAuth token, or fail a logout).
   * The default `FileTokenStore` already swallows internally, but custom
   * stores might not — this keeps the handlers defensive.
   */
  private async safeLoadToken(): Promise<AuthToken | undefined> {
    try {
      return await this.tokenStore.load()
    } catch (error) {
      processLog(`[Auth] token load failed: ${getErrorMessage(error)}`)
      return undefined
    }
  }

  /**
   * Rotates `device_id` without failing the calling RPC. Rotation MUST NOT
   * block or fail an auth transition — it is post-hoc bookkeeping so the
   * next analytics event ships under a fresh anonymous identity.
   */
  private async safeRotateDeviceId(): Promise<void> {
    const rotator = this.globalConfigRotator
    if (!rotator) return
    try {
      await rotator.rotateDeviceId()
    } catch (error) {
      processLog(`[Auth] device_id rotation failed: ${getErrorMessage(error)}`)
    }
  }

  /**
   * Registers callbacks on AuthStateStore to broadcast auth events when
   * external changes are detected (CLI login, token expiry, token refresh).
   *
   * Broadcasts both:
   * - auth:updated (for agent child processes)
   * - auth:stateChanged (for TUI — same event TUI already subscribes to)
   */
  private setupExternalAuthSync(): void {
    this.authStateStore.onAuthChanged((token) => {
      // Broadcast auth:updated for agents (existing behavior, preserved)
      this.transport.broadcast(AuthEvents.UPDATED, {
        hasToken: token !== undefined,
        isValid: token?.isValid() ?? false,
        sessionKey: token?.sessionKey,
      })

      // Build full auth:stateChanged for TUI (fire-and-forget async).
      // On network error, skips broadcast silently — next poll cycle retries in 5s.
      this.broadcastAuthStateChanged(token).catch((error: unknown) => {
        processLog(
          `[Auth] Failed to broadcast auth state change: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    })

    this.authStateStore.onAuthExpired(() => {
      this.transport.broadcast(AuthEvents.EXPIRED, {})
      this.transport.broadcast(AuthEvents.STATE_CHANGED, {isAuthorized: false})
      this.disconnectByteRoverProvider()
    })
  }

  private setupGetState(): void {
    this.transport.onRequest<AuthGetStateRequest, AuthGetStateResponse>(AuthEvents.GET_STATE, async (data) => {
      try {
        const token = await this.tokenStore.load()

        if (token === undefined || !token.isValid()) {
          return {isAuthorized: false}
        }

        const projectPath = data?.projectPath
        const [user, brvConfig] = await Promise.all([
          this.userService.getCurrentUser(token.sessionKey),
          projectPath ? this.projectConfigStore.read(projectPath) : Promise.resolve(),
        ])

        return {
          authToken: {
            accessToken: token.accessToken,
            expiresAt: token.expiresAt.toISOString(),
          },
          brvConfig: brvConfig
            ? {
                spaceId: brvConfig.spaceId,
                spaceName: brvConfig.spaceName,
                teamId: brvConfig.teamId,
                teamName: brvConfig.teamName,
                version: brvConfig.version,
              }
            : undefined,
          isAuthorized: true,
          user: toUserDTO(user),
        }
      } catch {
        return {isAuthorized: false}
      }
    })
  }

  private setupLoginWithApiKey(): void {
    this.transport.onRequest<AuthLoginWithApiKeyRequest, AuthLoginWithApiKeyResponse>(
      AuthEvents.LOGIN_WITH_API_KEY,
      async (data) => {
        try {
          const user = await this.userService.getCurrentUser(data.apiKey)

          // Snapshot the previous live identity BEFORE save — drives the
          // account-switch rotation rule below. Expired tokens do not count
          // (the device was not actively claimed at switch time).
          // safeLoadToken swallows read failures to undefined so a
          // transient token-store error does not fail the login RPC.
          const previousToken = await this.safeLoadToken()
          const previousUserId = previousToken?.isValid() ? previousToken.userId : undefined

          const authToken = new AuthToken({
            accessToken: 'unnecessary',
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
            refreshToken: 'unnecessary',
            sessionKey: data.apiKey,
            tokenType: 'unnecessary',
            userEmail: user.email,
            userId: user.id,
            userName: user.name,
          })

          await this.tokenStore.save(authToken)
          await this.authStateStore.loadToken()

          // Emit AFTER loadToken (same identity-stamping rationale as the OAuth path).
          this.emitAnalytics(AnalyticsEventNames.AUTH_LOGIN, {outcome: 'success'})

          // Rotate AFTER emit so this auth_login row carries the OLD device_id.
          // Only rotates when a live previous identity is replaced by a different user.
          if (previousUserId !== undefined && previousUserId !== user.id) {
            await this.safeRotateDeviceId()
          }

          this.transport.broadcast(AuthEvents.STATE_CHANGED, {
            isAuthorized: true,
            user: toUserDTO(user),
          })

          return {success: true, userEmail: user.email}
        } catch (error) {
          // Failure-path emit covers api-key auth failures (invalid key,
          // network error, user fetch failure). Stays anonymous — no token was
          // committed.
          // eslint-disable-next-line camelcase
          this.emitAnalytics(AnalyticsEventNames.AUTH_LOGIN, {failure_kind: 'api_key', outcome: 'failure'})

          return {error: getErrorMessage(error), success: false}
        }
      },
    )
  }

  private setupLogout(): void {
    this.transport.onRequest<void, AuthLogoutResponse>(AuthEvents.LOGOUT, async () => {
      // Snapshot identity BEFORE clearing — drives the "skip rotation when
      // already anonymous" rule. An expired token is treated as anonymous
      // (the device has not been actively claimed by a live session).
      // safeLoadToken swallows read failures so a transient token-store
      // error does not reject the logout RPC.
      const previousToken = await this.safeLoadToken()
      const wasAuthenticated = previousToken !== undefined && previousToken.isValid()

      try {
        await this.tokenStore.clear()
        await this.disconnectByteRoverProvider()
        await this.authStateStore.loadToken()

        // Emit on the success terminal (single-emit guarantee — a
        // success emit at the START would double-fire with the catch
        // branch when a later step throws). By the time we reach here
        // loadToken() has already flipped identity to anonymous, so the
        // success row stamps `{device_id}` only. The OLD-identity events
        // (any pending tracks under the logged-in user) ship separately:
        // wire-analytics-auth-pre-transition.ts hooks `onBeforeAuthChange`
        // and awaits `flush()` before loadToken commits the identity
        // change, draining them under the logged-in identity. Downstream
        // consumers join `auth_logout` rows back to the user via
        // `device_id`.
        this.emitAnalytics(AnalyticsEventNames.AUTH_LOGOUT, {outcome: 'success'})

        // Rotate AFTER the emit so this auth_logout row still carries the
        // OLD device_id (the one the departing user's history is keyed on).
        // Subsequent track() calls will pick up the new id automatically —
        // identity-resolver re-reads the config per event.
        if (wasAuthenticated) {
          await this.safeRotateDeviceId()
        }

        this.transport.broadcast(AuthEvents.STATE_CHANGED, {isAuthorized: false})
        return {success: true}
      } catch {
        // Failure-path emit covers token-clear / provider-disconnect /
        // state-reload errors. Identity at trackAsync-resolve time may be
        // logged-in (clear failed first) or anonymous (clear succeeded but a
        // later step failed); both are valid for diagnostic purposes.
        // `failure_kind` is a coarse tag — never raw `error.message`.
        // Do NOT rotate on the failure branch: state is indeterminate (we
        // may not actually be signed out) and rotating now could burn a
        // device_id while the user is still effectively the previous identity.
        // eslint-disable-next-line camelcase
        this.emitAnalytics(AnalyticsEventNames.AUTH_LOGOUT, {failure_kind: 'logout_flow', outcome: 'failure'})

        return {success: false}
      }
    })
  }

  private setupRefresh(): void {
    this.transport.onRequest<void, AuthRefreshResponse>(AuthEvents.REFRESH, async () => {
      // safeLoadToken so a read failure short-circuits to {success:false}
      // instead of rejecting the RPC (matches the prior contract before
      // the load was moved outside the try).
      const token = await this.safeLoadToken()
      if (!token) {
        return {success: false}
      }

      try {
        const refreshedTokenData = await this.authService.refreshToken(token.refreshToken)
        const user = await this.userService.getCurrentUser(refreshedTokenData.sessionKey)
        const newToken = new AuthToken({
          accessToken: refreshedTokenData.accessToken,
          expiresAt: refreshedTokenData.expiresAt,
          refreshToken: refreshedTokenData.refreshToken,
          sessionKey: refreshedTokenData.sessionKey,
          tokenType: refreshedTokenData.tokenType,
          userEmail: user.email,
          userId: user.id,
          userName: user.name,
        })

        await this.tokenStore.save(newToken)
        await this.authStateStore.loadToken()

        this.transport.broadcast(AuthEvents.STATE_CHANGED, {
          isAuthorized: true,
          user: toUserDTO(user),
        })

        return {success: true}
      } catch {
        // Refresh failure is treated as a definitive sign-out: clear the
        // token, disconnect byterover (symmetric with the explicit logout
        // and onAuthExpired paths), emit auth_logout (so the funnel sees
        // the transition), rotate device_id, and broadcast state-cleared
        // so TUI/WebUI surface a re-login prompt rather than keep the
        // stale token in their caches. Wrap each side effect so a single
        // cascading failure does not skip the rest. Returning
        // {success:false} preserves the prior contract.
        await this.tokenStore.clear().catch((error: unknown) => {
          processLog(`[Auth] token clear failed during refresh sign-out: ${getErrorMessage(error)}`)
        })
        await this.disconnectByteRoverProvider()
        await this.authStateStore.loadToken().catch((error: unknown) => {
          processLog(`[Auth] authStateStore reload failed during refresh sign-out: ${getErrorMessage(error)}`)
        })

        // eslint-disable-next-line camelcase
        this.emitAnalytics(AnalyticsEventNames.AUTH_LOGOUT, {failure_kind: 'refresh_failed', outcome: 'failure'})

        if (token.isValid()) {
          // Only retire the device when the pre-refresh identity was live.
          // An already-expired token observed by the refresh RPC is not an
          // active claim on the device.
          await this.safeRotateDeviceId()
        }

        // Explicit STATE_CHANGED broadcast (symmetric with the logout
        // success branch). The onAuthChanged listener also broadcasts
        // after loadToken transitions the cached token, but the explicit
        // call here delivers synchronously before this RPC returns.
        this.transport.broadcast(AuthEvents.STATE_CHANGED, {isAuthorized: false})
        return {success: false}
      }
    })
  }

  private setupStartLogin(): void {
    this.transport.onRequest<AuthStartLoginRequest | undefined, AuthStartLoginResponse>(
      AuthEvents.START_LOGIN,
      async (request) => {
        await this.callbackHandler.start()
        const port = this.callbackHandler.getPort()
        if (!port) {
          throw new Error('Failed to start callback server')
        }

        const redirectUri = `http://localhost:${port}/callback`
        const authContext = this.authService.initiateAuthorization(redirectUri)

        // Open browser unless the caller wants to handle it (e.g. web UI uses window.open).
        // Non-blocking, don't fail if it can't open.
        if (!request?.skipBrowserLaunch) {
          try {
            await this.browserLauncher.open(authContext.authUrl)
          } catch {
            // Browser open failed — TUI will show URL
          }
        }

        // Wait for callback in background, then complete login
        this.waitForLoginCallback(authContext, redirectUri)

        return {authUrl: authContext.authUrl}
      },
    )
  }

  private waitForLoginCallback(authContext: {authUrl: string; state: string}, redirectUri: string): void {
    // Fire-and-forget: wait for OAuth callback, then broadcast result
    this.processLoginCallback(authContext, redirectUri).catch(() => {
      // Errors handled inside processLoginCallback
    })
  }
}
