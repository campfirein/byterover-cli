/* eslint-disable camelcase */
import {expect} from 'chai'
import {stub} from 'sinon'

import type {IAuthStateReader} from '../../../../../src/server/core/interfaces/analytics/i-identity-resolver.js'
import type {IGlobalConfigStore} from '../../../../../src/server/core/interfaces/storage/i-global-config-store.js'

import {AuthToken} from '../../../../../src/server/core/domain/entities/auth-token.js'
import {GlobalConfig} from '../../../../../src/server/core/domain/entities/global-config.js'
import {IdentityResolver} from '../../../../../src/server/infra/analytics/identity-resolver.js'

const validDeviceId = '550e8400-e29b-41d4-a716-446655440000'

function makeStubStore(deviceId: string = validDeviceId, configPresent = true): IGlobalConfigStore {
  if (!configPresent) {
    return {
      read: stub().resolves(),
      write: stub().resolves(),
    }
  }

  const config = GlobalConfig.fromJson({
    analytics: false,
    deviceId,
    version: '0.0.1',
  })
  if (!config) {
    throw new Error('test fixture: GlobalConfig.fromJson must succeed')
  }

  return {
    read: stub().resolves(config),
    write: stub().resolves(),
  }
}

function makeAuthReader(token?: AuthToken): IAuthStateReader {
  return {getToken: () => token}
}

function makeMutableAuthReader(): {reader: IAuthStateReader; setToken: (t: AuthToken | undefined) => void} {
  let currentToken: AuthToken | undefined
  return {
    reader: {getToken: () => currentToken},
    setToken(t) {
      currentToken = t
    },
  }
}

function makeFullToken(): AuthToken {
  return new AuthToken({
    accessToken: 'access-abc',
    expiresAt: new Date(Date.now() + 3_600_000),
    refreshToken: 'refresh-xyz',
    sessionKey: 'session-key',
    userEmail: 'alice@example.com',
    userId: 'user-123',
    userName: 'Alice',
  })
}

function makeTokenWithEmpty(opts: {userEmail?: string; userName?: string}): AuthToken {
  return new AuthToken({
    accessToken: 'access-abc',
    expiresAt: new Date(Date.now() + 3_600_000),
    refreshToken: 'refresh-xyz',
    sessionKey: 'session-key',
    userEmail: opts.userEmail ?? 'alice@example.com',
    userId: 'user-123',
    userName: opts.userName,
  })
}

