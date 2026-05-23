/**
 * CommandInput Component
 *
 * Handles command input with suggestions and executes slash commands.
 */

import {useQueryClient} from '@tanstack/react-query'
import {Box, Text, useInput} from 'ink'
import TextInput from 'ink-text-input'
import {ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react'

import type {CommandSideEffects} from '../types/commands.js'
import type {StreamingMessage} from '../types/index.js'

import {getAuthStateQueryOptions} from '../features/auth/api/get-auth-state.js'
import {useTasksStore} from '../features/tasks/stores/tasks-store.js'
import {useCommands, useMode, useTheme} from '../hooks/index.js'
import {useTransportStore} from '../stores/transport-store.js'
import {Suggestions} from './suggestions.js'

export const CommandInput = () => {
  const queryClient = useQueryClient()
  const client = useTransportStore((s) => s.client)
  const clearTasks = useTasksStore((s) => s.clearTasks)
  const {
    theme: {colors},
  } = useTheme()
  const {mode} = useMode()
  const {handleSlashCommand, isStreaming, setHasActiveDialog, setIsStreaming, setMessages, setStreamingMessages} =
    useCommands()
  const [inputValue, setInputValue] = useState('')
  const [inputKey, setInputKey] = useState(0)
  const [activeDialog, setActiveDialog] = useState<ReactNode>(null)
  const ctrlOPressedRef = useRef(false)
  const ctrlQPressedRef = useRef(false)
  const previousInputRef = useRef('')

  // Placeholder based on onboarding step
  const placeholder = useMemo(() => {
    if (isStreaming) return 'Processing...'
    return 'Type a command...'
  }, [isStreaming])

  // Filter out the chord-suffix character when Ctrl+O or Ctrl+Q is pressed:
  // ink-text-input receives the literal "o"/"q" alongside the modifier and
  // appends it before our useInput handler runs, so we strip it here.
  useEffect(() => {
    if (ctrlOPressedRef.current) {
      if (inputValue === previousInputRef.current + 'o') {
        setInputValue(previousInputRef.current)
      }

      ctrlOPressedRef.current = false
    }

    if (ctrlQPressedRef.current) {
      if (inputValue === previousInputRef.current + 'q') {
        setInputValue(previousInputRef.current)
      }

      ctrlQPressedRef.current = false
    }
  }, [inputValue])

  // Detect Ctrl+O / Ctrl+Q to prevent their letter from being inserted.
  // Ctrl+Q is the cancel-task chord; see useCancelRunningTaskKeybind.
  useInput((input, key) => {
    if (!key.ctrl) return
    if (input === 'o') {
      previousInputRef.current = inputValue
      ctrlOPressedRef.current = true
    } else if (input === 'q') {
      previousInputRef.current = inputValue
      ctrlQPressedRef.current = true
    }
  })

  // Cancel streaming command with Esc (only for commands that add to messages, not /curate or /query)
  useInput(
    (_input, key) => {
      if (key.escape) {
        // Add cancellation message to the latest command's output
        setMessages((prev) => {
          const updated = [...prev]
          const lastIndex = updated.length - 1
          // Only cancel if there's a command message
          if (lastIndex >= 0 && updated[lastIndex].type === 'command') {
            const cancelMsg: StreamingMessage = {
              content: 'Command cancelled.',
              id: `cancel-${Date.now()}`,
              type: 'output',
            }
            const existingOutput = updated[lastIndex].output ?? []
            updated[lastIndex] = {...updated[lastIndex], output: [...existingOutput, cancelMsg], timestamp: new Date()}
          }

          return updated
        })

        // Reset streaming state
        setStreamingMessages([])
        setIsStreaming(false)
        setHasActiveDialog(false)
      }
    },
    {isActive: isStreaming && !activeDialog},
  )

  const executeCommand = useCallback(
    async (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) return

      // Clear command input immediately
      setInputValue('')

      // Commands that create tasks (shown as ActivityLog) should not add command messages
      // to avoid duplicates in the activity feed
      const commandName = trimmed.startsWith('/') ? trimmed.slice(1).split(' ')[0] : ''
      const isTaskCommand = commandName === 'curate' || commandName === 'query' || commandName === 'q'

      if (!isTaskCommand) {
        setMessages((prev) => [
          ...prev,
          {
            content: '',
            fromCommand: trimmed.startsWith('/') ? trimmed.slice(1) : trimmed,
            type: 'command',
          },
        ])
      }

      const result = await handleSlashCommand(trimmed)

      if (result && 'type' in result && result.type === 'message') {
        setMessages((prev) => {
          const last = prev.at(-1)

          return [
            ...(last?.type === 'command' ? prev.slice(0, -1) : [...prev]),
            {
              content: result.content,
              fromCommand: trimmed.startsWith('/') ? trimmed.slice(1) : trimmed,
              timestamp: new Date(),
              type: result.messageType === 'error' ? 'error' : 'info',
            },
          ]
        })
      }

      if (result && 'render' in result) {
        setIsStreaming(true)
        setHasActiveDialog(true)

        const dialog = result.render({
          onCancel() {
            setActiveDialog(null)
            setIsStreaming(false)
            setHasActiveDialog(false)
          },
          async onComplete(message: string, sideEffects?: CommandSideEffects) {
            setActiveDialog(null)
            setIsStreaming(false)
            setHasActiveDialog(false)
            // Update command message with result (skip for task commands which don't add command messages)
            if (!isTaskCommand) {
              setMessages((prev) => {
                const updated = [...prev]
                const lastIndex = updated.length - 1
                if (lastIndex >= 0 && updated[lastIndex].type === 'command') {
                  const resultMsg: StreamingMessage = {
                    content: message,
                    id: `result-${Date.now()}`,
                    type: 'output',
                  }
                  const existingOutput = updated[lastIndex].output ?? []
                  updated[lastIndex] = {
                    ...updated[lastIndex],
                    output: [...existingOutput, resultMsg],
                    timestamp: new Date(),
                  }
                }

                return updated
              })
            }

            // Process side effects declared by the command
            if (sideEffects) {
              if (sideEffects.clearSession) {
                setMessages([])
                clearTasks()
                if (client) {
                  try {
                    await client.requestWithAck<{error?: string; sessionId?: string; success: boolean}>(
                      'agent:newSession',
                      {reason: 'User requested new session'},
                    )
                  } catch {
                    // Session creation error — command already showed feedback
                  }
                }
              }

              if (sideEffects.reloadAuth) {
                clearTasks()
                await queryClient.invalidateQueries({queryKey: getAuthStateQueryOptions().queryKey})
              }
            }
          },
        })

        setActiveDialog(dialog)
      }
    },
    [
      clearTasks,
      client,
      handleSlashCommand,
      queryClient,
      setHasActiveDialog,
      setIsStreaming,
      setMessages,
      setStreamingMessages,
    ],
  )

  const handleSubmit = useCallback(
    async (value: string) => {
      if (mode === 'main' && !isStreaming) {
        await executeCommand(value)
      }
    },
    [executeCommand, isStreaming, mode],
  )

  const handleSelect = useCallback(
    async (value: string) => {
      if (!isStreaming) await executeCommand(value)
    },
    [executeCommand, isStreaming],
  )

  const handleInsert = useCallback((value: string) => {
    const suffix = value.endsWith('/') ? '' : ' '
    setInputValue(value + suffix)
    setInputKey((prev) => prev + 1)
  }, [])

  // Hide suggestions during onboarding curate/query steps to focus user on the task
  const shouldShowSuggestions = !isStreaming

  return (
    <Box flexDirection="column" flexShrink={0}>
      {activeDialog}

      {shouldShowSuggestions && <Suggestions input={inputValue} onInsert={handleInsert} onSelect={handleSelect} />}

      <Box borderColor={colors.border} borderLeft={false} borderRight={false} borderStyle="single" paddingX={2}>
        <Text color={colors.primary}>{'> '}</Text>
        <TextInput
          focus={!activeDialog && (mode === 'main' || mode === 'suggestions')}
          key={inputKey}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          placeholder={placeholder}
          value={inputValue}
        />
      </Box>
    </Box>
  )
}
