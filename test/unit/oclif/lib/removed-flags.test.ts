import {expect} from 'chai'

import {
  argvRequestsJsonFormat,
  CURATE_REMOVED_FLAGS,
  DREAM_REMOVED_FLAGS,
  findRemovedFlagMessage,
  QUERY_REMOVED_FLAGS,
  type RemovedFlag,
} from '../../../../src/oclif/lib/removed-flags.js'

describe('removed-flags', () => {
  describe('findRemovedFlagMessage', () => {
    const removed: RemovedFlag[] = [{flags: ['--gone', '-g'], migration: 'Use the new way.'}]

    it('returns undefined when none of the removed flags appear', () => {
      expect(findRemovedFlagMessage(['--ok', 'value'], removed)).to.equal(undefined)
    })

    it('returns the migration text when the long flag appears', () => {
      expect(findRemovedFlagMessage(['--gone'], removed)).to.equal(
        "Flag '--gone' was removed in tool-mode. Use the new way.",
      )
    })

    it('returns the migration text when the short alias appears', () => {
      expect(findRemovedFlagMessage(['-g', 'x'], removed)).to.equal(
        "Flag '-g' was removed in tool-mode. Use the new way.",
      )
    })

    it('returns the migration text for --flag=value form', () => {
      expect(findRemovedFlagMessage(['--gone=oops'], removed)).to.equal(
        "Flag '--gone' was removed in tool-mode. Use the new way.",
      )
    })

    it('reports the first match and short-circuits', () => {
      const multi: RemovedFlag[] = [
        {flags: ['--first'], migration: 'first migration'},
        {flags: ['--second'], migration: 'second migration'},
      ]
      expect(findRemovedFlagMessage(['--second', '--first'], multi)).to.include('second migration')
    })

    it('stops scanning at the `--` terminator (positional content after the terminator is not scanned)', () => {
      expect(findRemovedFlagMessage(['--', '--gone'], removed)).to.equal(undefined)
    })

    it('still matches flags that appear BEFORE `--`', () => {
      expect(findRemovedFlagMessage(['--gone', '--', '--ignored'], removed)).to.include('Use the new way')
    })
  })

  describe('argvRequestsJsonFormat', () => {
    it('detects `--format json`', () => {
      expect(argvRequestsJsonFormat(['--format', 'json'])).to.equal(true)
    })

    it('detects `--format=json`', () => {
      expect(argvRequestsJsonFormat(['--format=json'])).to.equal(true)
    })

    it('returns false for `--format text`', () => {
      expect(argvRequestsJsonFormat(['--format', 'text'])).to.equal(false)
    })

    it('returns false when --format is absent', () => {
      expect(argvRequestsJsonFormat(['--limit', '5'])).to.equal(false)
    })

    it('stops at the `--` terminator (does not treat post-terminator tokens as flags)', () => {
      expect(argvRequestsJsonFormat(['--', '--format', 'json'])).to.equal(false)
    })
  })

  describe('CURATE_REMOVED_FLAGS', () => {
    it('covers --folder/-d, --files/-f, --detach, --timeout', () => {
      const tokens = CURATE_REMOVED_FLAGS.flatMap((r) => r.flags)
      expect(tokens).to.include.members(['--folder', '-d', '--files', '-f', '--detach', '--timeout'])
    })

    it('every entry has a non-empty migration sentence', () => {
      for (const r of CURATE_REMOVED_FLAGS) {
        expect(r.migration.length).to.be.greaterThan(10)
        expect(r.migration).to.match(/\.$/)
      }
    })
  })

  describe('QUERY_REMOVED_FLAGS', () => {
    it('covers --timeout', () => {
      const tokens = QUERY_REMOVED_FLAGS.flatMap((r) => r.flags)
      expect(tokens).to.include('--timeout')
    })
  })

  describe('DREAM_REMOVED_FLAGS', () => {
    it('covers --timeout', () => {
      const tokens = DREAM_REMOVED_FLAGS.flatMap((r) => r.flags)
      expect(tokens).to.include('--timeout')
    })

    it('every entry has a non-empty migration sentence', () => {
      for (const r of DREAM_REMOVED_FLAGS) {
        expect(r.migration.length).to.be.greaterThan(10)
        expect(r.migration).to.match(/\.$/)
      }
    })
  })
})
