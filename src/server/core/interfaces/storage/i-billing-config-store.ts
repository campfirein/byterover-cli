export interface IBillingConfigStore {
  getPinnedTeamId: () => Promise<string | undefined>
  setPinnedTeamId: (teamId: string | undefined) => Promise<void>
}
