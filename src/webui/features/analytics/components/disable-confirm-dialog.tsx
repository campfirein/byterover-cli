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

import {noop} from '../../../lib/noop'

type Props = {
  isPending: boolean
  onConfirm: () => Promise<void>
  onOpenChange: (open: boolean) => void
  open: boolean
}

export function DisableConfirmDialog({isPending, onConfirm, onOpenChange, open}: Props) {
  function fire() {
    onConfirm().catch(noop)
  }

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop sharing usage analytics?</AlertDialogTitle>
          <AlertDialogDescription>You can re-enable this at any time from this page.</AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button disabled={isPending} onClick={fire} variant="destructive">
            {isPending ? 'Disabling…' : 'Disable analytics'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
