import {
  AGENT_LLM_ITERATION_BUDGET_MS,
  AGENT_LLM_REQUEST_TIMEOUT_MS,
  AGENT_MAX_CONCURRENT_TASKS,
  AGENT_POOL_MAX_SIZE,
  TASK_HISTORY_DEFAULT_MAX_ENTRIES,
  UPDATE_CHECK_FOR_UPDATES_DEFAULT,
} from '../../../constants.js'

/**
 * High-level concern the setting controls. Drives group headers in CLI
 * and TUI render output (uppercased). Web docs / WebUI consume this
 * field to render the same groupings independently of key naming.
 */
export type SettingCategory = 'concurrency' | 'llm' | 'task-history' | 'updates'

/**
 * Value-kind for dispatch between the duration formatter / parser
 * (`'ms'`) and the plain integer parser (`'count'`). Both surfaces and
 * the CLI `settings set` command route on this field; without it,
 * dispatch would require parsing the key suffix (`*Ms`), which breaks
 * the day a key doesn't follow that convention.
 */
export type SettingUnit = 'count' | 'ms'

/**
 * Fields shared by every descriptor regardless of value type. Specific
 * value-kind variants extend this with their own `default` shape and any
 * type-specific constraints (range for integers, etc).
 */
type BaseSettingDescriptor = {
  readonly category?: SettingCategory
  readonly description: string
  readonly key: string
  readonly restartRequired: boolean
}

export type IntegerSettingDescriptor = BaseSettingDescriptor & {
  readonly default: number
  readonly max: number
  readonly min: number
  readonly type: 'integer'
  readonly unit?: SettingUnit
}

export type BooleanSettingDescriptor = BaseSettingDescriptor & {
  readonly default: boolean
  readonly type: 'boolean'
}

/**
 * Descriptor for a single user-configurable setting. Discriminated on
 * `type` so consumers narrow with a single check before reading
 * type-specific fields (`min`/`max` on integers, etc).
 *
 * Defaults reference the existing constants module so a constant change
 * automatically updates the setting's default.
 */
export type SettingDescriptor = BooleanSettingDescriptor | IntegerSettingDescriptor

/**
 * View of one setting: the key, the user's current override (or the default
 * if none is set), and the registered default. Carries the union of value
 * shapes; consumers narrow on the corresponding descriptor's `type`.
 */
export type SettingItem = {
  readonly current: boolean | number
  readonly default: boolean | number
  readonly key: string
  readonly restartRequired: boolean
}

/**
 * Single source of truth for setting key names. Importers must reference
 * these constants instead of inline string literals so a rename of one
 * key is a typecheck error at every call site (validator, bootstrap,
 * agent snapshot read, CLI tests).
 */
export const SETTINGS_KEYS = {
  AGENT_POOL_MAX_CONCURRENT_TASKS: 'agentPool.maxConcurrentTasksPerProject',
  AGENT_POOL_MAX_SIZE: 'agentPool.maxSize',
  LLM_ITERATION_BUDGET_MS: 'llm.iterationBudgetMs',
  LLM_REQUEST_TIMEOUT_MS: 'llm.requestTimeoutMs',
  TASK_HISTORY_MAX_ENTRIES: 'taskHistory.maxEntries',
  UPDATE_CHECK_FOR_UPDATES: 'update.checkForUpdates',
} as const

export const SETTINGS_REGISTRY: readonly SettingDescriptor[] = [
  {
    category: 'concurrency',
    default: AGENT_POOL_MAX_SIZE,
    description: 'How many projects can be active at the same time',
    key: SETTINGS_KEYS.AGENT_POOL_MAX_SIZE,
    max: 100,
    min: 1,
    restartRequired: true,
    type: 'integer',
  },
  {
    category: 'concurrency',
    default: AGENT_MAX_CONCURRENT_TASKS,
    description: 'Max parallel curate/query tasks within a single project',
    key: SETTINGS_KEYS.AGENT_POOL_MAX_CONCURRENT_TASKS,
    max: 50,
    min: 1,
    restartRequired: true,
    type: 'integer',
  },
  {
    category: 'llm',
    default: AGENT_LLM_ITERATION_BUDGET_MS,
    description: 'Max wall-clock budget for one agentic loop, in milliseconds',
    key: SETTINGS_KEYS.LLM_ITERATION_BUDGET_MS,
    max: 3_600_000,
    min: 60_000,
    restartRequired: true,
    type: 'integer',
    unit: 'ms',
  },
  {
    category: 'llm',
    default: AGENT_LLM_REQUEST_TIMEOUT_MS,
    description: 'Max wait time per LLM response. Must be less than the agentic loop budget',
    key: SETTINGS_KEYS.LLM_REQUEST_TIMEOUT_MS,
    max: 3_600_000,
    min: 10_000,
    restartRequired: true,
    type: 'integer',
    unit: 'ms',
  },
  {
    category: 'task-history',
    default: TASK_HISTORY_DEFAULT_MAX_ENTRIES,
    description: 'Max task records `brv query-log view` retains per project',
    key: SETTINGS_KEYS.TASK_HISTORY_MAX_ENTRIES,
    max: 10_000,
    min: 10,
    restartRequired: true,
    type: 'integer',
  },
  {
    category: 'updates',
    default: UPDATE_CHECK_FOR_UPDATES_DEFAULT,
    description: 'Check for brv updates at startup and notify when one is available',
    key: SETTINGS_KEYS.UPDATE_CHECK_FOR_UPDATES,
    restartRequired: false,
    type: 'boolean',
  },
]

export function findSettingDescriptor(key: string): SettingDescriptor | undefined {
  return SETTINGS_REGISTRY.find((d) => d.key === key)
}
