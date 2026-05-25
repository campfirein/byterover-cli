import {expect} from 'chai'

import {AcpFrameDecoder, encodeAcpFrame} from '../../../../../../src/server/infra/channel/drivers/acp-framing.js'

// Slice 2.2 — NDJSON framing for ACP over stdio.
//
// CHANNEL_PROTOCOL.md §6 / DESIGN.md §5: ACP framing is one JSON object per
// line, terminated by `\n`. No Content-Length prefix (that's LSP, not ACP).
// JSON.stringify escapes embedded newlines, so each physical line is exactly
// one logical message.

describe('ACP framing', () => {
  describe('AcpFrameDecoder', () => {
    it(String.raw`decodes a single complete message ending with \n`, () => {
      const dec = new AcpFrameDecoder()
      const msgs = dec.push(Buffer.from('{"id":1,"jsonrpc":"2.0","result":{}}\n'))
      expect(msgs).to.have.lengthOf(1)
      expect(msgs[0]).to.deep.equal({id: 1, jsonrpc: '2.0', result: {}})
    })

    it('buffers a partial message until the terminating newline arrives', () => {
      const dec = new AcpFrameDecoder()
      expect(dec.push(Buffer.from('{"id":1,"json'))).to.deep.equal([])
      expect(dec.push(Buffer.from('rpc":"2.0","result":{}}\n'))).to.deep.equal([
        {id: 1, jsonrpc: '2.0', result: {}},
      ])
    })

    it('decodes two messages arriving in a single chunk', () => {
      const dec = new AcpFrameDecoder()
      const msgs = dec.push(
        Buffer.from('{"id":1,"jsonrpc":"2.0","result":1}\n{"id":2,"jsonrpc":"2.0","result":2}\n'),
      )
      expect(msgs).to.have.lengthOf(2)
      expect(msgs[0]).to.deep.equal({id: 1, jsonrpc: '2.0', result: 1})
      expect(msgs[1]).to.deep.equal({id: 2, jsonrpc: '2.0', result: 2})
    })

    it('skips a malformed line and continues with the next valid line', () => {
      const dec = new AcpFrameDecoder()
      const msgs = dec.push(Buffer.from('not-json\n{"id":2,"jsonrpc":"2.0","result":2}\n'))
      expect(msgs).to.have.lengthOf(1)
      expect(msgs[0]).to.deep.equal({id: 2, jsonrpc: '2.0', result: 2})
    })

    it('handles a single logical line split across three chunks', () => {
      const dec = new AcpFrameDecoder()
      expect(dec.push(Buffer.from('{"id":'))).to.deep.equal([])
      expect(dec.push(Buffer.from('1,"jsonrpc"'))).to.deep.equal([])
      expect(dec.push(Buffer.from(':"2.0","result":{}}\n'))).to.deep.equal([
        {id: 1, jsonrpc: '2.0', result: {}},
      ])
    })
  })

  describe('encodeAcpFrame', () => {
    it(String.raw`emits a single JSON line terminated by \n`, () => {
      expect(encodeAcpFrame({id: 1, jsonrpc: '2.0', result: 42})).to.equal(
        '{"id":1,"jsonrpc":"2.0","result":42}\n',
      )
    })

    it('escapes embedded newlines inside string fields so each line is one message', () => {
      const out = encodeAcpFrame({jsonrpc: '2.0', method: 'note', params: {text: 'a\nb'}})
      expect(out.split('\n')).to.have.lengthOf(2) // payload + trailing empty
      expect(out.endsWith('\n')).to.equal(true)
    })
  })
})
