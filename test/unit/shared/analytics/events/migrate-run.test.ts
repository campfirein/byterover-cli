/* eslint-disable camelcase */
import {expect} from 'chai'

import {MigrateRunSchema} from '../../../../../src/shared/analytics/events/migrate-run.js'

const baseForwardSuccess = {
  archived: 1,
  dry_run: true,
  failed: 0,
  migrated: 2,
  mode: 'forward' as const,
  outcome: 'success' as const,
  skipped: 3,
}

const baseRollbackSuccess = {
  deleted_html: 2,
  dry_run: false,
  mode: 'rollback' as const,
  outcome: 'success' as const,
  preserved_html: 1,
  restored: 5,
}

describe('MigrateRunSchema', () => {
  describe('valid payloads', () => {
    it('accepts a forward success payload with all counts', () => {
      expect(MigrateRunSchema.safeParse(baseForwardSuccess).success).to.equal(true)
    })

    it('accepts a rollback success payload with all counts', () => {
      expect(MigrateRunSchema.safeParse(baseRollbackSuccess).success).to.equal(true)
    })

    it('accepts a forward failure payload with failure_kind and no counts', () => {
      const result = MigrateRunSchema.safeParse({
        dry_run: false,
        failure_kind: 'archive_exists',
        mode: 'forward',
        outcome: 'failure',
      })
      expect(result.success).to.equal(true)
    })

    it('accepts a rollback failure payload with failure_kind', () => {
      const result = MigrateRunSchema.safeParse({
        dry_run: true,
        failure_kind: 'no_archive',
        mode: 'rollback',
        outcome: 'failure',
      })
      expect(result.success).to.equal(true)
    })

    it('accepts a forward payload with all counts zeroed', () => {
      const result = MigrateRunSchema.safeParse({
        archived: 0,
        dry_run: false,
        failed: 0,
        migrated: 0,
        mode: 'forward',
        outcome: 'success',
        skipped: 0,
      })
      expect(result.success).to.equal(true)
    })

    it('accepts a rollback payload with all counts zeroed', () => {
      const result = MigrateRunSchema.safeParse({
        deleted_html: 0,
        dry_run: false,
        mode: 'rollback',
        outcome: 'success',
        preserved_html: 0,
        restored: 0,
      })
      expect(result.success).to.equal(true)
    })

    it('accepts a forward payload with only required fields', () => {
      const result = MigrateRunSchema.safeParse({
        dry_run: false,
        mode: 'forward',
        outcome: 'success',
      })
      expect(result.success).to.equal(true)
    })

    it('accepts a rollback payload with only required fields', () => {
      const result = MigrateRunSchema.safeParse({
        dry_run: false,
        mode: 'rollback',
        outcome: 'success',
      })
      expect(result.success).to.equal(true)
    })
  })

  describe('invalid payloads', () => {
    it('rejects missing required fields', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {mode: _mode, ...withoutMode} = baseForwardSuccess
      expect(MigrateRunSchema.safeParse(withoutMode).success).to.equal(false)

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {outcome: _outcome, ...withoutOutcome} = baseForwardSuccess
      expect(MigrateRunSchema.safeParse(withoutOutcome).success).to.equal(false)

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {dry_run: _dryRun, ...withoutDryRun} = baseForwardSuccess
      expect(MigrateRunSchema.safeParse(withoutDryRun).success).to.equal(false)
    })

    it('rejects out-of-enum mode', () => {
      expect(
        MigrateRunSchema.safeParse({...baseForwardSuccess, mode: 'sideways'}).success,
      ).to.equal(false)
    })

    it('rejects out-of-enum outcome', () => {
      expect(
        MigrateRunSchema.safeParse({...baseForwardSuccess, outcome: 'unknown'}).success,
      ).to.equal(false)
    })

    it('rejects non-boolean dry_run', () => {
      expect(
        MigrateRunSchema.safeParse({...baseForwardSuccess, dry_run: 'yes'}).success,
      ).to.equal(false)
    })

    it('rejects negative counts', () => {
      expect(
        MigrateRunSchema.safeParse({...baseForwardSuccess, migrated: -1}).success,
      ).to.equal(false)
      expect(
        MigrateRunSchema.safeParse({...baseRollbackSuccess, restored: -1}).success,
      ).to.equal(false)
    })

    it('rejects non-integer counts', () => {
      expect(
        MigrateRunSchema.safeParse({...baseForwardSuccess, archived: 1.5}).success,
      ).to.equal(false)
      expect(
        MigrateRunSchema.safeParse({...baseRollbackSuccess, deleted_html: 0.5}).success,
      ).to.equal(false)
    })

    it('rejects empty failure_kind', () => {
      expect(
        MigrateRunSchema.safeParse({
          dry_run: false,
          failure_kind: '',
          mode: 'forward',
          outcome: 'failure',
        }).success,
      ).to.equal(false)
    })

    it('rejects unknown extra fields (strict)', () => {
      expect(
        MigrateRunSchema.safeParse({...baseForwardSuccess, mystery_field: 'oops'}).success,
      ).to.equal(false)
    })

    it('rejects forward payload carrying rollback-only counters', () => {
      // Discriminated-union guarantee: per-mode counter fields stay segregated.
      expect(
        MigrateRunSchema.safeParse({...baseForwardSuccess, deleted_html: 1}).success,
      ).to.equal(false)
      expect(
        MigrateRunSchema.safeParse({...baseForwardSuccess, preserved_html: 1}).success,
      ).to.equal(false)
      expect(
        MigrateRunSchema.safeParse({...baseForwardSuccess, restored: 1}).success,
      ).to.equal(false)
    })

    it('rejects rollback payload carrying forward-only counters', () => {
      expect(
        MigrateRunSchema.safeParse({...baseRollbackSuccess, migrated: 1}).success,
      ).to.equal(false)
      expect(
        MigrateRunSchema.safeParse({...baseRollbackSuccess, archived: 1}).success,
      ).to.equal(false)
      expect(
        MigrateRunSchema.safeParse({...baseRollbackSuccess, skipped: 1}).success,
      ).to.equal(false)
      expect(
        MigrateRunSchema.safeParse({...baseRollbackSuccess, failed: 1}).success,
      ).to.equal(false)
    })
  })
})
