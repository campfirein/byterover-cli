import {useEffect, useState} from 'react'

import {useTransportStore} from '../../../stores/transport-store'
import {useCheckMigrationNeeded} from '../api/check-migration-needed'
import {dismissMigrationPrompt, isMigrationPromptDismissed} from '../hooks/migration-dismissal'
import {useMigrationDialogStore} from '../stores/migration-dialog-store'
import {MigrationDialog} from './migration-dialog'

export function MigrationPrompt() {
  const selectedProject = useTransportStore((s) => s.selectedProject)
  const isConnected = useTransportStore((s) => s.isConnected)
  const forceOpen = useMigrationDialogStore((s) => s.forceOpen)
  const setForceOpen = useMigrationDialogStore((s) => s.setForceOpen)

  const [dismissed, setDismissed] = useState(false)
  const [closed, setClosed] = useState(false)

  // Re-evaluate dismissal whenever the active project changes.
  useEffect(() => {
    setClosed(false)
    if (!selectedProject) {
      setDismissed(false)
      return
    }

    setDismissed(isMigrationPromptDismissed(selectedProject))
  }, [selectedProject])

  const connected = Boolean(selectedProject) && isConnected
  // The dialog opens either automatically (first detection) or via the
  // Context-tab "Migrate" button. Both paths still gate on `closed` so
  // success / failure states stay closed after the user clicks Done.
  const shouldOpen = connected && !closed && (forceOpen || !dismissed)

  const {data} = useCheckMigrationNeeded({
    projectRoot: shouldOpen ? selectedProject : undefined,
  })

  if (!shouldOpen || !data?.needed) return null

  const handleDismiss = () => {
    if (selectedProject) dismissMigrationPrompt(selectedProject)
    setDismissed(true)
    setForceOpen(false)
  }

  const handleClose = () => {
    setClosed(true)
    setForceOpen(false)
  }

  return (
    <MigrationDialog migratedCount={data.migratedCount} onClose={handleClose} onDismiss={handleDismiss} open />
  )
}
