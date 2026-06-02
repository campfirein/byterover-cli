import {expect} from 'chai'

import {taskDisplayTitle} from '../../../../../../src/webui/features/tasks/utils/task-display-title.js'

describe('taskDisplayTitle', () => {
  it('returns the decoded query for a query-tool-mode task', () => {
    const content = JSON.stringify({limit: 10, query: 'agent loop and computer use automation'})
    expect(taskDisplayTitle({content, type: 'query-tool-mode'})).to.equal('agent loop and computer use automation')
  })

  it('falls back to the raw content when a query-tool-mode payload is unparseable', () => {
    expect(taskDisplayTitle({content: 'not-json{', type: 'query-tool-mode'})).to.equal('not-json{')
  })

  it('returns the raw content for a plain query task', () => {
    const content = 'what is the point on the corner top-right?'
    expect(taskDisplayTitle({content, type: 'query'})).to.equal(content)
  })

  it('decodes the row title for a curate-tool-mode task', () => {
    const content = JSON.stringify({html: '<bv-topic path="security/auth" title="JWT"></bv-topic>'})
    expect(taskDisplayTitle({content, type: 'curate-tool-mode'})).to.equal('security/auth')
  })
})
