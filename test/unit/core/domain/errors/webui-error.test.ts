import {expect} from 'chai'

import {
  WebUiError,
  WebUiPortInUseError,
  WebUiServerAlreadyRunningError,
} from '../../../../../src/server/core/domain/errors/webui-error.js'

describe('webui-error', () => {
  describe('WebUiPortInUseError', () => {
    it('exposes the conflicting port and a descriptive message', () => {
      const error = new WebUiPortInUseError(7700)

      expect(error).to.be.an.instanceOf(WebUiError)
      expect(error).to.be.an.instanceOf(Error)
      expect(error.name).to.equal('WebUiPortInUseError')
      expect(error.port).to.equal(7700)
      expect(error.message).to.include('7700')
      expect(error.message).to.include('in use')
    })
  })

  describe('WebUiServerAlreadyRunningError', () => {
    it('identifies itself by name and extends WebUiError', () => {
      const error = new WebUiServerAlreadyRunningError()

      expect(error).to.be.an.instanceOf(WebUiError)
      expect(error).to.be.an.instanceOf(Error)
      expect(error.name).to.equal('WebUiServerAlreadyRunningError')
      expect(error.message).to.include('already running')
    })
  })
})
