import {expect} from 'chai'

import {type SettingsRow} from '../../../../../src/shared/types/settings-row.js'
import {
  bottomHintFor,
  groupRowsByCategory,
  preFillBufferFor,
  validateSettingInput,
} from '../../../../../src/tui/features/settings/utils/format-settings.js'

function makeRow(overrides: Partial<SettingsRow> = {}): SettingsRow {
  return {
    category: 'concurrency',
    current: 10,
    default: 10,
    description: 'desc',
    displayCurrent: '10',
    displayDefault: '10',
    displayRange: '1-100',
    key: 'agentPool.maxSize',
    label: 'agentPool.maxSize',
    max: 100,
    min: 1,
    modified: false,
    restartRequired: true,
    type: 'integer',
    unit: 'count',
    ...overrides,
  }
}

describe('format-settings (tui)', () => {
  describe('groupRowsByCategory', () => {
    it('returns ordered [header, rows] groups skipping empty categories', () => {
      const groups = groupRowsByCategory([
        makeRow({category: 'concurrency', key: 'agentPool.maxSize'}),
        makeRow({category: 'llm', key: 'llm.iterationBudgetMs', unit: 'ms'}),
      ])
      expect(groups.map((g) => g.header)).to.deep.equal(['CONCURRENCY', 'LLM'])
      expect(groups[0].rows).to.have.lengthOf(1)
      expect(groups[1].rows).to.have.lengthOf(1)
    })

    it('renders an UPDATES header when an updates-category row is present (T5)', () => {
      const groups = groupRowsByCategory([
        makeRow({
          category: 'updates',
          current: true,
          default: true,
          displayCurrent: '[ on ]',
          displayDefault: '[ on ]',
          displayRange: '',
          key: 'update.checkForUpdates',
          label: 'update.checkForUpdates',
          restartRequired: false,
          type: 'boolean',
        }),
      ])
      expect(groups.map((g) => g.header)).to.deep.equal(['UPDATES'])
      expect(groups[0].rows[0].key).to.equal('update.checkForUpdates')
    })

    it('orders updates after task-history when both groups are present (T5)', () => {
      const groups = groupRowsByCategory([
        makeRow({
          category: 'updates',
          current: true,
          default: true,
          displayCurrent: '[ on ]',
          displayDefault: '[ on ]',
          displayRange: '',
          key: 'update.checkForUpdates',
          label: 'update.checkForUpdates',
          restartRequired: false,
          type: 'boolean',
        }),
        makeRow({category: 'task-history', key: 'taskHistory.maxEntries'}),
      ])
      expect(groups.map((g) => g.header)).to.deep.equal(['TASK HISTORY', 'UPDATES'])
    })
  })

  describe('bottomHintFor', () => {
    it('returns the browse hint without a key', () => {
      expect(bottomHintFor('browse')).to.equal('Up/Down move | Enter edit | R reset | Esc exit')
    })

    it('names the focused key in edit mode', () => {
      expect(bottomHintFor('edit', 'agentPool.maxSize')).to.equal(
        'Editing agentPool.maxSize | Enter save | Esc cancel',
      )
    })

    it('uses a distinct phrasing in edit-error mode', () => {
      const hint = bottomHintFor('edit-error', 'agentPool.maxSize')
      expect(hint).to.include('when valid')
      expect(hint).to.include('agentPool.maxSize')
    })

    it('mentions background resolution in saving mode', () => {
      const hint = bottomHintFor('saving')
      expect(hint).to.include('Saving')
      expect(hint).to.include('background')
    })
  })

  describe('preFillBufferFor', () => {
    it('pre-fills with the human duration for ms-unit rows', () => {
      const row = makeRow({current: 600_000, key: 'llm.iterationBudgetMs', unit: 'ms'})
      expect(preFillBufferFor(row)).to.equal('10m')
    })

    it('pre-fills with the raw integer (no commas) for count-unit rows', () => {
      const row = makeRow({current: 1000, key: 'taskHistory.maxEntries'})
      expect(preFillBufferFor(row)).to.equal('1000')
    })
  })

  describe('validateSettingInput', () => {
    const descriptor = {max: 100, min: 1}

    it('returns undefined for a valid integer within range', () => {
      expect(validateSettingInput('25', descriptor)).to.be.undefined
      expect(validateSettingInput('1', descriptor)).to.be.undefined
      expect(validateSettingInput('100', descriptor)).to.be.undefined
    })

    it('returns an error for empty input', () => {
      expect(validateSettingInput('   ', descriptor)).to.include('required')
    })

    it('returns an error for non-numeric input', () => {
      expect(validateSettingInput('abc', descriptor)).to.include('integer')
    })

    it('returns an error for a fractional number', () => {
      expect(validateSettingInput('1.5', descriptor)).to.include('integer')
    })

    it('returns an error naming the range when value is out of bounds', () => {
      const tooHigh = validateSettingInput('200', descriptor)
      const tooLow = validateSettingInput('0', descriptor)
      expect(tooHigh).to.include('100').and.to.include('range')
      expect(tooLow).to.include('1').and.to.include('range')
    })
  })
})
