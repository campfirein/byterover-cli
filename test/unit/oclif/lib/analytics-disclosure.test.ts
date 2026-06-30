import {expect} from 'chai'

import {
  collectConsent,
  isInteractive,
  loadDisclosure,
} from '../../../../src/oclif/lib/analytics-disclosure.js'

describe('analytics-disclosure (M16.2 extracted lib)', () => {
  describe('loadDisclosure', () => {
    it('returns the disclosure markdown text (non-empty)', async () => {
      const text = await loadDisclosure()
      expect(text).to.be.a('string')
      expect(text.length).to.be.greaterThan(0)
    })
  })

  describe('isInteractive', () => {
    it('returns a boolean', () => {
      // The value depends on the test runner's TTY state; we just assert the
      // shape. Specific TTY/non-TTY behavior is exercised through collectConsent.
      expect(isInteractive()).to.be.a('boolean')
    })
  })

  describe('collectConsent', () => {
    it('returns true without prompting when yesFlag is set', async () => {
      const logs: string[] = []
      let promptCalled = false
      const result = await collectConsent({
        onError(): never {
          throw new Error('onError should not be called when yesFlag is set')
        },
        onLog: (msg) => logs.push(msg),
        async promptFn() {
          promptCalled = true
          return true
        },
        ttyCheck: () => false, // non-TTY
        yesFlag: true,
      })

      expect(result).to.equal(true)
      expect(promptCalled, 'prompt skipped when yesFlag is set').to.equal(false)
      expect(logs.length, 'disclosure markdown logged once').to.equal(1)
    })

    it('calls onError when non-interactive and yesFlag is false', async () => {
      const errors: string[] = []
      const logs: string[] = []
      class StopError extends Error {}

      try {
        await collectConsent({
          onError(msg: string): never {
            errors.push(msg)
            throw new StopError()
          },
          onLog: (msg) => logs.push(msg),
          promptFn: async () => true,
          ttyCheck: () => false,
          yesFlag: false,
        })
        expect.fail('expected onError to throw')
      } catch (error) {
        expect(error).to.be.instanceOf(StopError)
      }

      expect(errors.length).to.equal(1)
      expect(errors[0].toLowerCase()).to.match(/non-interactive|yes/)
    })

    it('calls the prompt and returns its result when interactive without yesFlag', async () => {
      const logs: string[] = []
      const result = await collectConsent({
        onError(): never {
          throw new Error('onError should not be called when TTY+prompt')
        },
        onLog: (msg) => logs.push(msg),
        promptFn: async () => true,
        ttyCheck: () => true,
        yesFlag: false,
      })

      expect(result).to.equal(true)
      expect(logs.length).to.equal(1)
    })

    it('returns false when the prompt is declined', async () => {
      const logs: string[] = []
      const result = await collectConsent({
        onError(): never {
          throw new Error('not expected')
        },
        onLog: (msg) => logs.push(msg),
        promptFn: async () => false,
        ttyCheck: () => true,
        yesFlag: false,
      })

      expect(result).to.equal(false)
    })

    it('translates inquirer ExitPromptError (Ctrl-C) to a declined consent', async () => {
      const logs: string[] = []
      // inquirer's ExitPromptError sets `name = 'ExitPromptError'`. We detect
      // by name so this test does not depend on which `@inquirer/core` copy
      // the running command actually loads (nested vs. hoisted node_modules).
      class FakeExitPromptError extends Error {
        public override readonly name = 'ExitPromptError'
      }

      const result = await collectConsent({
        onError(): never {
          throw new Error('onError should not be called on Ctrl-C')
        },
        onLog: (msg) => logs.push(msg),
        async promptFn() {
          throw new FakeExitPromptError('User force closed the prompt with SIGINT')
        },
        ttyCheck: () => true,
        yesFlag: false,
      })

      expect(result).to.equal(false)
      expect(logs.length, 'disclosure markdown was still logged before the prompt').to.equal(1)
    })

    it('re-throws non-ExitPromptError prompt failures so they are not swallowed', async () => {
      const logs: string[] = []
      class BoomError extends Error {
        public override readonly name = 'BoomError'
      }

      try {
        await collectConsent({
          onError(): never {
            throw new Error('onError should not be called on non-Exit prompt failure')
          },
          onLog: (msg) => logs.push(msg),
          async promptFn() {
            throw new BoomError('transport hiccup')
          },
          ttyCheck: () => true,
          yesFlag: false,
        })
        expect.fail('expected BoomError to propagate')
      } catch (error) {
        expect(error).to.be.instanceOf(BoomError)
      }
    })
  })
})
