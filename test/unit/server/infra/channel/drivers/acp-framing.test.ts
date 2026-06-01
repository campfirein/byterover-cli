import {expect} from 'chai'

import {AcpFrameDecoder, encodeAcpFrame} from '../../../../../../src/server/infra/channel/drivers/acp-framing.js'

// NDJSON framing for ACP over stdio: one JSON message per line, terminated by
// `\n`. The decoder buffers partial reads and silently skips malformed lines so
// a corrupt frame doesn't poison the rest of the stream.

describe('acp-framing', () => {
  describe('encodeAcpFrame', () => {
    it('serialises a message as one JSON line terminated by a newline', () => {
      expect(encodeAcpFrame({id: 1, jsonrpc: '2.0'})).to.equal('{"id":1,"jsonrpc":"2.0"}\n')
    })

    it('escapes embedded newlines so each physical line is one logical message', () => {
      const encoded = encodeAcpFrame({text: 'a\nb'})
      expect(encoded.endsWith('\n')).to.equal(true)
      // The only literal newline is the trailing frame terminator.
      expect(encoded.split('\n')).to.have.lengthOf(2)
    })
  })

  describe('AcpFrameDecoder', () => {
    it('decodes a single complete frame', () => {
      const decoder = new AcpFrameDecoder()
      expect(decoder.push('{"a":1}\n')).to.deep.equal([{a: 1}])
    })

    it('decodes multiple frames in a single chunk', () => {
      const decoder = new AcpFrameDecoder()
      expect(decoder.push('{"a":1}\n{"b":2}\n')).to.deep.equal([{a: 1}, {b: 2}])
    })

    it('buffers a partial frame across pushes', () => {
      const decoder = new AcpFrameDecoder()
      expect(decoder.push('{"a":1}\n{"b":')).to.deep.equal([{a: 1}])
      expect(decoder.push('2}\n')).to.deep.equal([{b: 2}])
    })

    it('skips a malformed line and continues with the next frame', () => {
      const decoder = new AcpFrameDecoder()
      expect(decoder.push('not-json\n{"ok":true}\n')).to.deep.equal([{ok: true}])
    })

    it('ignores blank lines', () => {
      const decoder = new AcpFrameDecoder()
      expect(decoder.push('\n  \n{"a":1}\n')).to.deep.equal([{a: 1}])
    })

    it('accepts a Buffer chunk', () => {
      const decoder = new AcpFrameDecoder()
      expect(decoder.push(Buffer.from('{"a":1}\n', 'utf8'))).to.deep.equal([{a: 1}])
    })

    it('returns an empty array when no complete frame is present yet', () => {
      const decoder = new AcpFrameDecoder()
      expect(decoder.push('{"partial":')).to.deep.equal([])
    })
  })
})
