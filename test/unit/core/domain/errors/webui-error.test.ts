import {expect} from 'chai'

import {WebUiError, WebUiPortInUseError} from '../../../../../src/server/core/domain/errors/webui-error.js'

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
