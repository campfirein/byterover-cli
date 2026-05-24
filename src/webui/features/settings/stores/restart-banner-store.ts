import {create} from 'zustand'

interface RestartBannerState {
  clear: () => void
  dirtyKeys: ReadonlySet<string>
  markDirty: (key: string) => void
}

export const useRestartBannerStore = create<RestartBannerState>((set) => ({
  clear: () => set({dirtyKeys: new Set<string>()}),
  dirtyKeys: new Set<string>(),
  markDirty: (key) =>
    set((state) => {
      if (state.dirtyKeys.has(key)) return state
      const next = new Set(state.dirtyKeys)
      next.add(key)
      return {dirtyKeys: next}
    }),
}))
