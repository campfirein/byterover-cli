import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@campfirein/byterover-packages/components/alert-dialog'
import {Button} from '@campfirein/byterover-packages/components/button'
import {toast} from 'sonner'

import type {ChangeFile} from '../types'

import {formatError} from '../../../lib/error-messages'
import {useVcDiscard} from '../api/execute-vc-discard'

type DiscardChangesDialogProps = {
  files: ChangeFile[]
  onOpenChange: (open: boolean) => void
  open: boolean
}

export function DiscardChangesDialog({files, onOpenChange, open}: DiscardChangesDialogProps) {
  const discard = useVcDiscard()

  const handleConfirm = async () => {
    try {
      await discard.mutateAsync({filePaths: files.map((f) => f.path)})
      toast.success(files.length === 1 ? `Discarded changes in ${files[0].path}` : `Discarded changes in ${files.length} files`)
      onOpenChange(false)
    } catch (error) {
      toast.error(formatError(error, 'Failed to discard changes'))
    }
  }

  const isSingle = files.length === 1

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{isSingle ? 'Discard changes?' : `Discard changes in ${files.length} files?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {isSingle ? (
              <>
                Unstaged changes in{' '}
                <code className="bg-muted rounded px-1.5 py-0.5 text-sm break-all">{files[0].path}</code> will be lost
                and cannot be restored.
              </>
            ) : (
              'Unstaged changes in the selected files will be lost and cannot be restored.'
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button disabled={discard.isPending} onClick={handleConfirm} variant="destructive">
            {discard.isPending ? 'Discarding…' : 'Discard changes'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
