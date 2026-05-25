/**
 * `ByteRoverMcpServer.stop()` shutdown coverage.
 *
 * The MCP server must close its underlying `McpServer` SDK instance during
 * stop so that the parent client sees a protocol-level shutdown rather than
 * just stdio EOF. Without this, the parent has no way to distinguish a clean
 * exit from a kill -9 and may mis-classify the lifecycle.
 */

import {expect} from 'chai'
import * as sinon from 'sinon'

import {ByteRoverMcpServer} from '../../../../src/server/infra/mcp/mcp-server.js'

describe('ByteRoverMcpServer.stop()', () => {
  let server: ByteRoverMcpServer

  beforeEach(() => {
    sinon.stub(process.stderr, 'write').returns(true)
    server = new ByteRoverMcpServer({version: '3.13.0', workingDirectory: process.cwd()})
  })

  afterEach(() => {
    sinon.restore()
  })

  it('closes the McpServer SDK instance during shutdown', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const innerServer = (server as any).server
    const closeSpy = sinon.stub(innerServer, 'close').resolves()

    await server.stop()

    expect(closeSpy.callCount).to.equal(1)
  })

  it('disconnects the daemon client BEFORE closing the McpServer transport', async () => {
    // Rationale: any in-flight tool handler awaiting daemon work needs the
    // daemon disconnect signal to surface a clean MCP error response over the
    // still-open stdio transport. Reversing the order strands those handlers
    // on a closed transport and the parent never sees the error.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const innerServer = (server as any).server
    const closeSpy = sinon.stub(innerServer, 'close').resolves()
    const disconnectSpy = sinon.stub().resolves()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(server as any).client = {disconnect: disconnectSpy}

    await server.stop()

    expect(disconnectSpy.callCount).to.equal(1)
    expect(closeSpy.callCount).to.equal(1)
    expect(disconnectSpy.calledBefore(closeSpy)).to.equal(true)
  })
})
