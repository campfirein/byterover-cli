import {create} from 'zustand'

type MigrationDialogState = {
  forceOpen: boolean
  setForceOpen: (open: boolean) => void
}

export const useMigrationDialogStore = create<MigrationDialogState>((set) => ({
  forceOpen: false,
  setForceOpen: (open) => set({forceOpen: open}),
}))
