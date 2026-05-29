/**
 * Rotates the device identity in the global config. Used by the auth RPC
 * handlers when an explicit user-initiated identity transition occurs
 * (logout, account-switch on login, refresh-failure sign-out) so the
 * machine-level analytics identity does not survive the transition.
 *
 * Narrow interface so AuthHandler does not need a dependency on the full
 * GlobalConfigHandler.
 */
export interface IGlobalConfigRotator {
  /**
   * Rewrites the on-disk `deviceId` with a fresh UUID, preserving the
   * analytics flag and config version. No-ops when the config file does
   * not yet exist (analytics never enabled — nothing to retire).
   *
   * @returns `true` if a rotation was performed, `false` if it was a no-op.
   */
  rotateDeviceId(): Promise<boolean>
}
