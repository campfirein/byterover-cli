/**
 * HomePage
 *
 * Main app page for authenticated users with initialized projects.
 * Shows activity feed with logs and commands.
 */

import {Box} from 'ink'
import React, {useMemo, useState} from 'react'

import type {ActivityLog, CommandMessage} from '../../types/index.js'

import {ExpandedCommandView} from '../../components/command/index.js'
import {ExpandedLogView} from '../../components/execution/expanded-log-view.js'
import {CommandItem, List, LogItem, WelcomeBox} from '../../components/index.js'
import {
  useActivityLogs,
  useCommands,
  useFeedNavigation,
  useMode,
  useTerminalBreakpoint,
  useUIHeights,
} from '../../hooks/index.js'
import {MainLayout} from '../layouts/main-layout.js'

/**
 * Union type for activity feed items
 */
type ActivityFeedItem =
  | {data: ActivityLog; timestamp: Date; type: 'log'}
  | {data: CommandMessage; timestamp?: Date; type: 'command'}
  | {type: 'welcome'}

export function HomePage(): React.ReactNode {
  const {columns: terminalWidth, rows: terminalHeight} = useTerminalBreakpoint()
  const {footer, header, messageItem} = useUIHeights()
  const [expandedIndex, setExpandedIndex] = useState<null | number>(null)
  const {logs: logsMessages} = useActivityLogs()
  const {hasActiveDialog, messages: commandMessages} = useCommands()
  const {mode} = useMode()

  const isExpanded = expandedIndex !== null
  const contentHeight = Math.max(1, terminalHeight - header - footer)
  const inputHeight = isExpanded ? 0 : 3
  const listHeight = Math.max(1, contentHeight - inputHeight)

  // Build activity feed items
  const feedItems = useMemo(() => {
    const logItems: ActivityFeedItem[] = logsMessages.map((log) => ({
      data: log,
      timestamp: log.timestamp,
      type: 'log' as const,
    }))

    const commandItems: ActivityFeedItem[] = commandMessages.map((message) => ({
      data: message,
      timestamp: message.timestamp,
      type: 'command' as const,
    }))

    const sorted: ActivityFeedItem[] = [...logItems, ...commandItems].sort((a, b) => {
      if (a.type === 'welcome' || !a.timestamp) return 1
      if (b.type === 'welcome' || !b.timestamp) return -1
      return a.timestamp.getTime() - b.timestamp.getTime()
    })

    sorted.unshift({type: 'welcome'})

    return sorted
  }, [logsMessages, commandMessages])

  const {selectedIndex} = useFeedNavigation({
    expandedIndex,
    isActive: mode === 'main' && feedItems.length > 0 && expandedIndex === null && !hasActiveDialog,
    itemCount: feedItems.length,
    onExpandedIndexChange: setExpandedIndex,
  })

  // Get the expanded item based on expandedIndex
  const expandedItem = expandedIndex === null ? null : feedItems[expandedIndex]

  // Expanded log view
  if (expandedItem && expandedItem.type === 'log') {
    return (
      <MainLayout showInput={false}>
        <ExpandedLogView
          availableHeight={listHeight}
          isActive={mode === 'main'}
          log={expandedItem.data}
          onClose={() => setExpandedIndex(null)}
        />
      </MainLayout>
    )
  }

  // Expanded command view
  if (expandedItem && expandedItem.type === 'command') {
    return (
      <MainLayout showInput={false}>
        <ExpandedCommandView
          availableHeight={listHeight}
          isActive={mode === 'main'}
          message={expandedItem.data}
          onClose={() => setExpandedIndex(null)}
          terminalWidth={terminalWidth}
        />
      </MainLayout>
    )
  }

  // Activity feed list
  return (
    <MainLayout showInput={!isExpanded}>
      <List height={listHeight} selectedIndex={selectedIndex}>
        {feedItems.map((item, index) => {
          if (item.type === 'welcome') {
            if (hasActiveDialog) return null
            return (
              <Box key="welcome">
                <WelcomeBox />
              </Box>
            )
          }

          const key = (() => {
            const timestamp = item.timestamp?.getTime() ?? 0
            if (item.type === 'command') return `command-${item.data.fromCommand}-${timestamp}-${index}`
            return `log-${item.data.id}-${timestamp}-${index}`
          })()

          if (item.type === 'command') {
            return (
              <Box key={key}>
                <CommandItem
                  isLastMessage={index === feedItems.length - 1}
                  isSelected={selectedIndex === index}
                  message={item.data}
                  terminalWidth={terminalWidth}
                />
              </Box>
            )
          }

          return (
            <Box key={key}>
              <LogItem
                heights={{
                  ...messageItem,
                  maxContentLines: 2,
                }}
                isSelected={selectedIndex === index}
                log={item.data}
              />
            </Box>
          )
        })}
      </List>
    </MainLayout>
  )
}
