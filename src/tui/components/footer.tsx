/**
 * Footer Component - Dynamic based on active tab
 */

import {Box, Spacer, Text} from 'ink'
import React from 'react'

import {useAppViewMode} from '../features/onboarding/hooks/use-app-view-mode.js'
import {selectCancelTargetTaskId} from '../features/tasks/hooks/select-cancel-target.js'
import {useTasksStore} from '../features/tasks/stores/tasks-store.js'
import {useMode, useTheme} from '../hooks/index.js'

export const Footer: React.FC = () => {
  const {shortcuts} = useMode()
  const viewMode = useAppViewMode()
  const {
    theme: {colors},
  } = useTheme()
  const taskStats = useTasksStore((s) => s.stats)
  // Mirrors the keybind in useCancelRunningTaskKeybind so the hint is visible
  // exactly when ctrl+q is armed — never advertised when nothing is cancellable.
  const hasCancellableTask = useTasksStore((s) => selectCancelTargetTaskId(s.tasks) !== undefined)

  if (viewMode.type === 'loading' || viewMode.type === 'config-provider') {
    return <Box height={1} paddingX={1} width="100%" />
  }

  return (
    <Box paddingX={1} width="100%">
      <Box flexShrink={0}>
        <Text color={colors.dimText}>~ in queue: </Text>
        <Text color={colors.warning}>{taskStats?.created ?? 0}</Text>
        <Text color={colors.dimText}> | running: </Text>
        <Text color={colors.primary}>{taskStats?.started ?? 0}</Text>
      </Box>
      <Spacer />
      {shortcuts.map((shortcut, index) => {
        // Inject the cancel-task hint after the first shortcut (navigate)
        // so the order reads `↑↓ navigate · ctrl+q cancel task · ctrl+c quit`.
        // The hint piggybacks on `selectCancelTargetTaskId`, so it appears
        // exactly while the keybind is armed and never advertises a no-op.
        const showCancelHintBefore = hasCancellableTask && index === 1
        return (
          <React.Fragment key={shortcut.key}>
            {showCancelHintBefore && (
              <Box>
                <Text color={colors.dimText}> • </Text>
                <Text color={colors.text}>ctrl+q</Text>
                <Text color={colors.dimText}> cancel task</Text>
              </Box>
            )}
            <Box>
              {index > 0 && <Text color={colors.dimText}> • </Text>}
              <Text color={colors.text}>{shortcut.key}</Text>
              <Text color={colors.dimText}> {shortcut.description}</Text>
            </Box>
          </React.Fragment>
        )
      })}
    </Box>
  )
}
