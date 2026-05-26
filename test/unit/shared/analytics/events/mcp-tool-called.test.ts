/* eslint-disable camelcase */
import {expect} from 'chai'

import {McpToolCalledSchema} from '../../../../../src/shared/analytics/events/mcp-tool-called.js'

const baseValid = {
  client_name: 'Cursor',
  duration_ms: 123,
  success: true,
  tool_name: 'brv-query' as const,
}

describe('McpToolCalledSchema', () => {
  describe('valid payloads', () => {
    it('should accept tool_name="brv-query"', () => {
      expect(McpToolCalledSchema.safeParse(baseValid).success).to.equal(true)
    })

    it('should accept tool_name="brv-curate"', () => {
      expect(McpToolCalledSchema.safeParse({...baseValid, tool_name: 'brv-curate'}).success).to.equal(true)
    })

    it('should accept success=false', () => {
      expect(McpToolCalledSchema.safeParse({...baseValid, success: false}).success).to.equal(true)
    })

    it('should accept duration_ms=0', () => {
      expect(McpToolCalledSchema.safeParse({...baseValid, duration_ms: 0}).success).to.equal(true)
    })
  })

  describe('invalid payloads', () => {
    it('should reject unknown tool_name', () => {
      expect(McpToolCalledSchema.safeParse({...baseValid, tool_name: 'mystery-tool'}).success).to.equal(false)
    })

    it('should reject empty client_name', () => {
      expect(McpToolCalledSchema.safeParse({...baseValid, client_name: ''}).success).to.equal(false)
    })

    it('should reject negative duration_ms', () => {
      expect(McpToolCalledSchema.safeParse({...baseValid, duration_ms: -1}).success).to.equal(false)
    })

    it('should reject non-integer duration_ms', () => {
      expect(McpToolCalledSchema.safeParse({...baseValid, duration_ms: 1.5}).success).to.equal(false)
    })

    it('should reject non-boolean success', () => {
      expect(McpToolCalledSchema.safeParse({...baseValid, success: 1}).success).to.equal(false)
    })

    it('should reject unknown extra fields (strict)', () => {
      expect(McpToolCalledSchema.safeParse({...baseValid, error_class: 'TimeoutError'}).success).to.equal(false)
    })

    it('should reject missing required fields', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {success: _, ...withoutSuccess} = baseValid
      expect(McpToolCalledSchema.safeParse(withoutSuccess).success).to.equal(false)
    })
  })
})
