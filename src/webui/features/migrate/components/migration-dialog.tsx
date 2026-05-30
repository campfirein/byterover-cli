import {Button} from '@campfirein/byterover-packages/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@campfirein/byterover-packages/components/dialog'
import {useState} from 'react'
import {useNavigate} from 'react-router-dom'
import {toast} from 'sonner'

import type {MigrateRunReport} from '../../../../shared/transport/events/migrate-events'

import {formatError} from '../../../lib/error-messages'
import {useRunMigration} from '../api/run-migration'

type MigrationDialogProps = {
  migratedCount: number
  onClose: () => void
  onDismiss: () => void
  open: boolean
}

export function MigrationDialog({migratedCount, onClose, onDismiss, open}: MigrationDialogProps) {
  const run = useRunMigration()
  const [report, setReport] = useState<MigrateRunReport | undefined>()
  const navigate = useNavigate()

  const isRunning = run.isPending
  const isDone = Boolean(report)
  const failed = report?.summary.failed ?? 0
  const migrated = report?.summary.migrated ?? 0
  const archived = report?.summary.archived ?? 0
  const isSuccess = isDone && failed === 0
  const isPartialFailure = isDone && failed > 0

  const handleMigrate = async () => {
    try {
      const response = await run.mutateAsync()
      setReport(response.report)
      if (response.report.summary.failed === 0) {
        toast.success(`Migrated ${response.report.summary.migrated} topics to HTML`)
      }
    } catch (error) {
      toast.error(formatError(error, 'Migration failed'))
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (next) return
    if (isRunning) return
    if (isDone) onClose()
    else onDismiss()
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="w-full max-w-md">
        {!isDone && (
          <>
            <DialogHeader>
              <DialogTitle>Migrate context tree to HTML</DialogTitle>
              <DialogDescription>
                ByteRover 4.0 stores topics as <code className="bg-muted rounded px-1 py-0.5 text-xs">{'<bv-topic>'}</code>{' '}
                HTML. Your context tree still has Markdown topics.
              </DialogDescription>
            </DialogHeader>

            <dl className="divide-border divide-y text-sm">
              <div className="flex items-baseline justify-between gap-4 pb-2">
                <dt className="text-muted-foreground">Markdown topics</dt>
                <dd className="font-mono tabular-nums">{migratedCount}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-muted-foreground">Location</dt>
                <dd className="font-mono text-xs">.brv/context-tree/</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 pt-2">
                <dt className="text-muted-foreground">Reversible</dt>
                <dd className="font-mono text-xs">brv migrate --rollback</dd>
              </div>
            </dl>

            {isRunning ? (
              <p className="border-muted-foreground/40 text-muted-foreground border-l-2 pl-2.5 text-xs">
                Converting topics… please don&apos;t close this tab.
              </p>
            ) : (
              <p className="text-muted-foreground border-l-2 border-amber-500 pl-2.5 text-xs">
                Don&apos;t run while <code className="bg-muted rounded px-1 py-0.5 text-[11px]">brv curate</code> or{' '}
                <code className="bg-muted rounded px-1 py-0.5 text-[11px]">brv dream</code> is active.
              </p>
            )}

            <DialogFooter>
              <Button disabled={isRunning} onClick={onDismiss} variant="ghost">
                Not now
              </Button>
              <Button disabled={isRunning} onClick={handleMigrate}>
                {isRunning ? 'Migrating…' : 'Migrate now'}
              </Button>
            </DialogFooter>
          </>
        )}

        {isSuccess && report && (
          <>
            <DialogHeader>
              <DialogTitle>Migration complete</DialogTitle>
              <DialogDescription>Your context tree is now stored as HTML topics.</DialogDescription>
            </DialogHeader>

            <dl className="divide-border divide-y text-sm">
              <div className="flex items-baseline justify-between gap-4 pb-2">
                <dt className="text-muted-foreground">Migrated</dt>
                <dd className="font-mono tabular-nums">{migrated}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-muted-foreground">Archived</dt>
                <dd className="font-mono tabular-nums">{archived}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 pt-2">
                <dt className="text-muted-foreground">Failed</dt>
                <dd className="font-mono tabular-nums">0</dd>
              </div>
            </dl>

            <p className="text-muted-foreground text-xs">
              Review the new HTML topics in the Changes tab, then commit and push to sync with your team.
            </p>

            <DialogFooter>
              <Button onClick={onClose} variant="ghost">
                Done
              </Button>
              <Button
                onClick={() => {
                  onClose()
                  navigate('/changes')
                }}
              >
                Review changes
              </Button>
            </DialogFooter>
          </>
        )}

        {isPartialFailure && report && (
          <>
            <DialogHeader>
              <DialogTitle>Migration finished with errors</DialogTitle>
              <DialogDescription>Failed sources were archived — nothing was lost.</DialogDescription>
            </DialogHeader>

            <dl className="divide-border divide-y text-sm">
              <div className="flex items-baseline justify-between gap-4 pb-2">
                <dt className="text-muted-foreground">Migrated</dt>
                <dd className="font-mono tabular-nums">{migrated}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-muted-foreground">Archived</dt>
                <dd className="font-mono tabular-nums">{archived}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 pt-2">
                <dt className="text-muted-foreground">Failed</dt>
                <dd className="text-destructive font-mono tabular-nums">{failed}</dd>
              </div>
            </dl>

            <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
              {report.files
                .filter((f) => f.outcome === 'failed')
                .slice(0, 20)
                .map((f) => (
                  <li className="text-muted-foreground" key={f.sourceRelPath}>
                    <span className="text-destructive">✗</span> <code>{f.sourceRelPath}</code>
                    {f.reason ? <span> — {f.reason}</span> : null}
                  </li>
                ))}
            </ul>

            <p className="text-muted-foreground text-xs">
              Roll back with <code className="bg-muted rounded px-1 py-0.5">brv migrate --rollback</code>
            </p>

            <DialogFooter>
              <Button onClick={onClose} variant="ghost">
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
