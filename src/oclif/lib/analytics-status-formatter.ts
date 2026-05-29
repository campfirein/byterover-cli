/**
 * Stable named re-exports of the analytics-status text and JSON
 * formatters, satisfying the ticket AC that they be importable from
 * `src/oclif/lib/`. The canonical home is `src/shared/utils/` because
 * the TUI also consumes the same renderer and cannot import from
 * `src/oclif/` per the architecture import boundary.
 */
export {
  formatAnalyticsStatusJson,
  formatAnalyticsStatusText,
  formatDelayMs,
  formatRelativeAgo,
} from '../../shared/utils/format-analytics-status.js'
