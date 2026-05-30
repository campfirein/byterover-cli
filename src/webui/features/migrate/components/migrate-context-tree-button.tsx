import {Button} from '@campfirein/byterover-packages/components/button'
import {ArrowUpRight} from 'lucide-react'

import {useTransportStore} from '../../../stores/transport-store'
import {useCheckMigrationNeeded} from '../api/check-migration-needed'
import {useMigrationDialogStore} from '../stores/migration-dialog-store'

export function MigrateContextTreeButton() {
  const selectedProject = useTransportStore((s) => s.selectedProject)
  const isConnected = useTransportStore((s) => s.isConnected)
  const setForceOpen = useMigrationDialogStore((s) => s.setForceOpen)

  const {data} = useCheckMigrationNeeded({
    projectRoot: selectedProject && isConnected ? selectedProject : undefined,
  })

  if (!data?.needed) return null

  return (
    <Button className="w-full justify-start gap-1.5" onClick={() => setForceOpen(true)} variant="outline">
      <ArrowUpRight className="size-3.5" />
      Migrate {data.migratedCount} topic{data.migratedCount === 1 ? '' : 's'} to HTML
    </Button>
  )
}
