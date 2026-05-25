// Shared NDJSON / JSON-RPC plumbing for the Phase-2 mock-ACP fixtures.
//
// ESM, no TypeScript, no third-party deps. Each fixture script imports this
// module and supplies a small "behaviour" object that decides how to
// respond to ACP method calls. The library handles the boring bits:
//
//  - NDJSON framing on stdin / stdout (one line per JSON-RPC message,
//    terminated by `\n`).
//  - Request/response correlation via the `id` field.
//  - Server-to-client `session/request_permission` requests with a
//    correlated response handler so the fixture can await user decisions.
//  - Capture of every received `session/prompt` to
//    `process.env.MOCK_ACP_CAPTURE_FILE` (one JSON document per call,
//    appended). Integration tests read this back to assert prompt shape.

import {appendFileSync} from 'node:fs'
import {createInterface} from 'node:readline'

const send = (msg) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

const sendResponse = (id, result) => {
  send({id, jsonrpc: '2.0', result})
}

// Fixtures throw either a plain Error or an Error decorated with
// `acpErrorCode` (number) and optional `acpErrorData` to send a structured
// JSON-RPC error response. Phase-4 AUTH_REQUIRED fixtures use this to
// emit `{code: -32000, data: {authMethods: [...]}}`.
const sendError = (id, code, message, data) => {
  const err = {code, message}
  if (data !== undefined) err.data = data
  send({error: err, id, jsonrpc: '2.0'})
}

const sendErrorFromThrown = (id, error) => {
  if (error && typeof error === 'object' && typeof error.acpErrorCode === 'number') {
    sendError(id, error.acpErrorCode, error.message ?? String(error), error.acpErrorData)
    return
  }

  sendError(id, -32_000, error instanceof Error ? error.message : String(error))
}

const sendNotification = (method, params) => {
  send({jsonrpc: '2.0', method, params})
}

let nextRequestId = 1
const pendingPermissionResolvers = new Map()

const sendPermissionRequest = (sessionId, options, toolCall) => {
  const id = `mock-perm-${nextRequestId}`
  nextRequestId += 1
  send({
    id,
    jsonrpc: '2.0',
    method: 'session/request_permission',
    params: {options, sessionId, toolCall},
  })
  return new Promise((resolve) => {
    pendingPermissionResolvers.set(id, resolve)
  })
}

const capturePrompt = (params) => {
  const path = process.env.MOCK_ACP_CAPTURE_FILE
  if (path === undefined || path === '') return
  try {
    appendFileSync(path, `${JSON.stringify(params)}\n`, 'utf8')
  } catch {
    // Best-effort; capture failures should not break the fixture.
  }
}

export const start = (behaviour) => {
  const rl = createInterface({input: process.stdin})
  let sessionCounter = 0

  rl.on('line', (line) => {
    if (line.trim() === '') return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }

    // Permission response from host — resolve the pending promise.
    if (msg.id !== undefined && msg.result !== undefined && pendingPermissionResolvers.has(msg.id)) {
      const resolver = pendingPermissionResolvers.get(msg.id)
      pendingPermissionResolvers.delete(msg.id)
      resolver(msg.result)
      return
    }

    if (msg.method === 'initialize') {
      try {
        const result =
          behaviour.initialize === undefined
            ? {protocolVersion: 1}
            : behaviour.initialize(msg.params)
        sendResponse(msg.id, result)
      } catch (error) {
        sendErrorFromThrown(msg.id, error)
      }

      return
    }

    if (msg.method === 'session/new') {
      // Phase-3 onboard probing reads `session/new` outcomes when classifying
      // driver class (A vs B vs C-prime). Fixtures may supply a custom
      // handler that returns either a result object OR an Error to surface
      // ACP_SESSION_FAILED.
      if (behaviour.handleSessionNew === undefined) {
        sessionCounter += 1
        sendResponse(msg.id, {sessionId: `mock-session-${sessionCounter}`})
      } else {
        try {
          const result = behaviour.handleSessionNew(msg.params)
          if (result instanceof Error) {
            sendErrorFromThrown(msg.id, result)
          } else {
            sessionCounter += 1
            sendResponse(msg.id, result ?? {sessionId: `mock-session-${sessionCounter}`})
          }
        } catch (error) {
          sendErrorFromThrown(msg.id, error)
        }
      }

      return
    }

    if (msg.method === 'session/prompt') {
      capturePrompt(msg.params)
      Promise.resolve()
        .then(() => behaviour.handlePrompt(msg.params, {sendNotification, sendPermissionRequest}))
        .then(
          (result) => {
            sendResponse(msg.id, result ?? {stopReason: 'end_turn'})
          },
          (error) => {
            sendErrorFromThrown(msg.id, error)
          },
        )
      return
    }

    if (msg.method === 'session/cancel') {
      if (behaviour.handleCancel !== undefined) behaviour.handleCancel(msg.params)
      sendResponse(msg.id, {})
    }
  })

  rl.on('close', () => {
    // CLI fixture: process.exit IS the contract here; we want a clean
    // shutdown when the host closes our stdin.
    // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
    process.exit(0)
  })
}
