// Phase 10 Slice 10.4 — Stake annotation + size matrix.
//
// Stake grades the dispatch by how much human/agent compute the caller wants
// to spend. `low` is single-agent (fast, cheap, possibly noisy); `critical`
// is 3 local + 2 remote (slow, expensive, highest-confidence). Defaults
// favour the common case: `medium` (2 local, 0 remote) is what the
// dispatcher uses when the caller doesn't pass `--stake`.
//
// The matrix is env-overridable per cell, so operators can re-tune sizing
// without code changes:
//
//   BRV_QUORUM_STAKE_LOW_LOCAL=2
//   BRV_QUORUM_STAKE_CRITICAL_REMOTE=4
//
// Local + remote counts are independent — `low` may have 0 remote because
// you don't pay remote latency on a one-shot dispatch, but `critical`'s
// remote count is the diversity lever for adversarial review (codex Q6 —
// remote dispatch escalates when local consensus is weak).

export type Stake = 'critical' | 'high' | 'low' | 'medium'

export const STAKE_VALUES: ReadonlyArray<Stake> = ['low', 'medium', 'high', 'critical']

export type StakeGroupSize = {
  readonly local: number
  readonly remote: number
}

export const DEFAULT_STAKE: Stake = 'medium'

const DEFAULT_STAKE_GROUP_SIZE: Record<Stake, StakeGroupSize> = {
  critical: {local: 3, remote: 2},
  high: {local: 2, remote: 1},
  low: {local: 1, remote: 0},
  medium: {local: 2, remote: 0},
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n) || n < 0) return undefined
  return n
}

export function resolveStakeGroupSize(
  stake: Stake,
  env: Record<string, string | undefined> = process.env,
): StakeGroupSize {
  const stakeUpper = stake.toUpperCase()
  const defaults = DEFAULT_STAKE_GROUP_SIZE[stake]
  return {
    local: parsePositiveInt(env[`BRV_QUORUM_STAKE_${stakeUpper}_LOCAL`]) ?? defaults.local,
    remote: parsePositiveInt(env[`BRV_QUORUM_STAKE_${stakeUpper}_REMOTE`]) ?? defaults.remote,
  }
}

export function resolveStakeMatrix(
  env: Record<string, string | undefined> = process.env,
): Record<Stake, StakeGroupSize> {
  return {
    critical: resolveStakeGroupSize('critical', env),
    high: resolveStakeGroupSize('high', env),
    low: resolveStakeGroupSize('low', env),
    medium: resolveStakeGroupSize('medium', env),
  }
}

export function isStake(value: string): value is Stake {
  return STAKE_VALUES.includes(value as Stake)
}