describe('IdentityResolver', () => {
  describe('anonymous (ticket scenario 1)', () => {
    it('should return only device_id when no auth token is present', async () => {
      const resolver = new IdentityResolver(makeAuthReader(), makeStubStore())

      const identity = await resolver.resolve()

      expect(identity).to.deep.equal({device_id: validDeviceId})
      expect(identity).to.not.have.property('user_id')
      expect(identity).to.not.have.property('email')
      expect(identity).to.not.have.property('name')
    })
  })

  describe('registered with full user (ticket scenario 2)', () => {
    it('should return user_id, email, name, and device_id', async () => {
      const resolver = new IdentityResolver(makeAuthReader(makeFullToken()), makeStubStore())

      const identity = await resolver.resolve()

      expect(identity).to.deep.equal({
        device_id: validDeviceId,
        email: 'alice@example.com',
        name: 'Alice',
        user_id: 'user-123',
      })
    })
  })

  describe('registered with empty userEmail (ticket scenario 3)', () => {
    it('should omit email property entirely (not present as undefined)', async () => {
      const token = makeTokenWithEmpty({userEmail: ''})
      const resolver = new IdentityResolver(makeAuthReader(token), makeStubStore())

      const identity = await resolver.resolve()

      expect(identity).to.not.have.property('email')
      expect(identity.user_id).to.equal('user-123')
      expect(identity.device_id).to.equal(validDeviceId)
    })
  })

  describe('auth state transitions (ticket scenarios 4 + 5)', () => {
    it('should pick up the new identity when transitioning anonymous → registered', async () => {
      const {reader, setToken} = makeMutableAuthReader()
      const resolver = new IdentityResolver(reader, makeStubStore())

      const first = await resolver.resolve()
      expect(first).to.deep.equal({device_id: validDeviceId})

      setToken(makeFullToken())
      const second = await resolver.resolve()

      expect(second).to.deep.equal({
        device_id: validDeviceId,
        email: 'alice@example.com',
        name: 'Alice',
        user_id: 'user-123',
      })
    })

    it('should pick up anonymous when transitioning registered → anonymous', async () => {
      const {reader, setToken} = makeMutableAuthReader()
      setToken(makeFullToken())
      const resolver = new IdentityResolver(reader, makeStubStore())

      const first = await resolver.resolve()
      expect(first.user_id).to.equal('user-123')

      setToken(undefined)
      const second = await resolver.resolve()

      expect(second).to.deep.equal({device_id: validDeviceId})
      expect(second).to.not.have.property('user_id')
    })
  })

  describe('device_id always present (ticket scenario 6)', () => {
    it('should include device_id when registered', async () => {
      const resolver = new IdentityResolver(makeAuthReader(makeFullToken()), makeStubStore())

      const identity = await resolver.resolve()

      expect(identity.device_id).to.equal(validDeviceId)
    })

    it('should include device_id when anonymous', async () => {
      const resolver = new IdentityResolver(makeAuthReader(), makeStubStore())

      const identity = await resolver.resolve()

      expect(identity.device_id).to.equal(validDeviceId)
    })
  })

  describe('empty userName (bonus)', () => {
    it('should omit name property entirely when userName is missing', async () => {
      const token = makeTokenWithEmpty({userName: undefined})
      const resolver = new IdentityResolver(makeAuthReader(token), makeStubStore())

      const identity = await resolver.resolve()

      expect(identity).to.not.have.property('name')
      expect(identity.user_id).to.equal('user-123')
    })
  })

  describe('missing GlobalConfig (bonus)', () => {
    it("should default device_id to '' when the store returns undefined", async () => {
      const resolver = new IdentityResolver(makeAuthReader(), makeStubStore('', false))

      const identity = await resolver.resolve()

      expect(identity).to.deep.equal({device_id: ''})
    })
  })

  // M4.1 regression: identity returned by resolve() is a snapshot, not a live view.
  // Subsequent auth-state mutations must not retroactively rewrite a previously
  // resolved Identity. The downstream queue stores these objects by reference,
  // so an accidental shared/mutated state would corrupt already-tracked events
  // when a user logs out before the flush completes.
  describe('M4.1 identity captured by value (snapshot semantics)', () => {
    it('should not mutate a previously resolved identity when the token reader later returns undefined', async () => {
      const {reader, setToken} = makeMutableAuthReader()
      setToken(makeFullToken())
      const resolver = new IdentityResolver(reader, makeStubStore())

      const firstResolved = await resolver.resolve()
      const snapshot = {...firstResolved}

      setToken(undefined)
      const second = await resolver.resolve()
      expect(second).to.deep.equal({device_id: validDeviceId})

      // First object must be byte-equivalent to the snapshot taken before the mutation.
      expect(firstResolved).to.deep.equal(snapshot)
      expect(firstResolved.user_id).to.equal('user-123')
      expect(firstResolved.email).to.equal('alice@example.com')
      expect(firstResolved.name).to.equal('Alice')
    })

    it('should not share references between two resolve() calls (each returns a fresh object)', async () => {
      const {reader, setToken} = makeMutableAuthReader()
      setToken(makeFullToken())
      const resolver = new IdentityResolver(reader, makeStubStore())

      const first = await resolver.resolve()
      const second = await resolver.resolve()

      expect(first).to.deep.equal(second)
      expect(first).to.not.equal(second) // distinct object references — no shared mutable state
    })
  })
})
