import {ConcurrencyPanel} from '../../features/settings/components/concurrency-panel'
import {LlmPanel} from '../../features/settings/components/llm-panel'
import {TaskHistoryPanel} from '../../features/settings/components/task-history-panel'

export function GeneralSection() {
  return (
    <>
      <ConcurrencyPanel />
      <LlmPanel />
      <TaskHistoryPanel />
    </>
  )
}
