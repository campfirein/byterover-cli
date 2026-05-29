/**
 * Cross-cutting settings key constants. The full registry of writable and
 * readonly-info descriptors lives at
 * `src/server/core/domain/entities/settings.ts` and may only be imported
 * from `server/` and `agent/` callers.
 *
 * This module re-exposes the subset of key names that other layers (TUI,
 * WebUI, oclif) need to refer to without crossing the `tui -> server`
 * import boundary. Each constant is the literal wire key — a rename here
 * is a typecheck error at every consuming site.
 */

export const ANALYTICS_ENABLED_KEY = 'analytics.enabled' as const
