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
import {DisclosureDetails} from './disclosure-details'

type Props = {
  isPending: boolean
  onConfirm: () => Promise<void>
  onOpenChange: (open: boolean) => void
  open: boolean
}

export function EnableConfirmDialog({isPending, onConfirm, onOpenChange, open}: Props) {
  function fire() {
    onConfirm().catch(noop)
  }

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Share usage analytics with Byterover?</AlertDialogTitle>
          <AlertDialogDescription>
            Review what is collected before enabling. You can turn this off at any time.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="py-2">
          <DisclosureDetails />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button disabled={isPending} onClick={fire}>
            {isPending ? 'Enabling…' : 'Enable analytics'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
