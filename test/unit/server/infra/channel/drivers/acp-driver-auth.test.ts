import {expect} from 'chai'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {
  AcpAuthRequiredError,
  AcpHandshakeFailedError,
} from '../../../../../../src/server/core/domain/channel/errors.js'
import {AcpDriver} from '../../../../../../src/server/infra/channel/drivers/acp-driver.js'

// Slice 4.2 — AUTH_REQUIRED surfacing. The driver classifies the JSON-RPC
// error from `initialize` and `session/new`, rethrowing AcpAuthRequiredError
// for the canonical kimi code -32000 (or the defensive -32602 / symbolic
// 'AUTH_REQUIRED' variants) so the onboard service can route to the
// AUTH_REQUIRED CLI exit path instead of the generic handshake-failed
// branch.

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HARNESS_DIR, '..', '..', '..', '..', '..', '..')
const fixture = (name: string): string => resolve(REPO_ROOT, 'test', 'fixtures', name)

const AUTH_INIT = fixture('mock-acp-auth-required-initialize.js')
const AUTH_SESSION = fixture('mock-acp-auth-required-session.js')
const AUTH_LEGACY = fixture('mock-acp-auth-required-legacy.js')
const BAD_HANDSHAKE = fixture('mock-acp-bad-handshake.js')
const INVALID_PARAMS_SESSION = fixture('mock-acp-invalid-params-session.js')

const makeDriver = (path: string): AcpDriver =>
  new AcpDriver({
    handle: '@kimi',
    invocation: {args: [path], command: 'node', cwd: REPO_ROOT},
  })

describe('AcpDriver — AUTH_REQUIRED classification (Slice 4.2)', function () {
  this.timeout(20_000)

  it('start() throws AcpAuthRequiredError when initialize returns -32000 with authMethods', async () => {
    const driver = makeDriver(AUTH_INIT)
    try {
      await driver.start()
      expect.fail('expected AcpAuthRequiredError')
    } catch (error) {
      expect(error).to.be.instanceOf(AcpAuthRequiredError)
      const authErr = error as AcpAuthRequiredError
      expect(authErr.authMethods).to.have.lengthOf(1)
      expect(authErr.authMethods[0].id).to.equal('login')
      expect(authErr.authMethods[0].fieldMeta?.terminalAuth?.command).to.equal('kimi')
    } finally {
      await driver.stop()
    }
  })

  it('probeSession() throws AcpAuthRequiredError when session/new returns -32000', async () => {
    const driver = makeDriver(AUTH_SESSION)
    try {
      await driver.start()
      try {
        await driver.probeSession()
        expect.fail('expected AcpAuthRequiredError from probeSession')
      } catch (error) {
        expect(error).to.be.instanceOf(AcpAuthRequiredError)
        const authErr = error as AcpAuthRequiredError
        expect(authErr.authMethods).to.have.lengthOf(1)
      }
    } finally {
      await driver.stop()
    }
  })

  it('start() handles the defensive -32602 legacy code path', async () => {
    const driver = makeDriver(AUTH_LEGACY)
    try {
      await driver.start()
      expect.fail('expected AcpAuthRequiredError for legacy -32602')
    } catch (error) {
      expect(error).to.be.instanceOf(AcpAuthRequiredError)
    } finally {
      await driver.stop()
    }
  })

  it('non-auth handshake errors still surface as AcpHandshakeFailedError', async () => {
    const driver = makeDriver(BAD_HANDSHAKE)
    try {
      await driver.start()
      expect.fail('expected AcpHandshakeFailedError')
    } catch (error) {
      expect(error).to.be.instanceOf(AcpHandshakeFailedError)
      expect(error).to.not.be.instanceOf(AcpAuthRequiredError)
    } finally {
      await driver.stop()
    }
  })

  it('probeSession() does NOT mis-classify -32602 Invalid params (no authMethods) as AUTH_REQUIRED', async () => {
    // Regression: real kimi-cli returns -32602 when session/new params fail
    // Pydantic validation. Without the `authMethods` guard, the defensive
    // -32602 path in classifyAcpAuthError would steal this and surface it
    // as AcpAuthRequiredError — exactly the UAT failure that started this
    // fix. probeSession must return `false` so the onboard classifier can
    // tag the driver as C-prime.
    const driver = makeDriver(INVALID_PARAMS_SESSION)
    try {
      await driver.start()
      const result = await driver.probeSession()
      expect(result).to.equal(false)
    } finally {
      await driver.stop()
    }
  })
})
