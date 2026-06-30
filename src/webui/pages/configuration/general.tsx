import {ConcurrencyPanel} from '../../features/settings/components/concurrency-panel'
import {LanguagePanel} from '../../features/settings/components/language-panel'
import {LlmPanel} from '../../features/settings/components/llm-panel'
import {TaskHistoryPanel} from '../../features/settings/components/task-history-panel'
import {UpdatesPanel} from '../../features/settings/components/updates-panel'

export function GeneralSection() {
  return (
    <>
      <ConcurrencyPanel />
      <LlmPanel />
      <TaskHistoryPanel />
      <LanguagePanel />
      <UpdatesPanel />
    </>
  )
}
