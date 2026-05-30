import {ChevronsRight} from 'lucide-react'

import {MigrateContextTreeButton} from '../../migrate/components/migrate-context-tree-button'
import {useContextLayout} from '../hooks/use-context-layout'
import {useContextTree} from '../hooks/use-context-tree'
import {isFilePath} from '../utils/tree-utils'
import {ContextDetailPanel} from './context-detail-panel'
import {ContextHistoryPanel} from './context-history-panel'
import {ContextTreePanel} from './context-tree-panel'

export function ContextLayout() {
  const {closeRightPanel, isLeftPanelOpen, isRightPanelOpen, toggleLeftPanel, toggleRightPanel} = useContextLayout()
  const {selectedPath} = useContextTree()

  const showHistoryPanel = isRightPanelOpen && isFilePath(selectedPath)

  return (
    <div className="flex h-full gap-4">
      {/* Left panel: tree navigation */}
      {isLeftPanelOpen ? (
        <div className="flex w-72 shrink-0 flex-col gap-2 overflow-y-auto">
          <MigrateContextTreeButton />
          <ContextTreePanel onCollapse={toggleLeftPanel} />
        </div>
      ) : (
        <div className="bg-card flex shrink-0 items-start rounded-xl p-2">
          <button
            className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center rounded p-1 transition-colors hover:bg-neutral-800"
            onClick={toggleLeftPanel}
            type="button"
          >
            <ChevronsRight className="size-5" />
          </button>
        </div>
      )}

      {/* Center panel: detail view */}
      <div className="bg-card flex min-w-0 flex-1 rounded-xl">
        <ContextDetailPanel onToggleHistory={toggleRightPanel} />
      </div>

      {/* Right panel: history */}
      {showHistoryPanel && (
        <div className="w-80 shrink-0 overflow-y-auto">
          <ContextHistoryPanel onClose={closeRightPanel} />
        </div>
      )}
    </div>
  )
}
