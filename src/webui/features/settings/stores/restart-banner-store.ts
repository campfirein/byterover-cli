import {create} from 'zustand'

interface RestartBannerState {
  clear: () => void
  dirtyKeys: ReadonlySet<string>
  markDirty: (key: string, restartRequired: boolean) => void
}

export const useRestartBannerStore = create<RestartBannerState>((set) => ({
  clear: () => set({dirtyKeys: new Set<string>()}),
  dirtyKeys: new Set<string>(),
  markDirty: (key, restartRequired) =>
    set((state) => {
      if (!restartRequired) return state
      if (state.dirtyKeys.has(key)) return state
      const next = new Set(state.dirtyKeys)
      next.add(key)
      return {dirtyKeys: next}
    }),
}))
