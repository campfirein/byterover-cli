import {expect} from 'chai'

import {copyTextToClipboard} from '../../../../src/webui/lib/clipboard.js'

type Stubbed<T> = {readonly value: T | undefined}

function setGlobal<K extends 'document' | 'navigator'>(key: K, value: unknown): void {
  Object.defineProperty(globalThis, key, {configurable: true, value, writable: true})
}

/**
 * Builds a minimal `document` stub good enough for the execCommand fallback
 * path: createElement (textarea), body.append/removeChild, execCommand. The
 * stub records every call so tests can assert side effects.
 */
function makeDocumentStub(execResult: boolean) {
  const calls: string[] = []
  const textarea = {
    remove() {
      calls.push('textarea.remove')
    },
    select() {
      calls.push('textarea.select')
    },
    setAttribute(name: string, _value: string) {
      calls.push(`textarea.setAttribute:${name}`)
    },
    setSelectionRange(_start: number, _end: number) {
      calls.push('textarea.setSelectionRange')
    },
    style: {left: '', position: '', top: ''},
    value: '',
  }
  const body = {
    append(_child: unknown) {
      calls.push('body.append')
    },
  }
  const doc = {
    body,
    createElement(_tag: string) {
      calls.push(`createElement:${_tag}`)
      return textarea
    },
    execCommand(_command: string) {
      calls.push(`execCommand:${_command}`)
      return execResult
    },
  }
  return {calls, doc, textarea}
}

describe('copyTextToClipboard (ENG-2968 secure-context fallback)', () => {
  let originalNavigator: Stubbed<unknown>
  let originalDocument: Stubbed<unknown>

  beforeEach(() => {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    originalNavigator = {value: (globalThis as {navigator?: unknown}).navigator}
    originalDocument = {value: (globalThis as {document?: unknown}).document}
  })

  afterEach(() => {
    if (originalNavigator.value === undefined) {
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      delete (globalThis as {navigator?: unknown}).navigator
    } else {
      setGlobal('navigator', originalNavigator.value)
    }

    if (originalDocument.value === undefined) {
      delete (globalThis as {document?: unknown}).document
    } else {
      setGlobal('document', originalDocument.value)
    }
  })

  it('returns true when navigator.clipboard.writeText succeeds (modern path)', async () => {
    let written: string | undefined
    setGlobal('navigator', {
      clipboard: {
        async writeText(text: string) {
          written = text
        },
      },
    })

    const ok = await copyTextToClipboard('hello')
    expect(ok).to.equal(true)
    expect(written).to.equal('hello')
  })

  it('falls back to execCommand when navigator.clipboard.writeText throws', async () => {
    setGlobal('navigator', {
      clipboard: {
        async writeText() {
          throw new Error('NotAllowedError')
        },
      },
    })
    const {calls, doc} = makeDocumentStub(true)
    setGlobal('document', doc)

    const ok = await copyTextToClipboard('hello')
    expect(ok).to.equal(true)
    expect(calls).to.include('execCommand:copy')
    expect(calls).to.include('textarea.remove')
  })

  it('falls back to execCommand when navigator is absent (insecure HTTP context)', async () => {
    setGlobal('navigator', undefined)
    const {calls, doc} = makeDocumentStub(true)
    setGlobal('document', doc)

    const ok = await copyTextToClipboard('hi')
    expect(ok).to.equal(true)
    expect(calls).to.include('execCommand:copy')
  })

  it('returns false when document is absent (SSR / web worker)', async () => {
    setGlobal('navigator', undefined)
    setGlobal('document', undefined)

    const ok = await copyTextToClipboard('hi')
    expect(ok).to.equal(false)
  })

  it('cleans up the textarea even when execCommand returns false', async () => {
    setGlobal('navigator', undefined)
    const {calls, doc} = makeDocumentStub(false)
    setGlobal('document', doc)

    const ok = await copyTextToClipboard('hi')
    expect(ok).to.equal(false)
    expect(calls).to.include('textarea.remove')
  })
})
