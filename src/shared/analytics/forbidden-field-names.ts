import type {StoredAnalyticsRecord} from './stored-record.js'

/**
 * Field names that MUST NOT appear inside an analytics event's `properties`
 * record. Originally extracted from the M2.8 privacy fixture
 * (test/unit/shared/analytics/privacy-fixture.test.ts) which uses this set
 * to assert that no per-event Zod schema declares any of these keys.
 *
 * M11.2 promotes the list to a runtime constant so the daemon's
 * analytics-list-handler can apply defense-in-depth redaction on read.
 *
 * Categories: secrets/credentials, PII identifiers, filesystem paths,
 * user content, error fields that may carry paths/secrets, network
 * identifiers.
 */
export const FORBIDDEN_FIELD_NAMES: ReadonlySet<string> = new Set([
  // Secrets / credentials
  'access_token',
  // PII identifiers
  'address',
  'api_key',
  // Filesystem paths
  'argv',
  'auth_header',
  'auth_token',
  // User content
  'content',
  'cookie',
  'credential',
  'cwd',
  'display_name',
  'email',
  // Errors that may carry paths/secrets/content
  'error_message',
  'file_path',
  'first_name',
  'folder_path',
  'goal',
  'home_dir',
  // Network identifiers
  'hostname',
  'ip',
  'last_name',
  'mac',
  'output',
  'password',
  'path',
  'phone',
  'phone_number',
  'project_path',
  'prompt',
  'query',
  'result',
  'secret',
  'session_id',
  'session_token',
  'ssn',
  'stack',
  'token',
  'username',
  'worktree_root',
])

/**
 * Defense-in-depth redaction for `record.properties`. Drops any top-level
 * key whose name appears on `FORBIDDEN_FIELD_NAMES`; preserves all other
 * keys verbatim.
 *
 * `record.identity` is INTENTIONALLY left untouched. The identity block
 * (`device_id`, `email`, `name`, `user_id`) is the always-stamped
 * super-property — `email` there is a legit identifier for the local
 * user, not a content leak. The forbidden list applies only to
 * event-specific property schemas, not to the identity envelope.
 *
 * Returns a fresh shallow clone — the caller can mutate the result
 * without affecting the input. Only top-level `properties` keys are
 * inspected; nested objects are passed through untouched (the M2.8
 * schema layer is responsible for preventing nested forbidden names
 * from ever being declared).
 */
export function redactRecord(record: StoredAnalyticsRecord): StoredAnalyticsRecord {
  const safeProperties: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record.properties)) {
    if (FORBIDDEN_FIELD_NAMES.has(key)) continue
    safeProperties[key] = value
  }

  return {...record, properties: safeProperties}
}
