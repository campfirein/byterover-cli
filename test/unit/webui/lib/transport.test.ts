import {expect} from 'chai'

import {resolveDaemonHost} from '../../../../src/webui/lib/transport.js'

function setLocation(value: unknown): void {
  Object.defineProperty(globalThis, 'location', {configurable: true, value, writable: true})
}

describe('resolveDaemonHost (ENG-2968 browser hostname swap)', () => {
  let original: unknown

  beforeEach(() => {
    original = (globalThis as {location?: unknown}).location
  })

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as {location?: unknown}).location
    } else {
      setLocation(original)
    }
  })

  it('returns 127.0.0.1 when location is undefined (SSR / Node)', () => {
    setLocation(undefined)
    expect(resolveDaemonHost()).to.equal('127.0.0.1')
  })

  it('returns location.hostname for loopback page origin', () => {
    setLocation({hostname: '127.0.0.1'})
    expect(resolveDaemonHost()).to.equal('127.0.0.1')
  })

  it('returns location.hostname for a LAN IP page origin', () => {
    setLocation({hostname: '192.168.1.10'})
    expect(resolveDaemonHost()).to.equal('192.168.1.10')
  })

  it('returns location.hostname for a DNS hostname page origin', () => {
    setLocation({hostname: 'brv.local'})
    expect(resolveDaemonHost()).to.equal('brv.local')
  })
})
