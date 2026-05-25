import {expect} from 'chai'

import {makeOriginAllowlist} from '../../../../../src/server/infra/auth/origin-allowlist.js'

// Slice 3.5b — pure Origin-header allowlist. CHANNEL_PROTOCOL.md §13.1
// (Phase-3 spec edit) requires hosts to validate the Origin header
// against an allowlist BEFORE completing the Socket.IO handshake.
//
// Defaults: localhost / 127.0.0.1 / [::1] on any port. The env
// `BRV_ALLOWED_ORIGINS` (comma-separated) extends the allowlist for the
// dev web UI / cloud-bridge use cases.

describe('OriginAllowlist', () => {
  it('accepts the loopback origins (any port)', () => {
    const allow = makeOriginAllowlist()
    expect(allow.test('http://127.0.0.1')).to.equal(true)
    expect(allow.test('http://127.0.0.1:7700')).to.equal(true)
    expect(allow.test('http://localhost')).to.equal(true)
    expect(allow.test('http://localhost:53560')).to.equal(true)
    expect(allow.test('http://[::1]:7700')).to.equal(true)
  })

  it('rejects non-loopback origins', () => {
    const allow = makeOriginAllowlist()
    expect(allow.test('https://evil.example')).to.equal(false)
    expect(allow.test('http://192.168.1.10')).to.equal(false)
    expect(allow.test('http://attacker.localhost.example')).to.equal(false)
    expect(allow.test('https://localhost.attacker.example')).to.equal(false)
  })

  it('rejects undefined / empty Origin', () => {
    const allow = makeOriginAllowlist()
    expect(allow.test()).to.equal(false)
    expect(allow.test('')).to.equal(false)
  })

  it('extends the allowlist via `extraOrigins`', () => {
    const allow = makeOriginAllowlist({extraOrigins: ['https://myco.app']})
    expect(allow.test('https://myco.app')).to.equal(true)
    expect(allow.test('https://myco.app/some/path')).to.equal(true) // host-matched, path ignored
    expect(allow.test('https://other.app')).to.equal(false)
  })

  it('treats extraOrigins as exact host:port matches, not substring', () => {
    const allow = makeOriginAllowlist({extraOrigins: ['https://app.example']})
    expect(allow.test('https://app.example.attacker.example')).to.equal(false)
    expect(allow.test('https://app.example')).to.equal(true)
  })

  it('rejects malformed origin headers', () => {
    const allow = makeOriginAllowlist()
    expect(allow.test('not-a-url')).to.equal(false)
    // eslint-disable-next-line no-script-url
    expect(allow.test('javascript:alert(1)')).to.equal(false)
  })

  it('socketioMiddleware passes when Origin is allowed', () => {
    const allow = makeOriginAllowlist()
    let nextCalled = false
    const next = (err?: Error): void => {
      nextCalled = true
      if (err !== undefined) throw err
    }

    allow.socketioMiddleware({handshake: {headers: {origin: 'http://127.0.0.1:7700'}}} as never, next)
    expect(nextCalled).to.equal(true)
  })

  it('socketioMiddleware rejects when Origin is missing or blocked', () => {
    const allow = makeOriginAllowlist()
    let err: Error | undefined
    const next = (e?: Error): void => {
      err = e
    }

    allow.socketioMiddleware({handshake: {headers: {origin: 'https://evil.example'}}} as never, next)
    expect(err).to.be.instanceOf(Error)
    expect(err?.message).to.match(/origin/i)
  })
})
