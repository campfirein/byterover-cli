 
// Wire fields mirror IMPLEMENTATION_PHASE_9_CLOUD_BRIDGE.md §5.4 +
// §9 (Parley delegation).

/**
 * Phase 9 / Slice 9.9 — delegate policy gate.
 *
 * The Parley v1 envelope carries a `protocol: 'query' | 'delegate'`
 * field. `query` envelopes are read-only Q&A (no write-class tool
 * calls on Bob's side, no permission requests); `delegate`
 * envelopes authorise Bob's agent to issue tool calls that may
 * mutate Bob's tree.
 *
 * The policy gate this slice ships:
 *   1. The envelope discriminator helper that callers should use
 *      INSTEAD of inspecting `envelope.protocol` directly. This
 *      future-proofs the call site when the protocol enum widens
 *      (e.g. `task` in slice 9.12).
 *   2. The `delegate_policy` config consultation: `'auto'` accepts
 *      every delegate envelope; `'prompt'` is the default (the
 *      operator must explicitly approve, surfaced via the
 *      operator-facing CLI/TUI prompt UI — out of scope here);
 *      `'deny'` rejects every delegate envelope at the parley
 *      handshake.
 *   3. A pure `policyPermitsDelegation(policy, mode)` function so
 *      `parley-server.ts` can short-circuit a delegate envelope at
 *      step 7 (alongside the accept_modes gate) when the policy
 *      forbids it.
 *
 * What's NOT in this slice (deferred to operator integration):
 *   - The `/brv/parley/delegate/v1` protocol handler (separate from
 *     `/brv/parley/query/v1`). Today `parley-server.ts` accepts
 *     query-only.
 *   - The cross-bridge permission flow (Bob's agent issues
 *     `permission_request` → frame routed to Alice → Alice's
 *     prompt → signed `permission_response_intent` → routed back
 *     → Bob's broker resolves).
 *   - The interactive prompt UI when `delegate_policy: 'prompt'`.
 *   - The `--delegate` CLI flag on `brv channel mention`.
 *
 * Threat-model context (§9 P5 confused-deputy): even with
 * `delegate_policy: 'auto'`, Bob's local permission broker is the
 * AUTHORITATIVE decision-maker. Alice's signed
 * `permission_response_intent` is INPUT to Bob's decision, never
 * the decision itself.
 */

export type DelegatePolicy = 'auto' | 'deny' | 'prompt'
export type ParleyProtocolMode = 'delegate' | 'query'

export type DelegationDecision =
  | {accepted: false; reason: DelegationRejectReason}
  | {
      accepted: true
      /**
       * kimi round-1 LOW — carry the envelope's `turn_id` (or
       * caller-supplied identifier) so the future interactive
       * prompt UI can match the operator's decision back to the
       * in-flight envelope without breaking the interface.
       * Populated by the parley-server at the call site from
       * `envelope.turn_id`. Undefined when callers haven't supplied
       * one (most unit-test paths).
       */
      correlationId?: string
      requiresInteractiveApproval: boolean
    }

export type DelegationRejectReason =
  | 'DELEGATE_POLICY_DENY'

export interface PolicyPermitsDelegationArgs {
  readonly correlationId?: string
  readonly mode: ParleyProtocolMode
  readonly policy: DelegatePolicy
}

export function policyPermitsDelegation(args: PolicyPermitsDelegationArgs): DelegationDecision {
  // Query envelopes never trigger the delegate policy — they're the
  // read-only path. Return immediately without consulting the policy
  // so a `delegate_policy: 'deny'` install still accepts queries.
  if (args.mode === 'query') {
    return {
      accepted: true,
      requiresInteractiveApproval: false,
      ...(args.correlationId === undefined ? {} : {correlationId: args.correlationId}),
    }
  }

  switch (args.policy) {
    case 'auto': {
      return {
        accepted: true,
        requiresInteractiveApproval: false,
        ...(args.correlationId === undefined ? {} : {correlationId: args.correlationId}),
      }
    }

    case 'deny': {
      return {accepted: false, reason: 'DELEGATE_POLICY_DENY'}
    }

    case 'prompt': {
      // Accepted at the handshake layer, but the parley-server caller
      // MUST defer to the interactive prompt UI (out of scope for
      // this slice) before letting Bob's agent issue any
      // mutating tool call. The flag surfaces the requirement to the
      // caller without baking the prompt UI into a pure function.
      return {
        accepted: true,
        requiresInteractiveApproval: true,
        ...(args.correlationId === undefined ? {} : {correlationId: args.correlationId}),
      }
    }
  }
}
