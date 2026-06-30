import {SETTINGS_KEYS} from '../../../../shared/types/settings-keys.js'

const LABELS: Record<string, string> = {
  [SETTINGS_KEYS.AGENT_POOL_MAX_CONCURRENT_TASKS]: 'Max parallel tasks per project',
  [SETTINGS_KEYS.AGENT_POOL_MAX_SIZE]: 'Max concurrent projects',
  [SETTINGS_KEYS.LANGUAGE_CODE]: 'Language',
  [SETTINGS_KEYS.LANGUAGE_MODE]: 'Language mode',
  [SETTINGS_KEYS.LLM_ITERATION_BUDGET_MS]: 'Agentic loop budget',
  [SETTINGS_KEYS.LLM_REQUEST_TIMEOUT_MS]: 'LLM request timeout',
  [SETTINGS_KEYS.TASK_HISTORY_MAX_ENTRIES]: 'Task history size',
  [SETTINGS_KEYS.UPDATE_CHECK_FOR_UPDATES]: 'Check for updates at startup',
}

export function labelFor(key: string): string {
  return LABELS[key] ?? key
}
