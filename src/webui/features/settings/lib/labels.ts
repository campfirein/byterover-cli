const LABELS: Record<string, string> = {
  'agentPool.maxConcurrentTasksPerProject': 'Max parallel tasks per project',
  'agentPool.maxSize': 'Max concurrent projects',
  'llm.iterationBudgetMs': 'Agentic loop budget',
  'llm.requestTimeoutMs': 'LLM request timeout',
  'taskHistory.maxEntries': 'Task history size',
  'update.checkForUpdates': 'Check for updates at startup',
}

export function labelFor(key: string): string {
  return LABELS[key] ?? key
}
