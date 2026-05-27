/**
 * Canonical user-configurable settings key registry.
 *
 * Lives in `shared/` so every consumer — server (`SETTINGS_REGISTRY`,
 * `FileSettingsStore`, `SettingsValidator`, `settings-bootstrap`), agent
 * (`cipher-agent`), oclif (`brv curate`), TUI / WebUI — can reference
 * one canonical constant. A rename here becomes a typecheck error at
 * every call site, preventing silent drift between the registry, the
 * persisted overrides file, and the UI surfaces.
 */
export const SETTINGS_KEYS = {
  AGENT_POOL_MAX_CONCURRENT_TASKS: 'agentPool.maxConcurrentTasksPerProject',
  AGENT_POOL_MAX_SIZE: 'agentPool.maxSize',
  LANGUAGE_CODE: 'language.code',
  LANGUAGE_MODE: 'language.mode',
  LLM_ITERATION_BUDGET_MS: 'llm.iterationBudgetMs',
  LLM_REQUEST_TIMEOUT_MS: 'llm.requestTimeoutMs',
  TASK_HISTORY_MAX_ENTRIES: 'taskHistory.maxEntries',
  UPDATE_CHECK_FOR_UPDATES: 'update.checkForUpdates',
} as const

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS]
