import {expect} from 'chai'

import type {SettingsItemDTO} from '../../../../src/shared/transport/events/settings-events.js'
import type {SettingsRow} from '../../../../src/shared/types/settings-row.js'

import {buildSettingsRows, parseRowInput} from '../../../../src/shared/utils/format-settings.js'

function makeItem(overrides: Partial<SettingsItemDTO> = {}): SettingsItemDTO {
  return {
    category: 'concurrency',
    current: 10,
    default: 10,
    description: 'desc',
    key: 'agentPool.maxSize',
    max: 100,
    min: 1,
    restartRequired: true,
    type: 'integer',
    ...overrides,
  }
}

function makeBooleanItem(current: boolean): SettingsItemDTO {
  return {
    category: 'updates',
    current,
    default: true,
    description: 'Check for brv updates at startup and notify when one is available',
    key: 'update.checkForUpdates',
    restartRequired: false,
    type: 'boolean',
  }
}

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

describe('format-settings (shared)', () => {
  describe('buildSettingsRows', () => {
    it('preserves registry order within a category and formats display columns per unit', () => {
      const rows = buildSettingsRows([
        makeItem({current: 25, key: 'agentPool.maxSize'}),
        makeItem({category: 'task-history', current: 1000, default: 1000, key: 'taskHistory.maxEntries', max: 10_000, min: 10}),
      ])

      expect(rows.map((r) => r.key)).to.deep.equal(['agentPool.maxSize', 'taskHistory.maxEntries'])
      expect(rows[0].displayCurrent).to.equal('25')
      expect(rows[0].displayDefault).to.equal('10')
      expect(rows[1].displayCurrent).to.equal('1,000')
    })

    it('renders ms-unit rows in human duration form', () => {
      const rows = buildSettingsRows([
        makeItem({
          category: 'llm',
          current: 1_800_000,
          default: 600_000,
          key: 'llm.iterationBudgetMs',
          max: 3_600_000,
          min: 60_000,
          unit: 'ms',
        }),
      ])

      expect(rows[0].displayCurrent).to.equal('30m')
      expect(rows[0].displayDefault).to.equal('10m')
      expect(rows[0].displayRange).to.equal('1m-1h')
    })

    it('marks a row as modified when current differs from default', () => {
      const rows = buildSettingsRows([
        makeItem({current: 25, default: 10}),
        makeItem({current: 5, default: 5, key: 'agentPool.maxConcurrentTasksPerProject'}),
      ])
      expect(rows[0].modified).to.equal(true)
      expect(rows[1].modified).to.equal(false)
    })

    it('orders categories as CONCURRENCY -> LLM -> TASK HISTORY regardless of input order', () => {
      const rows = buildSettingsRows([
        makeItem({category: 'task-history', key: 'taskHistory.maxEntries'}),
        makeItem({category: 'llm', key: 'llm.iterationBudgetMs', unit: 'ms'}),
        makeItem({category: 'concurrency', key: 'agentPool.maxSize'}),
      ])
      expect(rows.map((r) => r.category)).to.deep.equal(['concurrency', 'llm', 'task-history'])
    })

    it('appends the coupling hint to llm.requestTimeoutMs range', () => {
      const rows = buildSettingsRows([
        makeItem({category: 'llm', key: 'llm.requestTimeoutMs', max: 3_600_000, min: 10_000, unit: 'ms'}),
      ])
      expect(rows[0].displayRange).to.include('max loop budget')
    })

    it('falls back to category=other when the DTO omits category', () => {
      const item = makeItem({key: 'foo.bar'})
      const nakedItem = {
        current: item.current,
        default: item.default,
        description: item.description,
        key: item.key,
        max: item.max,
        min: item.min,
        restartRequired: item.restartRequired,
        type: item.type,
      } as SettingsItemDTO
      const rows = buildSettingsRows([nakedItem])
      expect(rows[0].category).to.equal('other')
      expect(rows[0].unit).to.equal('count')
    })
  })

  describe('parseRowInput', () => {
    it('count: accepts integer input within range and returns the formatted display value', () => {
      const row = makeRow()
      const result = parseRowInput(row, '25')
      expect(result.kind).to.equal('ok')
      if (result.kind === 'ok') {
        expect(result.value).to.equal(25)
        expect(result.displayValue).to.equal('25')
      }
    })

    it('count: rejects out-of-range with "out of range: max <N>"', () => {
      const row = makeRow({max: 100})
      const result = parseRowInput(row, '150')
      expect(result.kind).to.equal('error')
      if (result.kind === 'error') {
        expect(result.message).to.match(/out of range: max 100/)
      }
    })

    it('count: rejects a duration-shaped string with a unit-mismatch message', () => {
      const row = makeRow({key: 'agentPool.maxSize'})
      const result = parseRowInput(row, '30m')
      expect(result.kind).to.equal('error')
      if (result.kind === 'error') {
        expect(result.message).to.include('expects an integer count')
      }
    })

    it('ms: parses "30m" -> 1_800_000 and surfaces the human display for echo', () => {
      const row = makeRow({key: 'llm.iterationBudgetMs', max: 3_600_000, min: 60_000, unit: 'ms'})
      const result = parseRowInput(row, '30m')
      expect(result.kind).to.equal('ok')
      if (result.kind === 'ok') {
        expect(result.value).to.equal(1_800_000)
        expect(result.displayValue).to.equal('30m')
      }
    })

    it('ms: rejects out-of-range (below min) using the duration form in the message', () => {
      const row = makeRow({key: 'llm.iterationBudgetMs', max: 3_600_000, min: 60_000, unit: 'ms'})
      const result = parseRowInput(row, '30s')
      expect(result.kind).to.equal('error')
      if (result.kind === 'error') {
        expect(result.message).to.match(/30s/)
        expect(result.message).to.match(/outside allowed range/)
      }
    })

    it('ms: rejects an unknown-unit input with the parser hint', () => {
      const row = makeRow({key: 'llm.iterationBudgetMs', max: 3_600_000, min: 60_000, unit: 'ms'})
      const result = parseRowInput(row, '10x')
      expect(result.kind).to.equal('error')
      if (result.kind === 'error') {
        expect(result.message).to.match(/try 30m, 1h, 1h 30m, or a raw ms integer/)
      }
    })

    it('rejects empty input on either unit', () => {
      const row = makeRow()
      expect(parseRowInput(row, '').kind).to.equal('error')
      expect(parseRowInput(row, '   ').kind).to.equal('error')
    })
  })

  describe('boolean rows (T5)', () => {
    it('includes boolean items in the output (no longer filtered)', () => {
      const rows = buildSettingsRows([makeBooleanItem(true)])
      expect(rows).to.have.lengthOf(1)
      expect(rows[0].key).to.equal('update.checkForUpdates')
    })

    it('formats current=true as "[ on ]" and current=false as "[ off ]"', () => {
      const onRow = buildSettingsRows([makeBooleanItem(true)])[0]
      const offRow = buildSettingsRows([makeBooleanItem(false)])[0]
      expect(onRow.displayCurrent).to.equal('[ on ]')
      expect(offRow.displayCurrent).to.equal('[ off ]')
    })

    it('formats default=true the same way as current', () => {
      const row = buildSettingsRows([makeBooleanItem(false)])[0]
      expect(row.displayDefault).to.equal('[ on ]')
    })

    it('emits an empty displayRange for boolean rows (no min/max to render)', () => {
      const row = buildSettingsRows([makeBooleanItem(true)])[0]
      expect(row.displayRange).to.equal('')
    })

    it('preserves the "updates" category on the row', () => {
      const row = buildSettingsRows([makeBooleanItem(true)])[0]
      expect(row.category).to.equal('updates')
    })

    it('marks the row as modified when current differs from default', () => {
      // current=false but default=true (per the helper) -> dirty
      const row = buildSettingsRows([makeBooleanItem(false)])[0]
      expect(row.modified).to.equal(true)
    })

    it('propagates restartRequired=false from the DTO onto the row', () => {
      const row = buildSettingsRows([makeBooleanItem(true)])[0]
      expect(row.restartRequired).to.equal(false)
    })

    it('keeps integer rows working when mixed with boolean rows', () => {
      const rows = buildSettingsRows([
        makeItem({current: 25, key: 'agentPool.maxSize'}),
        makeBooleanItem(true),
      ])
      expect(rows.map((r) => r.key)).to.have.members(['agentPool.maxSize', 'update.checkForUpdates'])
      const integerRow = rows.find((r) => r.key === 'agentPool.maxSize')
      expect(integerRow?.displayCurrent).to.equal('25')
      expect(integerRow?.displayRange).to.equal('1-100')
    })

    it('orders the updates category after task-history', () => {
      const rows = buildSettingsRows([
        makeBooleanItem(true),
        makeItem({category: 'task-history', key: 'taskHistory.maxEntries'}),
        makeItem({category: 'concurrency', key: 'agentPool.maxSize'}),
      ])
      expect(rows.map((r) => r.category)).to.deep.equal(['concurrency', 'task-history', 'updates'])
    })
  })
})
