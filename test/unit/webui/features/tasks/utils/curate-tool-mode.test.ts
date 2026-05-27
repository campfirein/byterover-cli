import {expect} from 'chai'

import {
  curateHtmlDirectRowTitle,
  parseCurateHtmlDirectInput,
  parseCurateHtmlDirectResult,
} from '../../../../../../src/webui/features/tasks/utils/curate-tool-mode.js'

describe('curate-tool-mode payload parsers', () => {
describe('parseCurateHtmlDirectInput', () => {
  it('parses a payload with html only', () => {
    const content = JSON.stringify({html: '<bv-topic path="foo">x</bv-topic>'})
    expect(parseCurateHtmlDirectInput(content)).to.deep.equal({
      confirmOverwrite: undefined,
      html: '<bv-topic path="foo">x</bv-topic>',
      userIntent: undefined,
    })
  })

  it('preserves confirmOverwrite when set', () => {
    const content = JSON.stringify({confirmOverwrite: true, html: '<bv-topic path="foo"/>'})
    expect(parseCurateHtmlDirectInput(content)).to.deep.equal({
      confirmOverwrite: true,
      html: '<bv-topic path="foo"/>',
      userIntent: undefined,
    })
  })

  it('preserves userIntent when set (CLI-dispatched curate)', () => {
    const content = JSON.stringify({
      html: '<bv-topic path="foo"/>',
      userIntent: 'remember the JWT rotation policy',
    })
    expect(parseCurateHtmlDirectInput(content)).to.deep.equal({
      confirmOverwrite: undefined,
      html: '<bv-topic path="foo"/>',
      userIntent: 'remember the JWT rotation policy',
    })
  })

  it('returns undefined for malformed JSON', () => {
    expect(parseCurateHtmlDirectInput('not-json')).to.equal(undefined)
  })

  it('returns undefined when html is missing', () => {
    expect(parseCurateHtmlDirectInput(JSON.stringify({confirmOverwrite: true}))).to.equal(undefined)
  })
})

describe('parseCurateHtmlDirectResult', () => {
  it('parses an ok result', () => {
    const content = JSON.stringify({
      filePath: 'security/auth.html',
      overwrote: false,
      status: 'ok',
      topicPath: 'security/auth',
    })
    expect(parseCurateHtmlDirectResult(content)).to.deep.equal({
      filePath: 'security/auth.html',
      overwrote: false,
      status: 'ok',
      topicPath: 'security/auth',
    })
  })

  it('round-trips a realistic path-exists validation-failed payload', () => {
    // Mirrors the wire shape produced by html-writer.ts when the daemon
    // refuses a clobbering write: a single HtmlWriteError with kind:
    // 'path-exists' that inlines the existing topic so the calling agent
    // can merge.
    const existingContent = '<bv-topic path="security/auth">\n  <p>old body</p>\n</bv-topic>'
    const wire = {
      errors: [
        {
          existingContent,
          kind: 'path-exists',
          message: 'Topic already exists at security/auth. Pass confirmOverwrite: true to replace it.',
          topicPath: 'security/auth',
        },
      ],
      status: 'validation-failed',
    }

    const parsed = parseCurateHtmlDirectResult(JSON.stringify(wire))
    expect(parsed).to.not.equal(undefined)
    if (!parsed || parsed.status !== 'validation-failed') {
      throw new Error('expected validation-failed result')
    }

    expect(parsed.errors).to.have.lengthOf(1)
    const [err] = parsed.errors
    expect(err.kind).to.equal('path-exists')
    expect(err.message).to.contain('already exists')
    expect(err.existingContent).to.equal(existingContent)
  })

  it('drops errors that are missing a kind discriminator', () => {
    const wire = {
      errors: [
        {kind: 'unknown-bv-element', message: 'bad', tag: 'bv-fake'},
        {code: 'legacy-shape', message: 'bad'},
      ],
      status: 'validation-failed',
    }
    const parsed = parseCurateHtmlDirectResult(JSON.stringify(wire))
    if (!parsed || parsed.status !== 'validation-failed') {
      throw new Error('expected validation-failed result')
    }

    expect(parsed.errors).to.have.lengthOf(1)
    expect(parsed.errors[0].kind).to.equal('unknown-bv-element')
  })

  it('returns undefined for malformed JSON', () => {
    expect(parseCurateHtmlDirectResult('not-json')).to.equal(undefined)
  })

  it('returns undefined for an unrecognized status', () => {
    expect(parseCurateHtmlDirectResult(JSON.stringify({status: 'weird'}))).to.equal(undefined)
  })
})

describe('curateHtmlDirectRowTitle', () => {
  it('returns userIntent when present (CLI-dispatched curate)', () => {
    const content = JSON.stringify({
      html: '<bv-topic path="security/auth"/>',
      userIntent: 'remember the JWT rotation policy',
    })
    expect(curateHtmlDirectRowTitle(content)).to.equal('remember the JWT rotation policy')
  })

  it('falls back to the bv-topic path attribute when userIntent is absent (MCP-dispatched curate)', () => {
    const content = JSON.stringify({html: '<bv-topic path="security/auth" title="JWT"><bv-reason>x</bv-reason></bv-topic>'})
    expect(curateHtmlDirectRowTitle(content)).to.equal('security/auth')
  })

  it('returns undefined when the payload is unparseable', () => {
    expect(curateHtmlDirectRowTitle('not-json{')).to.equal(undefined)
  })

  it('returns undefined when neither userIntent nor a path attribute is present', () => {
    expect(curateHtmlDirectRowTitle(JSON.stringify({html: '<bv-topic title="x"></bv-topic>'}))).to.equal(undefined)
  })

  it('HTML-decodes entities in the extracted path so &amp; renders as &', () => {
    // Forward-compat: today bv-topic paths are lowercase-letters/slashes by writer
    // contract, but if the charset widens the row title must not show raw entities.
    const content = JSON.stringify({html: '<bv-topic path="foo/bar&amp;baz" title="t"></bv-topic>'})
    expect(curateHtmlDirectRowTitle(content)).to.equal('foo/bar&baz')
  })
})
})
