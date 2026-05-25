import {expect} from 'chai'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {
  AcpBinaryNotFoundError,
  AcpHandshakeFailedError,
  resolveHandshakeTimeoutMs,
} from '../../../../../../src/server/core/domain/channel/errors.js'
import {AcpDriver} from '../../../../../../src/server/infra/channel/drivers/acp-driver.js'

// Slice 4.4 — handshake timeout config + AcpBinaryNotFoundError.

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HARNESS_DIR, '..', '..', '..', '..', '..', '..')

describe('AcpDriver — handshake timeout + binary-not-found (Slice 4.4)', function () {
  this.timeout(20_000)

  describe('resolveHandshakeTimeoutMs (pure)', () => {
    it('defaults to 15_000ms when env is unset', () => {
      expect(resolveHandshakeTimeoutMs({})).to.equal(15_000)
    })

    it('honours BRV_ACP_HANDSHAKE_TIMEOUT_MS when set to a positive integer', () => {
      expect(resolveHandshakeTimeoutMs({BRV_ACP_HANDSHAKE_TIMEOUT_MS: '30000'})).to.equal(30_000)
    })

    it('falls back to the default on a non-numeric env value', () => {
      expect(resolveHandshakeTimeoutMs({BRV_ACP_HANDSHAKE_TIMEOUT_MS: 'oops'})).to.equal(15_000)
    })

    it('falls back to the default on zero or negative', () => {
      expect(resolveHandshakeTimeoutMs({BRV_ACP_HANDSHAKE_TIMEOUT_MS: '0'})).to.equal(15_000)
      expect(resolveHandshakeTimeoutMs({BRV_ACP_HANDSHAKE_TIMEOUT_MS: '-1'})).to.equal(15_000)
    })
  })

  describe('AcpBinaryNotFoundError', () => {
    it('start() throws AcpBinaryNotFoundError when the binary is missing on PATH', async () => {
      const driver = new AcpDriver({
        handle: '@missing',
        invocation: {
          args: [],
          command: '/nonexistent/path/to/brv-phase4-not-a-real-binary-1234',
          cwd: REPO_ROOT,
        },
      })
      try {
        await driver.start()
        expect.fail('expected AcpBinaryNotFoundError')
      } catch (error) {
        expect(error).to.be.instanceOf(AcpBinaryNotFoundError)
        expect((error as Error).message).to.match(/PATH/)
      } finally {
        await driver.stop().catch(() => {})
      }
    })

    it('AcpBinaryNotFoundError is distinct from AcpHandshakeFailedError', async () => {
      const driver = new AcpDriver({
        handle: '@missing',
        invocation: {
          args: [],
          command: '/nonexistent/path/to/brv-phase4-not-a-real-binary-1234',
          cwd: REPO_ROOT,
        },
      })
      try {
        await driver.start()
        expect.fail('expected an error')
      } catch (error) {
        expect(error).to.be.instanceOf(AcpBinaryNotFoundError)
        expect(error).to.not.be.instanceOf(AcpHandshakeFailedError)
      } finally {
        await driver.stop().catch(() => {})
      }
    })
  })
})
