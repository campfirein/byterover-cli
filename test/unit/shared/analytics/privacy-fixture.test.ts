 
import {expect} from 'chai'
import {z} from 'zod'

import {ALL_EVENT_SCHEMAS} from '../../../../src/shared/analytics/events/index.js'
import {FORBIDDEN_FIELD_NAMES} from '../../../../src/shared/analytics/forbidden-field-names.js'

// Sentinel — the test below asserts the imported set still contains the canonical
// names this fixture audits against. Any drift between this fixture and the runtime
// constant would indicate the M11.2 extraction broke privacy coverage.
const FIXTURE_SENTINEL_NAMES: ReadonlySet<string> = new Set([
  // Secrets / credentials
  'access_token',
  // PII identifiers (super-properties carry email/name when authenticated;
  // event payloads must NEVER repeat them)
  'address',
  'api_key',
  // Filesystem paths (M1 spec: "no file paths")
  'argv',
  'auth_header',
  'auth_token',
  // User content (M1 spec: "no content of queries, files, or memory")
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
 * Recursively collect every field name reachable from a Zod schema, including
 * fields inside nested ZodObject, ZodOptional / ZodNullable wrappers,
 * ZodArray element schemas, and ZodUnion / ZodDiscriminatedUnion members.
 * The privacy fixture must audit nested shapes because adding
 * `{error: {message, code}}` should surface `message` as a forbidden name
 * even though the top level only declares `error`.
 *
 * Discriminated unions (used by `migrate_run` to enforce per-mode counter
 * separation) must be walked across every member or a forbidden field
 * declared only on the rollback variant would slip past audit.
 */
function getShapeFieldNames(schema: z.ZodTypeAny, seen: Set<z.ZodTypeAny> = new Set()): string[] {
  if (seen.has(schema)) return []
  seen.add(schema)

  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return getShapeFieldNames(schema.unwrap() as z.ZodTypeAny, seen)
  }

  if (schema instanceof z.ZodArray) {
    return getShapeFieldNames(schema.element as z.ZodTypeAny, seen)
  }

  if (schema instanceof z.ZodObject) {
    const out: string[] = []
    for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
      out.push(key, ...getShapeFieldNames(value, seen))
    }

    return out
  }

  if (schema instanceof z.ZodDiscriminatedUnion || schema instanceof z.ZodUnion) {
    const out: string[] = []
    for (const option of schema.options as z.ZodTypeAny[]) {
      out.push(...getShapeFieldNames(option, seen))
    }

    return out
  }

  return []
}

describe('analytics privacy fixture (smoke)', () => {
  it('should keep the runtime FORBIDDEN_FIELD_NAMES set as a superset of this fixture sentinel', () => {
    // Regression guard for the M11.2 extraction: any name this fixture historically
    // audited against MUST still be present in the runtime constant.
    const missing: string[] = []
    for (const name of FIXTURE_SENTINEL_NAMES) {
      if (!FORBIDDEN_FIELD_NAMES.has(name)) missing.push(name)
    }

    expect(missing, `runtime FORBIDDEN_FIELD_NAMES dropped: ${missing.join(', ')}`).to.deep.equal([])
  })

  it('should not declare any field name on the forbidden PII list across all event schemas', () => {
    const violations: Array<{eventName: string; field: string}> = []

    for (const [eventName, schema] of Object.entries(ALL_EVENT_SCHEMAS)) {
      for (const field of getShapeFieldNames(schema)) {
        if (FORBIDDEN_FIELD_NAMES.has(field)) {
          violations.push({eventName, field})
        }
      }
    }

    expect(violations, `forbidden PII fields detected: ${JSON.stringify(violations)}`).to.deep.equal([])
  })

  it('should expose every shipped event name under ALL_EVENT_SCHEMAS', () => {
    expect(Object.keys(ALL_EVENT_SCHEMAS).sort()).to.deep.equal([
      'analytics_disabled',
      'auth_login',
      'auth_logout',
      'brv_init',
      'cli_invocation',
      'connector_installed',
      'content_migrated',
      'context_tree_file_edited',
      'curate_operation_applied',
      'curate_run_completed',
      'daemon_reset_executed',
      'daemon_start',
      'hub_package_installed',
      'hub_registry_added',
      'hub_registry_removed',
      'mcp_session_ended',
      'mcp_session_start',
      'mcp_tool_called',
      'migrate_run',
      'onboarding_auto_setup_started',
      'onboarding_completed',
      'query_completed',
      'review_approved',
      'review_rejected',
      'review_toggled',
      'setting_changed',
      'setting_reset',
      'source_added',
      'source_removed',
      'space_switched',
      'task_completed',
      'task_created',
      'task_failed',
      'vc_branched',
      'vc_checked_out',
      'vc_cloned',
      'vc_commit',
      'vc_discarded',
      'vc_fetched',
      'vc_init',
      'vc_merged',
      'vc_pulled',
      'vc_pushed',
      'vc_remote_changed',
      'vc_reset_executed',
      'webui_session_ended',
      'webui_session_started',
      'worktree_added',
      'worktree_removed',
    ])
  })

  describe('walker coverage (regression guard)', () => {
    it('should catch a forbidden field name nested inside a ZodObject', () => {
      // Synthetic bad schema. If the walker stays at top-level, `email` is missed.
      const nestedBad = z.object({
        outer: z.object({
          email: z.string(),
        }),
      })
      const fields = getShapeFieldNames(nestedBad)
      expect(fields).to.include('email')
    })

    it('should catch a forbidden field name inside ZodArray element', () => {
      const arrayBad = z.object({
        items: z.array(z.object({password: z.string()})),
      })
      const fields = getShapeFieldNames(arrayBad)
      expect(fields).to.include('password')
    })

    it('should unwrap ZodOptional and ZodNullable when walking', () => {
      const optionalBad = z.object({
        wrapper: z.object({token: z.string()}).optional(),
      })
      const nullableBad = z.object({
        // eslint-disable-next-line camelcase
        wrapper: z.object({api_key: z.string()}).nullable(),
      })
      expect(getShapeFieldNames(optionalBad)).to.include('token')
      expect(getShapeFieldNames(nullableBad)).to.include('api_key')
    })

    it('should walk every member of a ZodDiscriminatedUnion', () => {
      // Forbidden names live on different variants — the walker MUST visit
      // both, or migrate_run-style discriminated schemas would let a PII
      // field declared only on one variant slip past privacy audit.
      const unionBad = z.discriminatedUnion('kind', [
        z.object({email: z.string(), kind: z.literal('a')}),
        // eslint-disable-next-line camelcase
        z.object({api_key: z.string(), kind: z.literal('b')}),
      ])
      const fields = getShapeFieldNames(unionBad)
      expect(fields).to.include('email')
      expect(fields).to.include('api_key')
    })

    it('should walk every option of a plain ZodUnion', () => {
      const unionBad = z.union([
        z.object({password: z.string()}),
        z.object({token: z.string()}),
      ])
      const fields = getShapeFieldNames(unionBad)
      expect(fields).to.include('password')
      expect(fields).to.include('token')
    })
  })
})
