/* eslint-disable camelcase */
import {expect} from 'chai'

import type {StoredAnalyticsRecord} from '../../../../src/shared/analytics/stored-record.js'

import {FORBIDDEN_FIELD_NAMES, redactRecord} from '../../../../src/shared/analytics/forbidden-field-names.js'

const validIdentity = {device_id: '550e8400-e29b-41d4-a716-446655440000'}

function makeRecord(overrides: Partial<StoredAnalyticsRecord> = {}): StoredAnalyticsRecord {
  return {
    attempts: 0,
    id: 'rec-1',
    identity: validIdentity,
    name: 'cli_invocation',
    properties: {},
    status: 'pending',
    timestamp: 1_700_000_000_000,
    ...overrides,
  }
}

describe('redactRecord (M11.2)', () => {
  describe('FORBIDDEN_FIELD_NAMES exports', () => {
    it('should export a non-empty Set of forbidden names', () => {
      expect(FORBIDDEN_FIELD_NAMES).to.be.instanceOf(Set)
      expect(FORBIDDEN_FIELD_NAMES.size).to.be.greaterThan(0)
    })

    it('should include canonical secret/credential names', () => {
      for (const name of ['password', 'token', 'access_token', 'secret', 'cookie']) {
        expect(FORBIDDEN_FIELD_NAMES.has(name), `forbidden list must include "${name}"`).to.equal(true)
      }
    })

    it('should include canonical PII / path names that the M2.8 fixture forbids in event schemas', () => {
      for (const name of ['email', 'phone', 'cwd', 'path', 'home_dir']) {
        expect(FORBIDDEN_FIELD_NAMES.has(name)).to.equal(true)
      }
    })
  })

  describe('redaction over record.properties', () => {
    it('should drop forbidden keys from properties (top level)', () => {
      const record = makeRecord({
        properties: {command_id: 'status', password: 'p455w0rd', token: 'jwt-xxx'},
      })

      const out = redactRecord(record)

      expect(out.properties).to.not.have.property('password')
      expect(out.properties).to.not.have.property('token')
      expect(out.properties).to.have.property('command_id', 'status')
    })

    it('should preserve non-forbidden keys verbatim', () => {
      const record = makeRecord({
        properties: {command_id: 'status', duration_ms: 42, success: true},
      })

      const out = redactRecord(record)

      expect(out.properties).to.deep.equal({command_id: 'status', duration_ms: 42, success: true})
    })

    it('should leave the record untouched when properties are empty', () => {
      const record = makeRecord({properties: {}})

      const out = redactRecord(record)

      expect(out.properties).to.deep.equal({})
    })

    it('should NOT recurse into nested objects (top-level redaction only)', () => {
      // The forbidden-list check applies only to the immediate keys of properties.
      // A nested {meta: {password: '...'}} keeps the nested key — defense lives at the
      // M2.8 schema layer (which prevents the schema from declaring nested forbidden
      // names), and the runtime redactor is intentionally minimal.
      const record = makeRecord({
        properties: {meta: {nested_ok: true, password: 'x'}, password: 'top-level'},
      })

      const out = redactRecord(record)

      expect(out.properties).to.not.have.property('password')
      expect(out.properties.meta).to.deep.equal({nested_ok: true, password: 'x'})
    })

    it('should return a fresh object (caller-safe — does not mutate input)', () => {
      const record = makeRecord({
        properties: {command_id: 'status', password: 'leak'},
      })

      const out = redactRecord(record)

      expect(out).to.not.equal(record)
      expect(out.properties).to.not.equal(record.properties)
      // Input properties unchanged.
      expect(record.properties).to.have.property('password')
    })
  })

  describe('identity is intentionally NOT redacted (locked decision)', () => {
    it('should preserve identity.email even though "email" is on FORBIDDEN_FIELD_NAMES', () => {
      const record = makeRecord({
        identity: {device_id: validIdentity.device_id, email: 'alice@example.com'},
      })

      const out = redactRecord(record)

      expect(out.identity).to.deep.equal({device_id: validIdentity.device_id, email: 'alice@example.com'})
    })

    it('should preserve identity.name and identity.user_id', () => {
      const record = makeRecord({
        identity: {device_id: validIdentity.device_id, name: 'Alice', user_id: 'user-1'},
      })

      const out = redactRecord(record)

      expect(out.identity).to.deep.equal({
        device_id: validIdentity.device_id,
        name: 'Alice',
        user_id: 'user-1',
      })
    })
  })
})
