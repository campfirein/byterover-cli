/* eslint-disable camelcase */
import type {Identity} from '../../core/domain/analytics/identity.js'
import type {IAuthStateReader, IIdentityResolver} from '../../core/interfaces/analytics/i-identity-resolver.js'
import type {IGlobalConfigStore} from '../../core/interfaces/storage/i-global-config-store.js'

/**
 * Builds the per-event Identity from current auth state + GlobalConfig.
 *
 * - Anonymous (no auth token) → `{device_id}` only.
 * - Registered → `{user_id, email?, name?, device_id}` where empty
 *   `email` / `name` cause the property to be OMITTED (not present
 *   as `undefined`) so downstream serializers don't emit `"email": null`.
 *
 * No caching — each `resolve()` call re-reads both sources so auth-state
 * transitions take effect immediately.
 */
export class IdentityResolver implements IIdentityResolver {
  private readonly authStateReader: IAuthStateReader
  private readonly globalConfigStore: IGlobalConfigStore

  public constructor(authStateReader: IAuthStateReader, globalConfigStore: IGlobalConfigStore) {
    this.authStateReader = authStateReader
    this.globalConfigStore = globalConfigStore
  }

  public async resolve(): Promise<Identity> {
    const config = await this.globalConfigStore.read()
    const device_id = config?.deviceId ?? ''
    const token = this.authStateReader.getToken()

    if (!token) {
      return {device_id}
    }

    return {
      device_id,
      user_id: token.userId,
      ...(token.userEmail ? {email: token.userEmail} : {}),
      ...(token.userName ? {name: token.userName} : {}),
    }
  }
}
