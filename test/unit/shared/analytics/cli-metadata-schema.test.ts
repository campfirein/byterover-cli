/* eslint-disable camelcase */
import {expect} from 'chai'

import {
  CliMetadataSchema,
  CliRequestBaseSchema,
} from '../../../../src/shared/analytics/cli-metadata-schema.js'

const baseValid = {
  client_sent_at: 1_700_000_000_000,
  command_id: 'query',
  flag_names: ['format'],
  is_ci: false,
  is_tty: true,
  package_manager: 'npm' as const,
  runtime: 'node' as const,
}

describe('cli-metadata-schema', () => {
  describe('CliMetadataSchema', () => {
  describe('valid payloads', () => {
    it('accepts the 8-field shape without terminal_program', () => {
      expect(CliMetadataSchema.safeParse(baseValid).success).to.equal(true)
    })

    it('accepts terminal_program when set to a non-empty string', () => {
      expect(CliMetadataSchema.safeParse({...baseValid, terminal_program: 'iTerm.app'}).success).to.equal(true)
    })

    it('accepts empty flag_names array', () => {
      expect(CliMetadataSchema.safeParse({...baseValid, flag_names: []}).success).to.equal(true)
    })

    it('accepts each package_manager enum value', () => {
      for (const pm of ['npm', 'yarn', 'pnpm', 'bun', 'unknown'] as const) {
        expect(CliMetadataSchema.safeParse({...baseValid, package_manager: pm}).success).to.equal(true)
      }
    })

    it('accepts runtime "bun" and "node"', () => {
      for (const runtime of ['node', 'bun'] as const) {
        expect(CliMetadataSchema.safeParse({...baseValid, runtime}).success).to.equal(true)
      }
    })

    it('accepts client_sent_at = 0 (nonnegative integer)', () => {
      expect(CliMetadataSchema.safeParse({...baseValid, client_sent_at: 0}).success).to.equal(true)
    })
  })

  describe('invalid payloads', () => {
    it('rejects missing required fields', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {command_id: _omit, ...withoutCommandId} = baseValid
      expect(CliMetadataSchema.safeParse(withoutCommandId).success).to.equal(false)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {client_sent_at: _omit2, ...withoutTs} = baseValid
      expect(CliMetadataSchema.safeParse(withoutTs).success).to.equal(false)
    })

    it('rejects out-of-enum runtime / package_manager', () => {
      expect(CliMetadataSchema.safeParse({...baseValid, runtime: 'deno'}).success).to.equal(false)
      expect(CliMetadataSchema.safeParse({...baseValid, package_manager: 'brew'}).success).to.equal(false)
    })

    it('rejects empty command_id and empty terminal_program', () => {
      expect(CliMetadataSchema.safeParse({...baseValid, command_id: ''}).success).to.equal(false)
      expect(CliMetadataSchema.safeParse({...baseValid, terminal_program: ''}).success).to.equal(false)
    })

    it('rejects negative or non-integer client_sent_at', () => {
      expect(CliMetadataSchema.safeParse({...baseValid, client_sent_at: -1}).success).to.equal(false)
      expect(CliMetadataSchema.safeParse({...baseValid, client_sent_at: 1.5}).success).to.equal(false)
    })

    it('rejects unknown extra fields (strict)', () => {
      expect(CliMetadataSchema.safeParse({...baseValid, sneaky: 'leak'}).success).to.equal(false)
    })
  })
})

  describe('CliRequestBaseSchema', () => {
    it('accepts the empty payload (cli_metadata is optional)', () => {
      expect(CliRequestBaseSchema.safeParse({}).success).to.equal(true)
    })

    it('accepts a valid cli_metadata block', () => {
      expect(CliRequestBaseSchema.safeParse({cli_metadata: baseValid}).success).to.equal(true)
    })

    it('rejects a malformed cli_metadata block (inner strict-mode bubbles up)', () => {
      expect(
        CliRequestBaseSchema.safeParse({cli_metadata: {...baseValid, runtime: 'deno'}}).success,
      ).to.equal(false)
    })
  })
})
