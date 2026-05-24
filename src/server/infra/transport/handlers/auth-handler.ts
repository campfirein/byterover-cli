import type {UserDTO} from '../../../../shared/transport/types/dto.js'
import type {User} from '../../../core/domain/entities/user.js'
import type {IAuthService} from '../../../core/interfaces/auth/i-auth-service.js'
import type {ICallbackHandler} from '../../../core/interfaces/auth/i-callback-handler.js'
import type {ITokenStore} from '../../../core/interfaces/auth/i-token-store.js'
import type {IProviderConfigStore} from '../../../core/interfaces/i-provider-config-store.js'
import type {IBrowserLauncher} from '../../../core/interfaces/services/i-browser-launcher.js'
import type {IUserService} from '../../../core/interfaces/services/i-user-service.js'
import type {IAuthStateStore} from '../../../core/interfaces/state/i-auth-state-store.js'
import type {IProjectConfigStore} from '../../../core/interfaces/storage/i-project-config-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'
import type {ProjectPathResolver} from './handler-types.js'

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
  authService: IAuthService
  authStateStore: IAuthStateStore
  browserLauncher: IBrowserLauncher
  callbackHandler: ICallbackHandler
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
  private readonly authService: IAuthService
  private readonly authStateStore: IAuthStateStore
  private readonly browserLauncher: IBrowserLauncher
  private readonly callbackHandler: ICallbackHandler
  private readonly projectConfigStore: IProjectConfigStore
  private readonly providerConfigStore: IProviderConfigStore
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly tokenStore: ITokenStore
  private readonly transport: ITransportServer
  private readonly userService: IUserService

  constructor(deps: AuthHandlerDeps) {
    this.authService = deps.authService
    this.authStateStore = deps.authStateStore
    this.browserLauncher = deps.browserLauncher
    this.callbackHandler = deps.callbackHandler
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

  private async processLoginCallback(
    authContext: {authUrl: string; state: string},
    redirectUri: string,
  ): Promise<void> {
    try {
      const {code} = await this.callbackHandler.waitForCallback(authContext.state, 5 * 60 * 1000)
      const tokenData = await this.authService.exchangeCodeForToken(code, authContext, redirectUri)
      const user = await this.userService.getCurrentUser(tokenData.sessionKey)
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

      this.transport.broadcast(AuthEvents.LOGIN_COMPLETED, {
        success: true,
        user: toUserDTO(user),
      })

      this.transport.broadcast(AuthEvents.STATE_CHANGED, {
        isAuthorized: true,
        user: toUserDTO(user),
      })
    } catch (error) {
      this.transport.broadcast(AuthEvents.LOGIN_COMPLETED, {
        error: getErrorMessage(error),
        success: false,
      })
    } finally {
      await this.callbackHandler.stop()
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

        const {projectPath} = data
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

          this.transport.broadcast(AuthEvents.STATE_CHANGED, {
            isAuthorized: true,
            user: toUserDTO(user),
          })

          return {success: true, userEmail: user.email}
        } catch (error) {
          return {error: getErrorMessage(error), success: false}
        }
      },
    )
  }

  private setupLogout(): void {
    this.transport.onRequest<void, AuthLogoutResponse>(AuthEvents.LOGOUT, async () => {
      try {
        await this.tokenStore.clear()
        await this.disconnectByteRoverProvider()
        await this.authStateStore.loadToken()
        this.transport.broadcast(AuthEvents.STATE_CHANGED, {isAuthorized: false})
        return {success: true}
      } catch {
        return {success: false}
      }
    })
  }

  private setupRefresh(): void {
    this.transport.onRequest<void, AuthRefreshResponse>(AuthEvents.REFRESH, async () => {
      try {
        const token = await this.tokenStore.load()
        if (!token) {
          return {success: false}
        }

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
