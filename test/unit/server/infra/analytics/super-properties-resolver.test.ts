 
import {expect} from 'chai'
import {restore, stub} from 'sinon'

import type {IGlobalConfigStore} from '../../../../../src/server/core/interfaces/storage/i-global-config-store.js'

import {GlobalConfig} from '../../../../../src/server/core/domain/entities/global-config.js'
import {SuperPropertiesResolver} from '../../../../../src/server/infra/analytics/super-properties-resolver.js'

const validDeviceId = '550e8400-e29b-41d4-a716-446655440000'

function makeStubStore(deviceId = validDeviceId): IGlobalConfigStore {
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

describe('SuperPropertiesResolver', () => {
  let savedBrvEnv: string | undefined

  beforeEach(() => {
    savedBrvEnv = process.env.BRV_ENV
  })

  afterEach(() => {
    if (savedBrvEnv === undefined) {
      delete process.env.BRV_ENV
    } else {
      process.env.BRV_ENV = savedBrvEnv
    }

    restore()
  })

  describe('resolved shape (ticket scenario 1)', () => {
    it('should contain all five keys', async () => {
      const resolver = new SuperPropertiesResolver(makeStubStore(), () => '1.2.3')

      const props = await resolver.resolve()

      expect(props).to.have.all.keys('device_id', 'cli_version', 'os', 'node_version', 'environment')
    })
  })

  describe('device_id (ticket scenario 2)', () => {
    it('should match what IGlobalConfigStore returned', async () => {
      const customId = '11111111-1111-1111-1111-111111111111'
      const resolver = new SuperPropertiesResolver(makeStubStore(customId), () => '1.2.3')

      const props = await resolver.resolve()

      expect(props.device_id).to.equal(customId)
    })

    it('should re-read device_id on every resolve() call', async () => {
      const store = makeStubStore()
      const resolver = new SuperPropertiesResolver(store, () => '1.2.3')

      await resolver.resolve()
      await resolver.resolve()
      await resolver.resolve()

      const readStub = store.read as ReturnType<typeof stub>
      expect(readStub.callCount).to.equal(3)
    })
  })

  describe('cli_version (ticket scenario 3)', () => {
    it('should match what versionReader returned', async () => {
      const resolver = new SuperPropertiesResolver(makeStubStore(), () => '9.9.9')

      const props = await resolver.resolve()

      expect(props.cli_version).to.equal('9.9.9')
    })
  })

  describe('os (ticket scenario 4)', () => {
    it('should match process.platform', async () => {
      const resolver = new SuperPropertiesResolver(makeStubStore(), () => '1.2.3')

      const props = await resolver.resolve()

      expect(props.os).to.equal(process.platform)
    })
  })

  describe('node_version (ticket scenario 5)', () => {
    it('should match process.version', async () => {
      const resolver = new SuperPropertiesResolver(makeStubStore(), () => '1.2.3')

      const props = await resolver.resolve()

      expect(props.node_version).to.equal(process.version)
    })
  })

  describe('environment (ticket scenario 6)', () => {
    it("should be 'development' when BRV_ENV=development", async () => {
      process.env.BRV_ENV = 'development'
      const resolver = new SuperPropertiesResolver(makeStubStore(), () => '1.2.3')

      const props = await resolver.resolve()

      expect(props.environment).to.equal('development')
    })

    it("should be 'production' when BRV_ENV=production", async () => {
      process.env.BRV_ENV = 'production'
      const resolver = new SuperPropertiesResolver(makeStubStore(), () => '1.2.3')

      const props = await resolver.resolve()

      expect(props.environment).to.equal('production')
    })

    it("should default to 'production' when BRV_ENV is unset", async () => {
      delete process.env.BRV_ENV
      const resolver = new SuperPropertiesResolver(makeStubStore(), () => '1.2.3')

      const props = await resolver.resolve()

      expect(props.environment).to.equal('production')
    })
  })

  describe('static-field caching (ticket scenario 7)', () => {
    it('should call versionReader only once across many resolve() calls', async () => {
      const versionReader = stub().returns('1.2.3')
      const resolver = new SuperPropertiesResolver(makeStubStore(), versionReader)

      await resolver.resolve()
      await resolver.resolve()
      await resolver.resolve()

      expect(versionReader.callCount).to.equal(1)
    })
  })
})
