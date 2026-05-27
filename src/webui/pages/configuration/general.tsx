import {ConcurrencyPanel} from '../../features/settings/components/concurrency-panel'
import {LlmPanel} from '../../features/settings/components/llm-panel'
import {NetworkPanel} from '../../features/settings/components/network-panel'
import {TaskHistoryPanel} from '../../features/settings/components/task-history-panel'
import {UpdatesPanel} from '../../features/settings/components/updates-panel'

export function GeneralSection() {
  return (
    <>
      <ConcurrencyPanel />
      <LlmPanel />
      <NetworkPanel />
      <TaskHistoryPanel />
      <UpdatesPanel />
    </>
  )
}
