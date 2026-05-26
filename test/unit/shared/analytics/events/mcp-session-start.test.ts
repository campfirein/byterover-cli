/* eslint-disable camelcase */
import {expect} from 'chai'

import {McpSessionStartSchema} from '../../../../../src/shared/analytics/events/mcp-session-start.js'

describe('McpSessionStartSchema', () => {
  it('should accept a valid client_name', () => {
    expect(McpSessionStartSchema.safeParse({client_name: 'Cursor'}).success).to.equal(true)
  })

  it('should reject empty client_name', () => {
    expect(McpSessionStartSchema.safeParse({client_name: ''}).success).to.equal(false)
  })

  it('should reject missing client_name', () => {
    expect(McpSessionStartSchema.safeParse({}).success).to.equal(false)
  })

  it('should reject non-string client_name', () => {
    expect(McpSessionStartSchema.safeParse({client_name: 42}).success).to.equal(false)
  })

  it('should reject unknown extra fields (strict)', () => {
    expect(McpSessionStartSchema.safeParse({client_name: 'Cursor', client_version: '1.0.0'}).success).to.equal(false)
  })

  it('should reject null', () => {
    expect(McpSessionStartSchema.safeParse(null).success).to.equal(false)
  })
})
