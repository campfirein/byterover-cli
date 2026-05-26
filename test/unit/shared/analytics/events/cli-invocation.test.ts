/* eslint-disable camelcase */
import {expect} from 'chai'

import {CliInvocationSchema} from '../../../../../src/shared/analytics/events/cli-invocation.js'

const baseValid = {
  client_sent_at: 1_700_000_000_000,
  command_id: 'vc:add',
  flag_names: ['--detach'],
  is_ci: false,
  is_tty: true,
  package_manager: 'npm' as const,
  runtime: 'node' as const,
}

describe('CliInvocationSchema', () => {
  describe('valid payloads', () => {
    it('should accept all required fields without terminal_program', () => {
      expect(CliInvocationSchema.safeParse(baseValid).success).to.equal(true)
    })

    it('should accept terminal_program as a non-empty string', () => {
      expect(CliInvocationSchema.safeParse({...baseValid, terminal_program: 'iTerm.app'}).success).to.equal(true)
    })

    it('should accept empty flag_names array', () => {
      expect(CliInvocationSchema.safeParse({...baseValid, flag_names: []}).success).to.equal(true)
    })

    it('should accept runtime "bun"', () => {
      expect(CliInvocationSchema.safeParse({...baseValid, runtime: 'bun'}).success).to.equal(true)
    })

    it('should accept all package_manager values', () => {
      for (const pm of ['npm', 'yarn', 'pnpm', 'bun', 'unknown']) {
        expect(CliInvocationSchema.safeParse({...baseValid, package_manager: pm}).success).to.equal(true)
      }
    })
  })

  describe('invalid payloads', () => {
    it('should reject empty command_id', () => {
      expect(CliInvocationSchema.safeParse({...baseValid, command_id: ''}).success).to.equal(false)
    })

    it('should reject non-string command_id', () => {
      expect(CliInvocationSchema.safeParse({...baseValid, command_id: 42}).success).to.equal(false)
    })

    it('should reject non-array flag_names', () => {
      expect(CliInvocationSchema.safeParse({...baseValid, flag_names: 'oops'}).success).to.equal(false)
    })

    it('should reject non-boolean is_tty', () => {
      expect(CliInvocationSchema.safeParse({...baseValid, is_tty: 'yes'}).success).to.equal(false)
    })

    it('should reject non-boolean is_ci', () => {
      expect(CliInvocationSchema.safeParse({...baseValid, is_ci: 'no'}).success).to.equal(false)
    })

    it('should reject unknown runtime values', () => {
      expect(CliInvocationSchema.safeParse({...baseValid, runtime: 'deno'}).success).to.equal(false)
    })

    it('should reject unknown package_manager values', () => {
      expect(CliInvocationSchema.safeParse({...baseValid, package_manager: 'homebrew'}).success).to.equal(false)
    })

    it('should reject empty terminal_program when present', () => {
      expect(CliInvocationSchema.safeParse({...baseValid, terminal_program: ''}).success).to.equal(false)
    })

    it('should reject unknown extra fields (strict)', () => {
      expect(CliInvocationSchema.safeParse({...baseValid, sneaky: 'leak'}).success).to.equal(false)
    })

    it('should reject missing required fields', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {command_id: _, ...withoutCommandId} = baseValid
      expect(CliInvocationSchema.safeParse(withoutCommandId).success).to.equal(false)
    })
  })
})
