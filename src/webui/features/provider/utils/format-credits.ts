/**
 * Formats a credit count for the compact provider-trigger pill.
 *
 *   42 -> "42"
 *   12_400 -> "12.4k"
 *   50_000 -> "50k"
 *   2_500_000 -> "2.5m"
 *
 * One decimal of precision so a tightly budgeted user can still distinguish
 * 12.4k from 12.9k at a glance.
 */
export function formatCredits(value: number): string {
  if (value <= 0) return '0'
  if (value < 1000) return String(value)
  // Promote to millions once the value would round up to 1.0m, so 999_999
  // renders as "1m" instead of "1000k".
  if (value >= 999_500) return stripTrailingZero((value / 1_000_000).toFixed(1)) + 'm'
  return stripTrailingZero((value / 1000).toFixed(1)) + 'k'
}

function stripTrailingZero(numeric: string): string {
  return numeric.endsWith('.0') ? numeric.slice(0, -2) : numeric
}
