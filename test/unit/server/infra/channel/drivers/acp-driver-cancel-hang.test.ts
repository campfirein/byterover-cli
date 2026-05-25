import {expect} from 'chai'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {AcpDriver} from '../../../../../../src/server/infra/channel/drivers/acp-driver.js'

// Post-merge review item #3: AcpDriver.cancel() must unblock the
// iterator even when the child process never responds to session/prompt.
//
// Pre-fix, `iteratePromptQueue` awaited `promptPromise` unconditionally
// at the end, and `cancel()` only resolved pending permission contexts
// — it did NOT flip `state.done` or wake up the parked iterator. A
// child that hung on `session/prompt` would cause the orchestrator's
// background streaming task to leak forever, never reaching
// `releaseNextQueued` or `maybeFinaliseTurn`.

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..', '..')
const HANG_FIXTURE = resolve(REPO_ROOT, 'test', 'fixtures', 'mock-acp-hang.js')

describe('AcpDriver.cancel() unblocks the iterator on a stuck prompt (review #3)', function () {
  this.timeout(15_000)

  it('iteratePromptQueue returns within 500ms of cancel(), even if session/prompt never replies', async () => {
    const driver = new AcpDriver({
      handle: '@hang',
      invocation: {args: [HANG_FIXTURE], command: 'node', cwd: REPO_ROOT},
    })

    try {
      await driver.start()
      const iter = driver.prompt({prompt: [{text: 'hi', type: 'text'}], turnId: 't-hang'})

      // Drain a tick so the prompt() iterator is parked waiting for either
      // a session/update notification or for dispatchPrompt to flip done.
      // The hang fixture never emits notifications and never resolves
      // session/prompt — so without the fix, the next iterator step blocks
      // forever.
      const drainPromise = (async () => {
        const collected: unknown[] = []
        for await (const event of iter) collected.push(event)
        return collected
      })()

      // Give the parked iterator a brief window.
      await new Promise((r) => {
        setTimeout(r, 100)
      })

      // Cancel — this MUST unblock the iterator.
      const cancelStart = Date.now()
      await driver.cancel('t-hang')

      // The drain should resolve quickly. If it does not, the fix is missing.
      const drained = await Promise.race([
        drainPromise.then((events) => ({events, timedOut: false as const})),
        new Promise<{timedOut: true}>((r) => {
          setTimeout(() => r({timedOut: true}), 500)
        }),
      ])

      const elapsed = Date.now() - cancelStart
      expect(drained, `iterator hung after cancel (elapsed ${elapsed}ms)`).to.not.have.property(
        'timedOut',
        true,
      )
    } finally {
      await driver.stop().catch(() => {})
    }
  })
})
