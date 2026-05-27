import {expect} from 'chai'

import {generateUuid} from '../../../../src/webui/lib/uuid.js'

const UUID_V4_RE = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/

describe('generateUuid (ENG-2968 secure-context polyfill)', () => {
  let originalCrypto: unknown

  beforeEach(() => {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    originalCrypto = (globalThis as {crypto?: unknown}).crypto
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', {configurable: true, value: originalCrypto, writable: true})
  })

  it('returns a v4 UUID when crypto.randomUUID is available (secure context)', () => {
    const id = generateUuid()
    expect(id).to.match(UUID_V4_RE)
  })

  it('falls back to crypto.getRandomValues when randomUUID is missing (insecure HTTP context)', () => {
    let getRandomCalled = 0
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues(buf: Uint8Array) {
          getRandomCalled += 1
          for (let i = 0; i < buf.length; i++) buf[i] = i
          return buf
        },
      },
      writable: true,
    })

    const id = generateUuid()
    expect(getRandomCalled, 'getRandomValues should be invoked').to.equal(1)
    expect(id).to.match(UUID_V4_RE)
  })

  it('falls back to Math.random when crypto is unavailable entirely', () => {
    Object.defineProperty(globalThis, 'crypto', {configurable: true, value: undefined, writable: true})

    const id = generateUuid()
    expect(id).to.match(UUID_V4_RE)
  })

  it('produces distinct ids across calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) ids.add(generateUuid())
    expect(ids.size).to.equal(50)
  })
})
