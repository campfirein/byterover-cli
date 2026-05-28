import {Box, Text, useInput} from 'ink'
import Spinner from 'ink-spinner'
import React, {useCallback, useMemo, useState} from 'react'

import type {SettingsRow} from '../../../../shared/types/settings-row.js'
import type {CustomDialogCallbacks} from '../../../types/commands.js'

import {buildSettingsRows, parseRowInput} from '../../../../shared/utils/format-settings.js'
import {loadAnalyticsDisclosureText} from '../../../../shared/utils/load-analytics-disclosure.js'
import {useTheme} from '../../../hooks/index.js'
import {useGetSettings, useResetSetting, useSetSetting} from '../api/settings-api.js'
import {bottomHintFor, groupRowsByCategory, preFillBufferFor} from '../utils/format-settings.js'

type Mode = 'browse' | 'confirm-disclosure' | 'edit' | 'saving'

// Hardcoded to avoid the `tui/` -> `server/` boundary violation that
// would happen if we imported SETTINGS_KEYS. The string is a stable
// contract — a rename would require a config-migration ticket regardless.
const ANALYTICS_ENABLED_KEY = 'analytics.enabled'

export function SettingsPage({onCancel, onComplete}: CustomDialogCallbacks): React.ReactNode {
  const {data, error, isLoading} = useGetSettings()
  const setMutation = useSetSetting()
  const resetMutation = useResetSetting()
  const {
    theme: {colors},
  } = useTheme()

  const [cursor, setCursor] = useState(0)
  const [mode, setMode] = useState<Mode>('browse')
  const [editBuffer, setEditBuffer] = useState('')
  const [rowError, setRowError] = useState<string | undefined>()
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(new Set())
  const [disclosureText, setDisclosureText] = useState<string | undefined>()
  const [pendingDisclosureRow, setPendingDisclosureRow] = useState<SettingsRow | undefined>()

  const rows = useMemo<SettingsRow[]>(() => (data ? buildSettingsRows(data.items) : []), [data])
  const groups = useMemo(() => groupRowsByCategory(rows), [rows])
  const focusedRow = rows[cursor]
  // `hintMode` only feeds the bottom hint on the row-list render. The
  // `confirm-disclosure` mode short-circuits that render entirely (its
  // own hint is inlined below), so it never reaches `bottomHintFor`.
  const hintMode: 'browse' | 'edit' | 'edit-error' | 'saving' =
    mode === 'confirm-disclosure'
      ? 'browse'
      : mode === 'edit' && rowError !== undefined
        ? 'edit-error'
        : mode

  // Restart warning fires only when at least one dirty key actually
  // requires a daemon restart. Boolean toggles (e.g. update.checkForUpdates,
  // restartRequired: false) must not produce a misleading prompt.
  const restartRequiredDirty = useMemo(() => {
    const filtered = new Set<string>()
    for (const dirtyKey of dirtyKeys) {
      const row = rows.find((r) => r.key === dirtyKey)
      if (row?.restartRequired === true) filtered.add(dirtyKey)
    }

    return filtered
  }, [dirtyKeys, rows])

  const enterEdit = useCallback((row: SettingsRow) => {
    setEditBuffer(preFillBufferFor(row))
    setRowError(undefined)
    setMode('edit')
  }, [])

  const commitEdit = useCallback(
    async (row: SettingsRow, raw: string) => {
      const parsed = parseRowInput(row, raw)
      if (parsed.kind === 'error') {
        setRowError(parsed.message)
        return
      }

      setMode('saving')
      setRowError(undefined)
      const response = await setMutation.mutateAsync({key: row.key, value: parsed.value})
      if (response.ok) {
        setDirtyKeys((previous) => {
          const next = new Set(previous)
          next.add(row.key)
          return next
        })
        setMode('browse')
        return
      }

      setRowError(response.error.message)
      setMode('edit')
    },
    [setMutation],
  )

  const resetRow = useCallback(
    async (row: SettingsRow) => {
      setMode('saving')
      setRowError(undefined)
      const response = await resetMutation.mutateAsync({key: row.key})
      if (response.ok) {
        setDirtyKeys((previous) => {
          const next = new Set(previous)
          next.add(row.key)
          return next
        })
        setMode('browse')
        return
      }

      setRowError(response.error.message)
      setMode('browse')
    },
    [resetMutation],
  )

  const performToggle = useCallback(
    async (row: SettingsRow, nextValue: boolean) => {
      setMode('saving')
      setRowError(undefined)
      const response = await setMutation.mutateAsync({key: row.key, value: nextValue})
      if (response.ok) {
        setDirtyKeys((previous) => {
          const next = new Set(previous)
          next.add(row.key)
          return next
        })
        setMode('browse')
        return
      }

      setRowError(response.error.message)
      setMode('browse')
    },
    [setMutation],
  )

  const toggleBoolean = useCallback(
    async (row: SettingsRow) => {
      if (row.type !== 'boolean' || typeof row.current !== 'boolean') return

      // analytics.enabled false -> true requires the disclosure consent
      // prompt. Load the markdown and switch into the confirm-disclosure
      // mode; the user must press Enter to accept (which fires the actual
      // SET) or Esc to cancel.
      if (row.key === ANALYTICS_ENABLED_KEY && row.current === false) {
        setRowError(undefined)
        setPendingDisclosureRow(row)
        try {
          const text = await loadAnalyticsDisclosureText()
          setDisclosureText(text)
          setMode('confirm-disclosure')
        } catch (error) {
          setRowError(error instanceof Error ? error.message : String(error))
          setPendingDisclosureRow(undefined)
        }

        return
      }

      await performToggle(row, !row.current)
    },
    [performToggle],
  )

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel()
        return
      }

      if (rows.length === 0) return

      if (key.upArrow) {
        setCursor((c) => (c <= 0 ? rows.length - 1 : c - 1))
        setRowError(undefined)
        return
      }

      if (key.downArrow) {
        setCursor((c) => (c >= rows.length - 1 ? 0 : c + 1))
        setRowError(undefined)
        return
      }

      if (key.return || input === ' ') {
        const row = rows[cursor]
        if (row.type === 'readonly-info') {
          // Read-only rows refuse every mutation keybind: no toggle, no
          // edit, no reset. Selection still works (Up/Down navigate).
          return
        }

        if (row.type === 'boolean') {
          toggleBoolean(row).catch(() => {})
        } else {
          enterEdit(row)
        }

        return
      }

      if (input?.toLowerCase() === 'r') {
        const row = rows[cursor]
        if (row.type === 'readonly-info') return
        resetRow(row).catch(() => {})
      }
    },
    {isActive: mode === 'browse'},
  )

  useInput(
    (input, key) => {
      if (key.escape) {
        setMode('browse')
        setRowError(undefined)
        return
      }

      if (key.return) {
        commitEdit(rows[cursor], editBuffer).catch(() => {})
        return
      }

      if (key.backspace || key.delete) {
        setEditBuffer((previous) => previous.slice(0, -1))
        return
      }

      if (input && !key.ctrl && !key.meta) {
        setEditBuffer((previous) => previous + input)
      }
    },
    {isActive: mode === 'edit'},
  )

  // Esc must always exit, including while a save is in flight. The
  // in-flight mutation will resolve in the background; the page just
  // closes so the user is never trapped waiting on a hung daemon.
  useInput(
    (_input, key) => {
      if (key.escape) onCancel()
    },
    {isActive: mode === 'saving'},
  )

  // Disclosure confirm: Enter accepts and flips the flag, Esc cancels
  // without flipping. Up/Down do nothing — the disclosure is a single
  // modal-ish overlay; navigation resumes after the choice.
  useInput(
    (_input, key) => {
      if (key.escape) {
        setMode('browse')
        setPendingDisclosureRow(undefined)
        return
      }

      if (key.return) {
        const row = pendingDisclosureRow
        setPendingDisclosureRow(undefined)
        if (row !== undefined) performToggle(row, true).catch(() => {})
      }
    },
    {isActive: mode === 'confirm-disclosure'},
  )

  React.useEffect(() => {
    if (error) {
      onComplete(`Failed to load settings: ${error.message}`)
    }
  }, [error, onComplete])

  if (isLoading || !data) {
    return (
      <Text>
        <Spinner type="dots" /> Loading settings...
      </Text>
    )
  }

  // Disclosure overlay. Renders the full markdown text + prompt; the
  // surrounding row list is hidden so the user focuses on the
  // disclosure. Enter confirms, Esc cancels.
  if (mode === 'confirm-disclosure') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text>ANALYTICS DISCLOSURE</Text>
        </Box>
        {disclosureText === undefined ? (
          <Text>
            <Spinner type="dots" /> Loading disclosure...
          </Text>
        ) : (
          <Box flexDirection="column">
            <Text>{disclosureText}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={colors.primary}>Enter: enable analytics | Esc: cancel</Text>
        </Box>
      </Box>
    )
  }

  const keyWidth = Math.max(40, ...rows.map((r) => r.label.length))
  const currentWidth = Math.max(7, ...rows.map((r) => r.displayCurrent.length))
  const defaultWidth = Math.max(8, ...rows.map((r) => (r.displayDefault ?? '').length))
  const rangeWidth = Math.max(8, ...rows.map((r) => r.displayRange.length))

  return (
    <Box flexDirection="column">
      {restartRequiredDirty.size > 0 && (
        <Box marginBottom={1}>
          <Text color={colors.warning}>Settings changed. Run `brv restart` to apply.</Text>
        </Box>
      )}

      <Box marginBottom={1}>
        <Text>SETTINGS</Text>
        <Text>{'    '}</Text>
        <Text>{restartRequiredDirty.size > 0 ? 'scope: global - `brv restart` to apply' : 'scope: global'}</Text>
      </Box>

      {groups.map((group) => (
        <Box flexDirection="column" key={group.category} marginBottom={1}>
          <Text>{group.header}</Text>
          {group.rows.map((row) => {
            const isSelected = rows[cursor]?.key === row.key
            const marker = isSelected ? '> ' : '  '
            const isEditingThis = isSelected && mode === 'edit'
            const isSavingThis = isSelected && mode === 'saving'
            const currentDisplay = renderCurrentCell(row, {
              editBuffer,
              isEditingThis,
              isSavingThis,
              width: currentWidth,
            })
            const trailingCell = row.type === 'readonly-info'
              ? pad('(read-only)', defaultWidth + 10)
              : `${pad(`(default ${row.displayDefault ?? ''})`, defaultWidth + 10)}  ${pad(row.displayRange, rangeWidth)}`
            return (
              <Box flexDirection="column" key={row.key}>
                <Text color={isSelected ? colors.primary : undefined}>
                  {marker}
                  {pad(row.label, keyWidth)}  {currentDisplay}  {trailingCell}
                </Text>
                {isSelected && rowError !== undefined && (
                  <Box marginLeft={2}>
                    <Text color={colors.errorText}>{rowError}</Text>
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
      ))}

      <Box marginTop={1}>
        <Text>{bottomHintFor(hintMode, focusedRow?.key, focusedRow?.type)}</Text>
      </Box>
    </Box>
  )
}

function renderCurrentCell(
  row: SettingsRow,
  state: {readonly editBuffer: string; readonly isEditingThis: boolean; readonly isSavingThis: boolean; readonly width: number},
): string {
  if (state.isEditingThis) {
    return `${row.displayCurrent} -> [${state.editBuffer}_]`
  }

  if (state.isSavingThis) {
    return `${row.displayCurrent} -> [${state.editBuffer}] saving...`
  }

  return pad(row.displayCurrent, state.width)
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}
