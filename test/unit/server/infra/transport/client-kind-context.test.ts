/* eslint-disable camelcase */
import {expect} from 'chai'

import {
  clientKindContext,
  getClientKindFromContext,
  runWithClientKind,
} from '../../../../../src/server/infra/transport/client-kind-context.js'

describe('clientKindContext', () => {
  describe('outside any scope', () => {
    it('returns undefined from getClientKindFromContext()', () => {
      expect(getClientKindFromContext()).to.equal(undefined)
    })
  })

  describe('runWithClientKind', () => {
    it('exposes the wrapped value inside the callback', async () => {
      const observed = await runWithClientKind('cli', async () => getClientKindFromContext())
      expect(observed).to.equal('cli')
    })

    it('returns the callback result', async () => {
      const result = await runWithClientKind('webui', async () => 42)
      expect(result).to.equal(42)
    })

    it('propagates value through an await boundary', async () => {
      const observed = await runWithClientKind('tui', async () => {
        await Promise.resolve()
        return getClientKindFromContext()
      })
      expect(observed).to.equal('tui')
    })

    it('isolates sibling scopes', async () => {
      const [a, b] = await Promise.all([
        runWithClientKind('cli', async () => {
          await Promise.resolve()
          return getClientKindFromContext()
        }),
        runWithClientKind('webui', async () => {
          await Promise.resolve()
          return getClientKindFromContext()
        }),
      ])
      expect(a).to.equal('cli')
      expect(b).to.equal('webui')
    })

    it('does not leak into the outer scope after the callback resolves', async () => {
      await runWithClientKind('mcp', async () => {})
      expect(getClientKindFromContext()).to.equal(undefined)
    })
  })

  describe('clientKindContext (raw AsyncLocalStorage export)', () => {
    it('is the same store that runWithClientKind wraps', async () => {
      const observed = await new Promise<string | undefined>((resolve) => {
        clientKindContext.run({client_kind: 'extension'}, () => {
          resolve(getClientKindFromContext())
        })
      })
      expect(observed).to.equal('extension')
    })
  })
})
